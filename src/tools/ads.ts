import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam, normalizeUrlTags, requireOneOf } from "../utils/validation.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import type { Ad, AdCreative, MetaApiResponse } from "../meta/types/index.js";
import { buildAssetGroups } from "../meta/asset-feed.js";
import { MAX_HEADLINE_LENGTH } from "../meta/creative-spec.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";
import { ctaEnum } from "./creatives.js";
import {
  asRecord,
  carryOverFields,
  createReplacementCreative,
  errorMessage,
  groupAdsByCreative,
  hasFeedContent,
  readCreativeForRebuild,
  repointGroup,
  resolveInstagramUserId,
  withInstagramIdentity,
  type CreativeGroup,
  type UpdatedAd,
} from "../meta/creative-rebuild.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

type RebuildStrategy = "reuse_post" | "clone_spec" | "reuse_instagram_media" | "clone_feed";

interface PlannedRebuild {
  ad_id: string;
  old_creative_id: string;
  strategy: RebuildStrategy;
}

interface SkippedAd {
  ad_id: string;
  reason: string;
}

// Every strategy re-references the source wholesale (post, spec or Instagram
// media) rather than reconstructing its parts, because a creative's
// destination link and CTA are not always readable back — rebuilding them
// field by field could silently drop them. Reusing the post also keeps the
// ad's social proof (likes/comments). A creative with text options cannot
// reuse its post without freezing its headlines, so it is rebuilt from its
// spec and feed, which creates a new post: only on request.
function planRebuild(creative: AdCreative, allowNewPost: boolean): RebuildStrategy | { reason: string } {
  if (hasFeedContent(creative)) {
    if (!asRecord(creative.object_story_spec)) {
      return { reason: "creative has an asset_feed_spec but no object_story_spec to rebuild it with" };
    }
    if (!allowNewPost) {
      return {
        reason: "creative has several text options or assets (asset_feed_spec); rebuilding it creates a new post, which resets the likes, comments and shares people see. Pass allow_new_post: true to rebuild it anyway.",
      };
    }
    return "clone_feed";
  }
  if (creative.effective_object_story_id) return "reuse_post";
  if (asRecord(creative.object_story_spec)) return "clone_spec";
  if (creative.source_instagram_media_id || creative.effective_instagram_media_id) {
    return "reuse_instagram_media";
  }
  return { reason: "creative has no reusable post, object_story_spec or Instagram media to rebuild from" };
}

function describeStrategy(strategy: RebuildStrategy): string {
  if (strategy === "reuse_post") return "reusing the existing post";
  if (strategy === "reuse_instagram_media") return "reusing the Instagram post";
  if (strategy === "clone_feed") return "cloning the spec and its text options — new post, likes and comments reset";
  return "cloning the creative spec";
}

function buildReplacementCreativeBody(
  creative: AdCreative,
  strategy: RebuildStrategy,
  urlTags: string,
): { body: Record<string, string>; warnings: string[] } {
  const body: Record<string, string> = {};
  if (creative.name) body.name = creative.name;

  const instagramUserId = resolveInstagramUserId(creative);

  if (strategy === "reuse_post") {
    body.object_story_id = creative.effective_object_story_id as string;
    if (instagramUserId) body.instagram_user_id = instagramUserId;
  } else if (strategy === "reuse_instagram_media") {
    body.source_instagram_media_id =
      (creative.source_instagram_media_id ?? creative.effective_instagram_media_id) as string;
    if (instagramUserId) body.instagram_user_id = instagramUserId;
    // Unlike a page post, an Instagram-media creative stores its CTA on the
    // creative itself (see ads_create_ad_creative), so it has to be rebuilt or
    // the replacement loses the button. call_to_action_type is readable but
    // not creatable, so it travels inside call_to_action.
    if (creative.call_to_action_type) {
      body.call_to_action = JSON.stringify({
        type: creative.call_to_action_type,
        value: creative.link_url ? { link: creative.link_url } : undefined,
      });
    }
  } else {
    body.object_story_spec = JSON.stringify(withInstagramIdentity(asRecord(creative.object_story_spec) ?? {}, creative));
    if (strategy === "clone_feed") body.asset_feed_spec = JSON.stringify(creative.asset_feed_spec);
  }

  const carried = carryOverFields(creative);
  Object.assign(body, carried.body);
  if (urlTags !== "") body.url_tags = urlTags;

  return { body, warnings: carried.warnings };
}

