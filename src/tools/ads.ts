import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam, normalizeUrlTags, requireOneOf } from "../utils/validation.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import type { Ad, AdCreative, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

const CREATIVE_REBUILD_FIELDS =
  "id,name,object_story_spec,asset_feed_spec,effective_object_story_id,url_tags,instagram_user_id";

type RebuildStrategy = "reuse_post" | "clone_spec";

interface CreativeGroup {
  creative_id: string;
  account_id: string;
  ad_ids: string[];
}

interface PlannedRebuild {
  ad_id: string;
  old_creative_id: string;
  strategy: RebuildStrategy;
}

interface UpdatedAd {
  ad_id: string;
  old_creative_id: string;
  new_creative_id: string;
}

interface SkippedAd {
  ad_id: string;
  reason: string;
}

interface FailedAd {
  ad_id: string;
  error: string;
  new_creative_id?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveInstagramUserId(creative: AdCreative): string | undefined {
  if (creative.instagram_user_id) return creative.instagram_user_id;
  const embedded = asRecord(creative.object_story_spec)?.["instagram_user_id"];
  return typeof embedded === "string" ? embedded : undefined;
}

// Meta creatives are immutable except for name/status/adlabels, so changing
// url_tags means minting a replacement. Reusing the existing post keeps the
// ad's social proof (likes/comments); cloning the spec is the fallback.
function planRebuild(creative: AdCreative): RebuildStrategy | { reason: string } {
  if (creative.asset_feed_spec) {
    return {
      reason: "dynamic creative (asset_feed_spec) — url_tags cannot be rebuilt without collapsing its asset variations",
    };
  }
  if (creative.effective_object_story_id) return "reuse_post";
  if (asRecord(creative.object_story_spec)) return "clone_spec";
  return { reason: "creative has no reusable post or object_story_spec to rebuild from" };
}

function buildReplacementCreativeBody(
  creative: AdCreative,
  strategy: RebuildStrategy,
  urlTags: string,
): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  if (creative.name) body.name = creative.name;

  if (strategy === "reuse_post") {
    body.object_story_id = creative.effective_object_story_id as string;
    const instagramUserId = resolveInstagramUserId(creative);
    if (instagramUserId) body.instagram_user_id = instagramUserId;
  } else {
    body.object_story_spec = JSON.stringify(creative.object_story_spec);
  }

  if (urlTags !== "") body.url_tags = urlTags;

