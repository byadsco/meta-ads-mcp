import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateMetaId } from "../utils/format.js";
import { normalizeUrlTags } from "../utils/validation.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import { planContentEdit, type ContentChanges, type ContentPlan } from "../meta/ad-content.js";
import {
  createReplacementCreative,
  errorMessage,
  groupAdsByCreative,
  readCreativeForRebuild,
  repointGroup,
  type CreativeGroup,
  type FailedAd,
  type UpdatedAd,
} from "../meta/creative-rebuild.js";
import { readEngagement, type Engagement } from "../meta/post-engagement.js";
import type { AdCreative } from "../meta/types/index.js";
import { ctaEnum } from "./creatives.js";
import { UPDATE, WRITE_WARNING } from "./_register.js";

const textChange = (label: string) =>
  z
    .object({
      set: z.array(z.string()).min(1).max(5).optional().describe(`Replace every ${label} with these`),
      add: z.array(z.string()).min(1).max(5).optional().describe(`${label}s to add`),
      remove: z.array(z.string()).min(1).max(5).optional().describe(`${label}s to remove, by exact text`),
    })
    .optional()
    .describe(`Changes to the ${label}s: set replaces all, then remove, then add. At most 5 remain.`);

interface GroupReport {
  creative_id: string;
  ad_ids: string[];
  route?: ContentPlan["route"];
  before: ContentPlan["before"];
  after: ContentPlan["after"];
  social_proof?: ContentPlan["social_proof"];
  engagement?: Engagement;
  reason?: string;
  warnings: string[];
}