export function registerAdTools(server: McpServer): void {
  // ─── Get Ads ─────────────────────────────────────────────────
  server.registerTool(
    "ads_get_ads",
    {
      description: "Get ads for an ad account. Filter by campaign, ad set, or status.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        ad_set_id: z.string().optional().describe("Filter by ad set ID"),
        status_filter: z.array(statusEnum).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, campaign_id, ad_set_id, status_filter }) => {
      let path: string;
      if (ad_set_id) {
        path = `/${validateMetaId(ad_set_id, "adset")}/ads`;
      } else if (campaign_id) {
        path = `/${validateMetaId(campaign_id, "campaign")}/ads`;
      } else {
        path = `/${normalizeAccountId(account_id)}/ads`;
      }

      const fieldsParam = buildFieldsParam(undefined, [...AD_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: status_filter },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<Ad>>(path, params);
      const ads = response.data ?? [];

      const text =
        ads.length === 0
          ? "No ads found."
          : ads
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Creative: ${a.creative?.id ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${ads.length} ad(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(ads, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Details ──────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_details",
    {
      description: "Get detailed information about a specific ad.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, fields }) => {
      const id = validateMetaId(ad_id, "ad");
      const fieldsParam = buildFieldsParam(fields, [...AD_DEFAULT_FIELDS, "bid_amount", "tracking_specs"]);
      const ad = await metaApiClient.get<Ad>(`/${id}`, { fields: fieldsParam });

      return {
        content: [
          {
            type: "text",
            text: `Ad: ${ad.name}\nID: ${ad.id}\nAd Set: ${ad.adset_id}\nCampaign: ${ad.campaign_id}\nStatus: ${ad.status} (effective: ${ad.effective_status})\nCreative ID: ${ad.creative?.id ?? "N/A"}\nCreated: ${ad.created_time}`,
          },
          { type: "text", text: JSON.stringify(ad, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_create_ad",
    {
      description: `${WRITE_WARNING}Create a new ad within an ad set using an existing creative. Ads are created in PAUSED status by default.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Ad name"),
        ad_set_id: z.string().describe("Ad set ID to place this ad in"),
        creative_id: z.string().describe("Creative ID to use for this ad"),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
        tracking_specs: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Tracking specifications"),
        conversion_domain: z.string().optional().describe("Domain where the ad's conversions happen, without scheme or path (e.g. example.com)"),
        ad_labels: z.array(z.string().min(1)).max(50).optional().describe("Labels to tag the ad with, by name; Meta creates any that do not exist"),
        flexible_format: z.object({
          groups: z.array(z.object({
            image_hashes: z.array(z.string().min(1)).max(10).default([]),
            video_ids: z.array(z.string()).max(10).default([]),
            primary_texts: z.array(z.string().min(1)).max(5).default([]),
            headlines: z.array(z.string().min(1).max(MAX_HEADLINE_LENGTH)).max(5).default([]),
            descriptions: z.array(z.string().min(1)).max(5).default([]),
            call_to_action: z.object({ type: ctaEnum, link: z.string() }).describe("The same button type in every group"),
          })).min(1).max(10),
        }).optional().describe("Flexible format: groups of images or videos and texts, from which Meta builds the format each placement shows best (single image, video or carousel). Meta allows it on Sales and App promotion campaigns only"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, ad_set_id, creative_id, status, tracking_specs, conversion_domain, ad_labels, flexible_format }) => {
      const accountPath = normalizeAccountId(account_id);
      const adSetIdValidated = validateMetaId(ad_set_id, "adset");
      const creativeIdValidated = validateMetaId(creative_id, "creative");
      if (conversion_domain !== undefined && !DOMAIN.test(conversion_domain)) {
        throw new Error("conversion_domain is a bare domain, without scheme or path (e.g. example.com).");
      }
      const assetGroups = flexible_format ? buildAssetGroups(flexible_format.groups.map((g, i) => ({
        imageHashes: g.image_hashes ?? [],
        videoIds: (g.video_ids ?? []).map((id, j) => {
          if (!/^\d+$/.test(id)) throw new Error(`flexible_format.groups[${i}].video_ids[${j}] is not a video ID: video IDs are numeric.`);
          return id;
        }),
        primaryTexts: g.primary_texts ?? [],
        headlines: g.headlines ?? [],
        descriptions: g.descriptions ?? [],
        callToAction: g.call_to_action,
      }))) : undefined;

      const body: Record<string, string | number | boolean> = {
        name,
        adset_id: adSetIdValidated,
        creative: JSON.stringify({ creative_id: creativeIdValidated }),
        status,
      };

      if (tracking_specs) body.tracking_specs = JSON.stringify(tracking_specs);
      if (conversion_domain) body.conversion_domain = conversion_domain;
      if (ad_labels && ad_labels.length > 0) body.adlabels = JSON.stringify(ad_labels.map((label) => ({ name: label })));
      if (assetGroups) body.creative_asset_groups_spec = JSON.stringify(assetGroups);

      const result = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/ads`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad created successfully!\nID: ${result.id}\nName: ${name}\nAd Set: ${adSetIdValidated}\nCreative: ${creativeIdValidated}\nStatus: ${status}${flexible_format ? `\nFlexible format: ${flexible_format.groups.length} group(s); Meta picks the format per placement.` : ""}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_update_ad",
    {
      description: `${WRITE_WARNING}Update an existing ad's name, status, or creative. To change UTM parameters use ads_update_ad_url_tags — url_tags live on the creative, which is immutable.`,
      inputSchema: {
        ad_id: z.string().describe("Ad ID to update"),
        name: z.string().optional(),
        status: statusEnum.optional(),
        creative_id: z.string().optional().describe("New creative ID"),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_id, name, status, creative_id }) => {
      requireOneOf(
        { name, status, creative_id },
        ["name", "status", "creative_id"],
        "Nothing to update: provide at least one of name, status or creative_id.",
      );

      const id = validateMetaId(ad_id, "ad");
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (creative_id !== undefined) {
        body.creative = JSON.stringify({
          creative_id: validateMetaId(creative_id, "creative"),
        });
      }

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      return {
        content: [
          { type: "text", text: `Ad ${id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Update Ad URL Tags (UTMs) ───────────────────────────────
  server.registerTool(
    "ads_update_ad_url_tags",
    {
      description: `${WRITE_WARNING}Change the UTM parameters (url_tags) of one or more live ads. Meta creatives are immutable, so each ad's creative is cloned with the new url_tags and the ad is repointed at the clone. The clone re-references the source wholesale — the existing Facebook post, the creative spec, or the Instagram post — so media, copy, destination link and CTA are preserved, along with the post's likes and comments. The creative's destination setting (destination_spec, e.g. a Website and Shop opt-out) and WhatsApp Status identity (wamo_whatsapp_identity_spec) are carried over when the creative reports them, because since Marketing API v26.0 a new creative without them defaults to Website and Shop for advertisers with a shop and gets no WhatsApp identity. Side effect: every updated ad re-enters Meta review. Ads whose url_tags already match are skipped, so re-running converges — though an ad whose write failed mid-flight gets its own replacement creative on retry, leaving the earlier one unused (the response reports its id). Do not run two batches over the same ads concurrently. Ads with several text options or assets (asset_feed_spec) cannot keep their post: they are reported as skipped unless allow_new_post is true, which rebuilds them with a new post and resets the likes, comments and shares people see. Creatives built before v22.0 lose the deprecated standard_enhancements setting, which Meta now rejects; their other Advantage+ settings are kept. Use dry_run to preview.`,
      inputSchema: {
        ad_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Ad IDs to update (1-50)"),
        url_tags: z
          .string()
          .describe("New UTM query string, e.g. 'utm_source=meta&utm_medium=paid'. A leading '?' is stripped. Pass an empty string to remove tracking parameters."),
        allow_new_post: z
          .boolean()
          .default(false)
          .describe("Also rebuild ads with several text options or assets. Each gets a new post, so its visible likes, comments and shares start from zero."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Preview the plan without creating creatives or touching ads"),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_ids, url_tags, allow_new_post, dry_run }) => {
      const requestedTags = normalizeUrlTags(url_tags);
      const updated: UpdatedAd[] = [];
      const skipped: SkippedAd[] = [];
      const planned: PlannedRebuild[] = [];
      const warnings: string[] = [];

      const { groups, failed } = await groupAdsByCreative(ad_ids);

      const actionable: Array<{ group: CreativeGroup; creative: AdCreative; strategy: RebuildStrategy }> = [];
      for (const group of groups) {
        try {
          const creative = await readCreativeForRebuild(group.creative_id);

          if (normalizeUrlTags(creative.url_tags ?? "") === requestedTags) {
            for (const adId of group.ad_ids) {
              skipped.push({ ad_id: adId, reason: "url_tags already set to the requested value" });
            }
            continue;
          }

          const plan = planRebuild(creative, allow_new_post === true);
          if (typeof plan !== "string") {
            for (const adId of group.ad_ids) {
              skipped.push({ ad_id: adId, reason: plan.reason });
            }
            continue;
          }

          actionable.push({ group, creative, strategy: plan });
          for (const adId of group.ad_ids) {
            planned.push({ ad_id: adId, old_creative_id: group.creative_id, strategy: plan });
          }
        } catch (err) {
          const message = errorMessage(err);
          for (const adId of group.ad_ids) {
            failed.push({ ad_id: adId, error: message });
          }
        }
      }

      for (const { creative, strategy } of actionable) {
        warnings.push(...buildReplacementCreativeBody(creative, strategy, requestedTags).warnings);
      }

      if (!dry_run) {
        for (const { group, creative, strategy } of actionable) {
          let newCreativeId: string;
          try {
            const { body } = buildReplacementCreativeBody(creative, strategy, requestedTags);
            newCreativeId = await createReplacementCreative(group.account_id, body);
          } catch (err) {
            const message = errorMessage(err);
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${message}` });
            }
            continue;
          }

          const outcome = await repointGroup(group, newCreativeId);
          updated.push(...outcome.updated);
          failed.push(...outcome.failed);
          warnings.push(...outcome.warnings);
        }
      }

      const report = {
        dry_run,
        requested_url_tags: requestedTags,
        planned,
        updated,
        skipped,
        failed,
        warnings,
      };

      const lines: string[] = dry_run
        ? [
            `Dry run — no changes made. ${planned.length} ad(s) would get url_tags "${requestedTags || "(removed)"}".`,
            ...planned.map(
              (p) => `• Ad ${p.ad_id}: clone creative ${p.old_creative_id} (${describeStrategy(p.strategy)})`,
            ),
          ]
        : [
            `Updated ${updated.length} ad(s), skipped ${skipped.length}, failed ${failed.length}.`,
            ...updated.map(
              (u) => `• Ad ${u.ad_id}: creative ${u.old_creative_id} → ${u.new_creative_id}`,
            ),
          ];

      if (skipped.length > 0) {
        lines.push("", "Skipped:", ...skipped.map((s) => `• Ad ${s.ad_id}: ${s.reason}`));
      }
      if (failed.length > 0) {
        lines.push("", "Failed:", ...failed.map((f) => `• Ad ${f.ad_id}: ${f.error}`));
      }
      if (!dry_run && updated.length > 0) {
        lines.push(
          "",
          "⚠️ Updated ads re-enter Meta review and may pause delivery briefly. The previous creatives still exist and are unchanged.",
        );
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(report, null, 2) },
        ],
      };
    },
  );

  // ─── Delete Ad ───────────────────────────────────────────────
  server.registerTool(
    "ads_delete_ad",
    {
      description: `${WRITE_WARNING}Delete an ad (soft delete — sets status to DELETED). Meta does not let you delete the ad of a dynamic-creative ad set on its own; for those, delete or pause the ad set instead. To remove one text option from an ad, use ads_update_ad_content.`,
      inputSchema: {
        ad_id: z.string().describe("Ad ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ ad_id }) => {
      const id = validateMetaId(ad_id, "ad");
      const ad = await metaApiClient.get<{ adset?: { id?: string; is_dynamic_creative?: boolean } }>(`/${id}`, {
        fields: "adset{id,is_dynamic_creative}",
      });
      if (ad.adset?.is_dynamic_creative) {
        throw new Error(`Ad ${id} belongs to dynamic-creative ad set ${ad.adset.id}, and Meta does not allow deleting such an ad on its own (subcode 1340029). Delete the ad set with ads_delete_ad_set, or pause it with ads_activate_entity.`);
      }
      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad ${id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