  return body;
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
          .array(z.record(z.unknown()))
          .optional()
          .describe("Tracking specifications"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, ad_set_id, creative_id, status, tracking_specs }) => {
      const accountPath = normalizeAccountId(account_id);
      const adSetIdValidated = validateMetaId(ad_set_id, "adset");
      const creativeIdValidated = validateMetaId(creative_id, "creative");

      const body: Record<string, string | number | boolean> = {
        name,
        adset_id: adSetIdValidated,
        creative: JSON.stringify({ creative_id: creativeIdValidated }),
        status,
      };

      if (tracking_specs) body.tracking_specs = JSON.stringify(tracking_specs);

      const result = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/ads`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad created successfully!\nID: ${result.id}\nName: ${name}\nAd Set: ${adSetIdValidated}\nCreative: ${creativeIdValidated}\nStatus: ${status}`,
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
      description: `${WRITE_WARNING}Change the UTM parameters (url_tags) of one or more live ads. Meta creatives are immutable, so each ad's creative is cloned with the new url_tags and the ad is repointed at the clone — the existing post is reused when possible, preserving likes and comments. Side effect: every updated ad re-enters Meta review. Ads whose url_tags already match are skipped, so re-running is safe. Dynamic creatives (asset_feed_spec) are reported as skipped. Use dry_run to preview.`,
      inputSchema: {
        ad_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("Ad IDs to update (1-50)"),
        url_tags: z
          .string()
          .describe("New UTM query string, e.g. 'utm_source=meta&utm_medium=paid'. A leading '?' is stripped. Pass an empty string to remove tracking parameters."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Preview the plan without creating creatives or touching ads"),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_ids, url_tags, dry_run }) => {
      const requestedTags = normalizeUrlTags(url_tags);
      const updated: UpdatedAd[] = [];
      const skipped: SkippedAd[] = [];
      const failed: FailedAd[] = [];
      const planned: PlannedRebuild[] = [];

      const groups = new Map<string, CreativeGroup>();
      for (const rawAdId of ad_ids) {
        try {
          const adId = validateMetaId(rawAdId, "ad");
          const ad = await metaApiClient.get<Ad & { account_id?: string }>(`/${adId}`, {
            fields: "account_id,creative{id}",
          });

          if (!ad.creative?.id) {
            failed.push({ ad_id: rawAdId, error: "Ad has no creative to rebuild." });
            continue;
          }
          if (!ad.account_id) {
            failed.push({ ad_id: rawAdId, error: "Ad did not report an account_id." });
            continue;
          }

          const creativeId = ad.creative.id;
          const group = groups.get(creativeId);
          if (group) {
            group.ad_ids.push(adId);
          } else {
            groups.set(creativeId, {
              creative_id: creativeId,
              account_id: ad.account_id,
              ad_ids: [adId],
            });
          }
        } catch (err) {
          failed.push({ ad_id: rawAdId, error: errorMessage(err) });
        }
      }

      const actionable: Array<{ group: CreativeGroup; creative: AdCreative; strategy: RebuildStrategy }> = [];
      for (const group of groups.values()) {
        try {
          const creative = await metaApiClient.get<AdCreative>(
            `/${validateMetaId(group.creative_id, "creative")}`,
            { fields: CREATIVE_REBUILD_FIELDS },
          );

          if (normalizeUrlTags(creative.url_tags ?? "") === requestedTags) {
            for (const adId of group.ad_ids) {
              skipped.push({ ad_id: adId, reason: "url_tags already set to the requested value" });
            }
            continue;
          }

          const plan = planRebuild(creative);
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

      if (!dry_run) {
        for (const { group, creative, strategy } of actionable) {
          let newCreativeId: string;
          try {
            const body = buildReplacementCreativeBody(creative, strategy, requestedTags);
            const created = await metaApiClient.postForm<{ id: string }>(
              `/${normalizeAccountId(group.account_id)}/adcreatives`,
              body,
            );
            newCreativeId = created.id;
          } catch (err) {
            const message = errorMessage(err);
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${message}` });
            }
            continue;
          }

          for (const adId of group.ad_ids) {
            try {
              await metaApiClient.postForm<{ success: boolean }>(
                `/${adId}`,
                { creative: JSON.stringify({ creative_id: newCreativeId }) },
                { accountId: normalizeAccountId(group.account_id) },
              );
              updated.push({
                ad_id: adId,
                old_creative_id: group.creative_id,
                new_creative_id: newCreativeId,
              });
            } catch (err) {
              failed.push({
                ad_id: adId,
                error: `Creative ${newCreativeId} was created but the ad still points at ${group.creative_id}: ${errorMessage(err)}. Retry with ads_update_ad { ad_id: "${adId}", creative_id: "${newCreativeId}" }.`,
                new_creative_id: newCreativeId,
              });
            }
          }
        }
      }

      const report = {
        dry_run,
        requested_url_tags: requestedTags,
        planned,
        updated,
        skipped,
        failed,
      };

      const lines: string[] = dry_run
        ? [
            `Dry run — no changes made. ${planned.length} ad(s) would get url_tags "${requestedTags || "(removed)"}".`,
            ...planned.map(
              (p) =>
                `• Ad ${p.ad_id}: clone creative ${p.old_creative_id} (${p.strategy === "reuse_post" ? "reusing the existing post" : "cloning the creative spec"})`,
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
      description: `${WRITE_WARNING}Delete an ad (soft delete — sets status to DELETED).`,
      inputSchema: {
        ad_id: z.string().describe("Ad ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ ad_id }) => {
      const id = validateMetaId(ad_id, "ad");
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