export function registerAdContentTools(server: McpServer): void {
  server.registerTool(
    "ads_update_ad_content",
    {
      description: `${WRITE_WARNING}Change the copy, link, button or media of live ads: add, remove or replace primary texts, headlines and descriptions, including removing one option of several. Meta creatives are immutable, so each ad gets a replacement creative and goes back through review; the ad keeps its ID, history and previous creative (point it back with ads_update_ad to undo, which brings its post back too). Likes, comments and shares live on the ad's post. When only primary texts change and at least two remain, the ad keeps its Facebook post and that engagement (its Instagram side starts over and the Facebook headline stays the post's own). Anything else creates a new post, which resets the visible engagement, and only happens with allow_new_post: true. dry_run defaults to true: the first call shows, per creative, the copy before and after, the route and the engagement at stake, without changing anything. Show that to the person and call again with dry_run: false once they agree. Carousels, dynamic creative and other asset feeds are not supported.`,
      inputSchema: {
        ad_ids: z.array(z.string()).min(1).max(50).describe("Ad IDs to change (1-50). Ads sharing a creative get one replacement."),
        primary_texts: textChange("primary text"),
        headlines: textChange("headline"),
        descriptions: textChange("description"),
        link_url: z.string().optional().describe("New destination URL"),
        call_to_action_type: ctaEnum.optional().describe("New button type"),
        image_hash: z.string().optional().describe("New image (from ads_upload_ad_image), or a video's new thumbnail"),
        image_url: z.string().optional().describe("New image URL, or a video's new thumbnail"),
        video_id: z.string().optional().describe("New video for a video ad"),
        url_tags: z.string().optional().describe("New UTM query string, applied with the other changes. A leading '?' is stripped."),
        allow_new_post: z
          .boolean()
          .default(false)
          .describe("Allow changes that need a new post. Its likes, comments and shares start from zero."),
        dry_run: z
          .boolean()
          .default(true)
          .describe("Preview only (default). Set false to apply after the person agrees."),
      },
      annotations: { ...UPDATE },
    },
    async ({
      ad_ids, primary_texts, headlines, descriptions, link_url, call_to_action_type,
      image_hash, image_url, video_id, url_tags, allow_new_post, dry_run,
    }) => {
      const preview = dry_run !== false;
      const changes: ContentChanges = {
        primary_texts, headlines, descriptions, link_url, call_to_action_type,
        image_hash, image_url,
        video_id: video_id === undefined ? undefined : validateMetaId(video_id, "video"),
        url_tags: url_tags === undefined ? undefined : normalizeUrlTags(url_tags),
      };
      if (image_url && !image_hash) {
        try {
          await assertSafePublicUrl(image_url);
        } catch (err) {
          if (err instanceof UnsafeUrlError) throw new Error(`Refusing to forward image_url to Meta: ${err.message}`);
          throw err;
        }
      }

      const { groups, failed } = await groupAdsByCreative(ad_ids);
      const reports: GroupReport[] = [];
      const actionable: Array<{ group: CreativeGroup; creative: AdCreative; body: Record<string, string> }> = [];
      const planningErrors: string[] = [];

      for (const group of groups) {
        let creative: AdCreative;
        try {
          creative = await readCreativeForRebuild(group.creative_id, ["body", "title"]);
        } catch (err) {
          for (const adId of group.ad_ids) failed.push({ ad_id: adId, error: errorMessage(err) });
          continue;
        }
        let plan: ContentPlan;
        try {
          plan = planContentEdit(creative, changes, allow_new_post === true);
        } catch (err) {
          planningErrors.push(`Creative ${group.creative_id} (ads ${group.ad_ids.join(", ")}): ${errorMessage(err)}`);
          continue;
        }
        const report: GroupReport = {
          creative_id: group.creative_id,
          ad_ids: group.ad_ids,
          route: plan.route,
          before: plan.before,
          after: plan.after,
          social_proof: plan.social_proof,
          reason: plan.reason,
          warnings: plan.warnings,
        };
        if (preview && plan.route) {
          report.engagement = await readEngagement(creative.effective_object_story_id, creative.effective_instagram_media_id);
        }
        reports.push(report);
        if (plan.route && plan.body) actionable.push({ group, creative, body: plan.body });
      }

      const updated: UpdatedAd[] = [];
      const warnings: string[] = [];
      const aborted = !preview && planningErrors.length > 0;
      if (!preview && !aborted) {
        for (const { group, body } of actionable) {
          let newCreativeId: string;
          try {
            newCreativeId = await createReplacementCreative(group.account_id, body);
          } catch (err) {
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${errorMessage(err)}` });
            }
            continue;
          }
          const outcome = await repointGroup(group, newCreativeId);
          updated.push(...outcome.updated);
          failed.push(...outcome.failed);
          warnings.push(...outcome.warnings);
        }
      }

      return {
        content: [
          { type: "text", text: summarize(reports, planningErrors, updated, failed, preview, aborted) },
          {
            type: "text",
            text: JSON.stringify({ dry_run: preview, aborted, plans: reports, planning_errors: planningErrors, updated, failed, warnings }, null, 2),
          },
        ],
      };
    },
  );
}

function describeEngagement(engagement: Engagement | undefined): string {
  if (!engagement) return "";
  const parts: string[] = [];
  if (engagement.facebook) {
    parts.push(`Facebook ${engagement.facebook.reactions} reactions, ${engagement.facebook.comments} comments, ${engagement.facebook.shares} shares`);
  }
  if (engagement.instagram) {
    parts.push(`Instagram ${engagement.instagram.likes} likes, ${engagement.instagram.comments} comments`);
  }
  return parts.length > 0 ? ` Engagement now: ${parts.join("; ")}.` : "";
}

function summarize(
  reports: GroupReport[],
  planningErrors: string[],
  updated: UpdatedAd[],
  failed: FailedAd[],
  preview: boolean,
  aborted: boolean,
): string {
  const lines: string[] = [];
  if (aborted) lines.push("Nothing was changed: fix the problems below and run again.");
  else if (preview) lines.push("Dry run — nothing was changed. Show this to the person before applying it with dry_run: false.");
  else lines.push(`Updated ${updated.length} ad(s), failed ${failed.length}.`);

  for (const report of reports) {
    const ads = report.ad_ids.join(", ");
    if (!report.route) {
      lines.push(`• Ads ${ads}: not changed — ${report.reason}`);
      continue;
    }
    const proof = report.social_proof?.facebook === "kept"
      ? "keeps its Facebook post and that post's likes, comments and shares; Instagram starts over"
      : "gets a new post: likes, comments and shares start from zero";
    lines.push(`• Ads ${ads} (creative ${report.creative_id}): ${proof}.${describeEngagement(report.engagement)}`);
    lines.push(`  Primary texts: ${JSON.stringify(report.before.primary)} → ${JSON.stringify(report.after.primary)}`);
    lines.push(`  Headlines: ${JSON.stringify(report.before.headlines)} → ${JSON.stringify(report.after.headlines)}`);
    lines.push(`  Descriptions: ${JSON.stringify(report.before.descriptions)} → ${JSON.stringify(report.after.descriptions)}`);
    for (const warning of report.warnings) lines.push(`  ⚠️ ${warning}`);
  }
  if (planningErrors.length > 0) lines.push("", "Problems:", ...planningErrors.map((error) => `• ${error}`));
  if (failed.length > 0) lines.push("", "Failed:", ...failed.map((f) => `• Ad ${f.ad_id}: ${f.error}`));
  if (!preview && updated.length > 0) {
    lines.push("", "Updated ads go back through Meta review. To undo, point an ad at its previous creative with ads_update_ad:");
    for (const u of updated) lines.push(`• Ad ${u.ad_id}: previous creative ${u.old_creative_id}, new ${u.new_creative_id}`);
  }
  return lines.join("\n");
}
