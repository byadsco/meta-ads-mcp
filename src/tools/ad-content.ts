import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateMetaId } from "../utils/format.js";
import { normalizeUrlTags } from "../utils/validation.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import {
  PlanError,
  planContentEdit,
  type ContentChanges,
  type ContentPlan,
  type FieldChange,
  type PlanErrorCode,
} from "../meta/ad-content.js";
import {
  createReplacementCreative,
  deleteCreative,
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
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
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

// The JSON block carries these without their messages, which can quote ad
// copy; the messages appear only inside the fenced summary.
interface PlanningProblem {
  creative_id: string;
  ad_ids: string[];
  code: PlanErrorCode | "invalid_change";
  message: string;
}

type KindedFailure = FailedAd & { kind: "read_failed" | "create_failed" | "repoint_failed" | "changed_meanwhile" };

interface GroupReport {
  creative_id: string;
  ad_ids: string[];
  route?: ContentPlan["route"];
  before: ContentPlan["before"];
  after: ContentPlan["after"];
  social_proof?: ContentPlan["social_proof"];
  field_changes: FieldChange[];
  engagement?: Engagement;
  reason?: string;
  blocking: boolean;
  warnings: string[];
}

export function registerAdContentTools(server: McpServer): void {
  server.registerTool(
    "ads_update_ad_content",
    {
      description: `${WRITE_WARNING}Change the copy, link, button or media of live ads: add, remove or replace primary texts, headlines and descriptions, including removing one option of several. Meta creatives are immutable, so each ad gets a replacement creative and goes back through review; the ad keeps its ID, history and previous creative (point it back with ads_update_ad to undo, which brings its post back too). Likes, comments and shares live on the ad's post. When only primary texts change and at least two remain, the ad keeps its Facebook post and that engagement (its Instagram side starts over and the Facebook headline stays the post's own). Anything else creates a new post, which resets the visible engagement, and only happens with allow_new_post: true. dry_run defaults to true: the first call shows, per creative, the copy before and after, any link, button, media or url_tags change, the route and the engagement at stake, without changing anything. Show that to the person and call again with dry_run: false once they agree. Nothing changes if any ad cannot be read, has an invalid change or would need a route that is not allowed, or if any replacement creative cannot be created: all replacements are created before any ad is repointed. Right before each repoint the ad is read again; an ad someone moved to another creative meanwhile is left untouched. If Meta then refuses to repoint an ad, ads already repointed stay changed, and the response lists each one with its previous creative so it can be undone. Repeating a set, link, button or media change that is already applied does nothing; add and remove are not repeatable, so after a partial failure run again with only the ads that failed. An ad with per-platform media (platform_customizations) cannot have its image or video changed here. Carousels, dynamic creative and other asset feeds are not supported. Meta lets an ad change creative at most once every 30 seconds (error 613): wait before changing the same ad again.`,
      inputSchema: {
        ad_ids: z.array(z.string()).min(1).max(50).describe("Ad IDs to change (1-50). Ads sharing a creative get one replacement."),
        primary_texts: textChange("primary text"),
        headlines: textChange("headline"),
        descriptions: textChange("description"),
        link_url: z.string().optional().describe("New destination URL"),
        call_to_action_type: ctaEnum.optional().describe("New button type"),
        image_hash: z.string().optional().describe("New image (from ads_upload_ad_image), or a video's new thumbnail"),
        image_url: z.string().optional().describe("New image URL, or a video's new thumbnail. Ignored when image_hash is given."),
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

      const grouped = await groupAdsByCreative(ad_ids);
      const { groups } = grouped;
      const failed: KindedFailure[] = grouped.failed.map((f) => ({ ...f, kind: "read_failed" }));
      const reports: GroupReport[] = [];
      const actionable: Array<{ group: CreativeGroup; creative: AdCreative; body: Record<string, string> }> = [];
      const planningErrors: PlanningProblem[] = [];

      for (const group of groups) {
        let creative: AdCreative;
        try {
          creative = await readCreativeForRebuild(group.creative_id, ["body", "title"]);
        } catch (err) {
          for (const adId of group.ad_ids) failed.push({ ad_id: adId, error: errorMessage(err), kind: "read_failed" });
          continue;
        }
        let plan: ContentPlan;
        try {
          plan = planContentEdit(creative, changes, allow_new_post === true);
        } catch (err) {
          planningErrors.push({
            creative_id: group.creative_id,
            ad_ids: group.ad_ids,
            code: err instanceof PlanError ? err.code : "invalid_change",
            message: errorMessage(err),
          });
          continue;
        }
        const report: GroupReport = {
          creative_id: group.creative_id,
          ad_ids: group.ad_ids,
          route: plan.route,
          before: plan.before,
          after: plan.after,
          social_proof: plan.social_proof,
          field_changes: plan.field_changes ?? [],
          reason: plan.reason,
          blocking: plan.blocking === true,
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
      const unused: string[] = [];
      // Every ad has to be read and planned before anything is written, and
      // any ad left out (unreadable, invalid change, refused route) stops the
      // batch: a batch never half-applies on a plan.
      let aborted = !preview && (planningErrors.length > 0 || failed.length > 0 || reports.some((r) => r.blocking));
      if (!preview && !aborted) {
        // Two phases: every replacement creative first (it changes no ad), and
        // only when all of them exist, the repoints.
        const ready: Array<{ group: CreativeGroup; newCreativeId: string }> = [];
        for (const { group, body } of actionable) {
          try {
            ready.push({ group, newCreativeId: await createReplacementCreative(group.account_id, body) });
          } catch (err) {
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${errorMessage(err)}`, kind: "create_failed" });
            }
            aborted = true;
            break;
          }
        }
        if (aborted) {
          unused.push(...ready.map((r) => r.newCreativeId));
          for (const id of unused) await deleteCreative(id);
        } else {
          for (const { group, newCreativeId } of ready) {
            const outcome = await repointGroup(group, newCreativeId, { verifyUnchanged: true });
            updated.push(...outcome.updated);
            failed.push(...outcome.failed.map((f) => ({ ...f, kind: f.code === "changed_meanwhile" ? "changed_meanwhile" as const : "repoint_failed" as const })));
            warnings.push(...outcome.warnings);
          }
        }
      }

      // The copy stays out of the JSON: it is shown only in the fenced summary.
      const plans = reports.map(({ before, after, field_changes, ...rest }) => ({
        ...rest,
        changed_fields: field_changes.map((change) => change.field),
        text_option_counts: {
          before: { primary: before.primary.length, headlines: before.headlines.length, descriptions: before.descriptions.length },
          after: { primary: after.primary.length, headlines: after.headlines.length, descriptions: after.descriptions.length },
        },
      }));
      return {
        content: [
          { type: "text", text: summarize(reports, planningErrors, updated, failed, warnings, preview, aborted) },
          {
            type: "text",
            text: JSON.stringify({
              dry_run: preview,
              aborted,
              plans,
              planning_errors: planningErrors.map(({ message: _message, ...problem }) => problem),
              updated,
              failed: failed.map(({ error: _error, ...failure }) => failure),
              repoint_notes: warnings.length,
            }, null, 2),
          },
        ],
      };
    },
  );
}

// Ad copy is advertiser content: it is rendered one bounded line per option,
// inside the untrusted fence, never as framing.
function listCopy(texts: string[]): string {
  return texts.length === 0 ? "(none)" : texts.map((text) => `[${singleLine(text, 300)}]`).join(" ");
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
  planningErrors: PlanningProblem[],
  updated: UpdatedAd[],
  failed: FailedAd[],
  repointNotes: string[],
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
      lines.push(`• Ads ${ads}: not changed — ${singleLine(report.reason, 400)}`);
      continue;
    }
    const proof = report.social_proof?.facebook === "kept"
      ? "keeps its Facebook post and that post's likes, comments and shares; Instagram starts over"
      : "gets a new post: likes, comments and shares start from zero";
    lines.push(`• Ads ${ads} (creative ${report.creative_id}): ${proof}.${describeEngagement(report.engagement)}`);
    for (const warning of report.warnings) lines.push(`  ⚠️ ${warning}`);
    lines.push(ADVERTISER_CONTENT_OPEN);
    lines.push(`Primary texts before: ${listCopy(report.before.primary)}`);
    lines.push(`Primary texts after: ${listCopy(report.after.primary)}`);
    lines.push(`Headlines before: ${listCopy(report.before.headlines)}`);
    lines.push(`Headlines after: ${listCopy(report.after.headlines)}`);
    lines.push(`Descriptions before: ${listCopy(report.before.descriptions)}`);
    lines.push(`Descriptions after: ${listCopy(report.after.descriptions)}`);
    for (const change of report.field_changes) {
      lines.push(`${change.field}: ${singleLine(change.before, 300) || "(none)"} → ${singleLine(change.after, 300)}`);
    }
    lines.push(ADVERTISER_CONTENT_CLOSE);
  }
  // Problems and Meta's errors can quote ad copy, so they stay one bounded
  // line each, inside the fence.
  if (planningErrors.length > 0) {
    lines.push("", "Problems:", ADVERTISER_CONTENT_OPEN, ...planningErrors.map((p) => `• Creative ${p.creative_id} (ads ${p.ad_ids.join(", ")}): ${singleLine(p.message, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  if (repointNotes.length > 0) {
    lines.push("", "Notes:", ADVERTISER_CONTENT_OPEN, ...repointNotes.map((note) => `• ${singleLine(note, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  if (failed.length > 0) {
    lines.push("", "Failed:", ADVERTISER_CONTENT_OPEN, ...failed.map((f) => `• Ad ${f.ad_id}: ${singleLine(f.error, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  if (!preview && updated.length > 0) {
    lines.push("", "Updated ads go back through Meta review. To undo, point an ad at its previous creative with ads_update_ad:");
    for (const u of updated) lines.push(`• Ad ${u.ad_id}: previous creative ${u.old_creative_id}, new ${u.new_creative_id}`);
  }
  return lines.join("\n");
}
