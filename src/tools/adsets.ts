import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { ADSET_DEFAULT_FIELDS } from "../meta/types/adset.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import type { Ad, AdCreative, AdSet, GeoLocation, MetaApiResponse, TargetingSpec } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";
import { getCloneBundleStore, STALE_IN_PROGRESS_MS } from "../store/clone-bundle-store.js";
import { ctaEnum } from "./creatives.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

const destinationTypeEnum = z.enum([
  "WEBSITE", "APP", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT",
  "ON_AD", "ON_PAGE", "ON_EVENT", "ON_VIDEO",
  "SHOP_AUTOMATIC", "FACEBOOK", "FACEBOOK_PAGE", "INSTAGRAM_PROFILE",
  "INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  "MESSAGING_MESSENGER_WHATSAPP",
  "APPLINKS_AUTOMATIC",
]);

const optimizationGoalEnum = z.enum([
  "NONE", "APP_INSTALLS", "AD_RECALL_LIFT", "ENGAGED_USERS",
  "EVENT_RESPONSES", "IMPRESSIONS", "LEAD_GENERATION", "QUALITY_LEAD",
  "LINK_CLICKS", "OFFSITE_CONVERSIONS", "PAGE_LIKES", "POST_ENGAGEMENT",
  "QUALITY_CALL", "REACH", "LANDING_PAGE_VIEWS", "VISIT_INSTAGRAM_PROFILE",
  "VALUE", "THRUPLAY", "DERIVED_EVENTS", "APP_INSTALLS_AND_OFFSITE_CONVERSIONS",
  "CONVERSATIONS", "IN_APP_VALUE", "MESSAGING_PURCHASE_CONVERSION",
  "MESSAGING_APPOINTMENT_CONVERSION", "SUBSCRIBERS", "REMINDERS_SET",
]);

const billingEventEnum = z.enum(["IMPRESSIONS", "LINK_CLICKS", "POST_ENGAGEMENT", "THRUPLAY"]);

const bidStrategyEnum = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

const geoLocationSchema = z.object({
  countries: z.array(z.string()).optional(),
  regions: z.array(z.object({ key: z.string() })).optional(),
  cities: z
    .array(
      z.object({
        key: z.string(),
        radius: z.number().optional(),
        distance_unit: z.string().optional(),
      }),
    )
    .optional(),
  zips: z.array(z.object({ key: z.string() })).optional(),
  location_types: z.array(z.string()).optional(),
}).passthrough();

const idNameArray = z.array(z.object({ id: z.string(), name: z.string().optional() })).optional();

const targetingSchema = z
  .object({
    geo_locations: geoLocationSchema.optional(),
    excluded_geo_locations: geoLocationSchema.optional().describe("Locations to exclude from targeting"),

    age_min: z.number().min(13).max(65).optional(),
    age_max: z.number().min(13).max(65).optional(),
    genders: z.array(z.number().min(0).max(2)).optional().describe("0=all, 1=male, 2=female"),
    locales: z.array(z.number()).optional().describe("Locale IDs for language targeting (e.g., 6=English, 24=Spanish)"),
    relationship_statuses: z.array(z.number()).optional().describe("1=single, 2=in_relationship, 3=married, 4=engaged, 6=unspecified"),

    interests: idNameArray,
    behaviors: idNameArray,

    education_statuses: z.array(z.number()).optional().describe("1=HIGH_SCHOOL, 2=UNDERGRAD, 3=ALUM, 7=IN_GRAD_SCHOOL, 9=MASTER_DEGREE, etc."),
    education_schools: idNameArray,
    education_majors: idNameArray,
    college_years: z.array(z.number()).optional(),
    work_employers: idNameArray,
    work_positions: idNameArray,

    life_events: idNameArray,
    industries: idNameArray,
    income: idNameArray,
    family_statuses: idNameArray,
    user_adclusters: idNameArray.describe("Broad category targeting clusters"),

    custom_audiences: z.array(z.object({ id: z.string() })).optional(),
    excluded_custom_audiences: z.array(z.object({ id: z.string() })).optional(),

    device_platforms: z.array(z.string()).optional().describe("mobile, desktop"),
    user_os: z.array(z.string()).optional().describe("OS targeting: iOS, Android, or versioned like iOS_ver_15.0_and_above"),
    user_device: z.array(z.string()).optional().describe("Target specific devices (e.g., Galaxy S24, iPhone 15)"),
    excluded_user_device: z.array(z.string()).optional(),
    wireless_carrier: z.array(z.string()).optional().describe("Carrier targeting (use 'Wifi' for wifi-only users)"),

    publisher_platforms: z.array(z.string()).optional().describe("facebook, instagram, threads, messenger, audience_network"),
    facebook_positions: z.array(z.string()).optional().describe("feed, right_hand_column, marketplace, video_feeds, story, search, instream_video, facebook_reels, facebook_reels_overlay, profile_feed, notification"),
    instagram_positions: z.array(z.string()).optional().describe("stream, story, explore, explore_home, reels, profile_feed, ig_search, profile_reels"),
    threads_positions: z.array(z.string()).optional().describe("threads_stream (requires instagram stream)"),
    audience_network_positions: z.array(z.string()).optional().describe("classic, rewarded_video"),
    messenger_positions: z.array(z.string()).optional().describe("sponsored_messages, story"),
    whatsapp_positions: z.array(z.string()).optional().describe("status (requires instagram story)"),

    brand_safety_content_filter_levels: z.array(z.string()).optional().describe("FACEBOOK_RELAXED/STANDARD/STRICT, AN_RELAXED/STANDARD/STRICT, FEED_RELAXED/STANDARD/STRICT"),
    excluded_publisher_categories: z.array(z.string()).optional().describe("dating, gambling, debated_social_issues, mature_audiences, tragedy_and_conflict"),
    excluded_publisher_list_ids: z.array(z.string()).optional().describe("Block list IDs to exclude specific publishers"),

    flexible_spec: z.array(z.record(z.unknown())).optional().describe("Array of targeting groups combined with AND; items within each group use OR"),
    exclusions: z.record(z.unknown()).optional(),

    targeting_automation: z.object({
      advantage_audience: z.number().optional().describe("1 to enable Advantage+ audience"),
    }).passthrough().optional().describe("Advantage+ audience automation settings"),
  })
  .passthrough()
  .describe("Targeting specification for the ad set");

const adSetIdentityFields = ["id", "name", "campaign_id", "status", "effective_status"] as const;

const cloneTargetAdSetSchema = z.object({
  name: z.string().min(1).describe("Name for the cloned ad set"),
  geo_override: geoLocationSchema.describe("Geo override that REPLACES the source geo_locations (for example, { countries: ['CL'] }). Cities/regions/zips from the source are NOT inherited."),
  status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED").describe("Status for the cloned ad set and ads. Defaults to PAUSED."),
  daily_budget: z.number().optional().describe("Optional daily budget override in cents. Takes precedence over the source budget, regardless of source budget type."),
  lifetime_budget: z.number().optional().describe("Optional lifetime budget override in cents. Requires end_time."),
  end_time: z.string().optional().describe("ISO 8601 end time. Required when lifetime_budget is set."),
  destination_type: destinationTypeEnum.optional().describe("Optional destination_type override"),
  promoted_object: z.record(z.unknown()).optional().describe("Optional promoted_object override"),
});

const creativeOverrideSchema = z.object({
  source_ad_id: z.string().optional().describe("Source ad ID to override"),
  source_creative_id: z.string().optional().describe("Source creative ID to override"),
  name: z.string().optional().describe("Name for the cloned creative"),
  headline: z.string().optional().describe("Headline/title override"),
  message: z.string().optional().describe("Primary text override"),
  description: z.string().optional().describe("Description override"),
  link_url: z.string().optional().describe("Optional destination URL override"),
  call_to_action_type: ctaEnum.optional().describe("Optional CTA override"),
}).refine(
  (value) => Boolean(value.source_ad_id || value.source_creative_id),
  "Each creative override must include source_ad_id or source_creative_id.",
);

interface CreativeOverrideInput {
  source_ad_id?: string;
  source_creative_id?: string;
  name?: string;
  headline?: string;
  message?: string;
  description?: string;
  link_url?: string;
  call_to_action_type?: string;
}

interface CloneAdSetBundleResource {
  id?: string;
  name: string;
  status?: string;
  campaign_id?: string;
  ad_set_id?: string;
  creative_id?: string;
  source_ad_id?: string;
  source_creative_id?: string;
  planned?: boolean;
}

interface CloneAdSetBundleSkip {
  source_ad_id?: string;
  source_creative_id?: string;
  name?: string;
  reason: string;
}

interface CloneAdSetBundleResult {
  dry_run: boolean;
  idempotency_key?: string;
  new_ad_set: CloneAdSetBundleResource;
  created_creatives: CloneAdSetBundleResource[];
  created_ads: CloneAdSetBundleResource[];
  skipped: CloneAdSetBundleSkip[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

type OverrideStrategy = "copy" | "swap" | "warn_override_ignored";

// Decides how a creative override is applied on top of a native ad copy.
// - "copy": no override → plain native copy (every creative type, lossless).
// - "swap": override on an object_story_spec creative → copy, then swap a
//   modified creative built from the real source spec.
// - "warn_override_ignored": dynamic (asset_feed_spec) creatives store copy in
//   arrays where a single-value override is ambiguous, and creatives with no
//   object_story_spec (e.g. boosted posts) cannot be patched — the ad still
//   copies, but the override is reported, never silently dropped.
function classifyOverride(
  override: CreativeOverrideInput | undefined,
  sourceCreative: AdCreative | undefined,
): OverrideStrategy {
  if (!override) return "copy";
  if (sourceCreative?.asset_feed_spec) return "warn_override_ignored";
  if (!asRecord(sourceCreative?.object_story_spec)) return "warn_override_ignored";
  return "swap";
}

function describeIgnoredOverrideReason(sourceCreative: AdCreative | undefined): string {
  if (sourceCreative?.asset_feed_spec) return "dynamic asset_feed_spec creative";
  if (!sourceCreative) return "source ad has no readable creative";
  return "creative has no patchable object_story_spec";
}

function applyCtaOverride(
  cta: Record<string, unknown> | undefined,
  override: CreativeOverrideInput,
): Record<string, unknown> | undefined {
  const next = { ...(cta ?? {}) };
  if (override.call_to_action_type) next.type = override.call_to_action_type;
  if (override.link_url) {
    const value = asRecord(next.value) ?? {};
    next.value = { ...value, link: override.link_url };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

// Deep-clones the source object_story_spec and patches the override fields into
// it, reusing the real source media/structure (image_hash, video_id, page_id,
// carousel attachments). Returns undefined when there is no link_data/video_data
// to target, so the caller can degrade to a warning instead of a silent change.
function buildPatchedObjectStorySpec(
  sourceCreative: AdCreative,
  override: CreativeOverrideInput,
): Record<string, unknown> | undefined {
  const oss = asRecord(sourceCreative.object_story_spec);
  if (!oss) return undefined;
  const next = structuredClone(oss) as Record<string, unknown>;

  const videoData = asRecord(next.video_data);
  const linkData = asRecord(next.link_data);

  if (videoData) {
    if (override.headline !== undefined) videoData.title = override.headline;
    if (override.message !== undefined) videoData.message = override.message;
    if (override.description !== undefined) videoData.link_description = override.description;
    const cta = applyCtaOverride(asRecord(videoData.call_to_action), override);
    if (cta) videoData.call_to_action = cta;
    next.video_data = videoData;
    return next;
  }

  if (linkData) {
    if (override.headline !== undefined) linkData.name = override.headline;
    if (override.message !== undefined) linkData.message = override.message;
    if (override.description !== undefined) linkData.description = override.description;
    if (override.link_url !== undefined) linkData.link = override.link_url;
    const cta = applyCtaOverride(asRecord(linkData.call_to_action), override);
    if (cta) linkData.call_to_action = cta;
    next.link_data = linkData;
    return next;
  }

  return undefined;
}

function buildAdSetDetailsFields(fields?: string[]): string {
  const requested =
    fields && fields.length > 0
      ? [...new Set([...adSetIdentityFields, ...fields])]
      : [...new Set([...ADSET_DEFAULT_FIELDS, "frequency_control_specs", "promoted_object", "destination_type"])];

  return buildFieldsParam(requested, requested);
}

const TARGETING_READ_ONLY_FIELDS = [
  "targeting_relaxation_types",
  "is_whatsapp_destination_ad",
  "targeting_optimization",
] as const;

function applyGeoOverride(targeting: TargetingSpec | undefined, geoOverride: GeoLocation): TargetingSpec {
  const nextTargeting = structuredClone(targeting ?? {}) as TargetingSpec;
  // Replace, do NOT merge. Inheriting cities/regions/zips from the source
  // when changing countries produces nonsensical targeting (e.g., "Colombia
  // + Santiago, Chile"). Meta's own docs recommend redefining geo_locations
  // when swapping country.
  nextTargeting.geo_locations = { ...geoOverride };
  for (const field of TARGETING_READ_ONLY_FIELDS) {
    delete nextTargeting[field];
  }
  return nextTargeting;
}

function deriveClonedName(sourceName: string, sourcePrefix: string, targetPrefix: string): string {
  if (sourceName.startsWith(sourcePrefix)) {
    return `${targetPrefix}${sourceName.slice(sourcePrefix.length)}`;
  }

  return sourceName;
}

function findCreativeOverride(
  overrides: readonly CreativeOverrideInput[],
  sourceAdId: string,
  sourceCreativeId?: string,
): CreativeOverrideInput | undefined {
  return overrides.find((override) =>
    override.source_ad_id === sourceAdId
    || (sourceCreativeId && override.source_creative_id === sourceCreativeId),
  );
}

export function registerAdSetTools(server: McpServer): void {
  // ─── Get Ad Sets ─────────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_sets",
    {
      description: "Get ad sets for an ad account. Optionally filter by campaign or status.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        status_filter: z.array(statusEnum).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, campaign_id, status_filter }) => {
      const path = campaign_id
        ? `/${validateMetaId(campaign_id, "campaign")}/adsets`
        : `/${normalizeAccountId(account_id)}/adsets`;

      const fieldsParam = buildFieldsParam(undefined, [...ADSET_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: status_filter },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<AdSet>>(path, params);
      const adSets = response.data ?? [];

      const text =
        adSets.length === 0
          ? "No ad sets found."
          : adSets
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Goal: ${a.optimization_goal} — Budget: ${a.daily_budget ? `${a.daily_budget}/day` : a.lifetime_budget ? `${a.lifetime_budget} lifetime` : "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${adSets.length} ad set(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(adSets, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Set Details ──────────────────────────────────────
  server.registerTool(
    "ads_get_ad_set_details",
    {
      description:
        "Get detailed information about a specific ad set including targeting, budget, and optimization settings.",
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ ad_set_id, fields }) => {
      const id = validateMetaId(ad_set_id, "adset");
      const fieldsParam = buildAdSetDetailsFields(fields);
      const adSet = await metaApiClient.get<AdSet>(`/${id}`, { fields: fieldsParam });
      const targetingSummary = adSet.targeting ? JSON.stringify(adSet.targeting, null, 2) : "N/A";

      return {
        content: [
          {
            type: "text",
            text: `Ad Set: ${adSet.name ?? "N/A"}\nID: ${adSet.id ?? "N/A"}\nCampaign: ${adSet.campaign_id ?? "N/A"}\nStatus: ${adSet.status ?? "N/A"} (effective: ${adSet.effective_status ?? "N/A"})\nOptimization: ${adSet.optimization_goal ?? "N/A"}\nBilling: ${adSet.billing_event ?? "N/A"}\nBid: ${adSet.bid_amount ?? "Auto"}\nDaily Budget: ${adSet.daily_budget ?? "N/A"}\nLifetime Budget: ${adSet.lifetime_budget ?? "N/A"}\nTargeting: ${targetingSummary}`,
          },
          { type: "text", text: JSON.stringify(adSet, null, 2) },
        ],
      };
    },
  );

  // ─── Clone Ad Set Bundle ────────────────────────────────────
  server.registerTool(
    "ads_clone_ad_set_bundle",
    {
      description: `${WRITE_WARNING}Clone an ad set bundle in one operation: reads a source ad set, clones its targeting/budget/pixel setup into a new ad set, and recreates every ad by duplicating it with Meta's native ad-copy endpoint (POST /{ad_id}/copies). Native copy gives 100% creative-type coverage — link, image, video, carousel, collection, catalog/Advantage+ catalog, dynamic (asset_feed_spec), and boosted posts all clone losslessly, with the destination ad set's pixel applied automatically. Designed for workflows like duplicating a GEO-specific ad set to another country with a different pixel while keeping every new resource PAUSED by default. creative_overrides change copy per source ad: on standard (object_story_spec) creatives the override is applied by swapping a modified creative onto the copied ad; on dynamic or otherwise non-patchable creatives the override cannot be applied and is reported in warnings while the ad remains in created_ads. If a single ad fails to copy it is reported in skipped and the rest proceed. Supports dry_run planning and idempotency_key-based retry safety.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        source_ad_set_id: z.string().describe("Source ad set ID to clone"),
        target_ad_set: cloneTargetAdSetSchema.describe("Configuration for the cloned ad set"),
        creative_overrides: z.array(creativeOverrideSchema).default([]).describe("Optional creative overrides keyed by source_ad_id or source_creative_id. Applied via creative swap on standard creatives; ignored (and reported) on dynamic or otherwise non-patchable creatives."),
        dry_run: z.boolean().default(false).describe("Plan the operation without creating any resources"),
        idempotency_key: z.string().optional().describe("Required for real execution. Reusing the same key returns the prior result instead of duplicating resources."),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, source_ad_set_id, target_ad_set, creative_overrides, dry_run, idempotency_key }) => {
      if (!dry_run && !idempotency_key) {
        throw new Error("idempotency_key is required when dry_run is false.");
      }

      const accountPath = normalizeAccountId(account_id);
      const sourceAdSetIdValidated = validateMetaId(source_ad_set_id, "adset");

      const requestSignature = JSON.stringify({
        account_id: accountPath,
        source_ad_set_id: sourceAdSetIdValidated,
        target_ad_set,
        creative_overrides,
      });
      const cacheKey = idempotency_key
        ? `${idempotency_key}:${accountPath}:${sourceAdSetIdValidated}:${target_ad_set.name}`
        : undefined;
      const store = getCloneBundleStore();

      if (cacheKey && !dry_run) {
        const existing = await store.getDoc(cacheKey);
        if (existing) {
          if (existing.signature !== requestSignature) {
            throw new Error("idempotency_key already exists for a different ads_clone_ad_set_bundle payload.");
          }
          if (existing.state === "completed" && existing.result) {
            return {
              content: [
                { type: "text", text: `ads_clone_ad_set_bundle reused cached result for key ${idempotency_key}.` },
                { type: "text", text: JSON.stringify(existing.result, null, 2) },
              ],
            };
          }
          if (existing.state === "in_progress") {
            const lockAgeMs = Date.now() - existing.startedAt;
            if (lockAgeMs <= STALE_IN_PROGRESS_MS) {
              throw new Error(`ads_clone_ad_set_bundle is already in progress for idempotency_key ${idempotency_key} (started ${new Date(existing.startedAt).toISOString()}). Wait for completion or use a different key.`);
            }
            // Stale lock (>STALE_IN_PROGRESS_MS) — fall through to store.claim()
            // which takes over the stale entry. This handles the crash-between-
            // claim-and-markFailed case so users aren't blocked permanently.
          }
          if (existing.state === "failed") {
            const created = existing.createdResources;
            const orphans = [
              created.adSetId ? `ad_set=${created.adSetId}` : undefined,
              created.creativeIds.length ? `creatives=[${created.creativeIds.join(",")}]` : undefined,
              created.adIds.length ? `ads=[${created.adIds.join(",")}]` : undefined,
            ].filter(Boolean).join(", ");
            throw new Error(`Previous ads_clone_ad_set_bundle run with idempotency_key ${idempotency_key} failed. Partial resources created: ${orphans || "none"}. Error: ${existing.lastError ?? "unknown"}. Clean up these resources manually (or with ads_delete_*) and retry with a new idempotency_key.`);
          }
        }
      }

      const sourceAdSetFields = buildAdSetDetailsFields(undefined);
      const sourceAdSet = await metaApiClient.get<AdSet>(`/${sourceAdSetIdValidated}`, {
        fields: sourceAdSetFields,
      });

      if (!sourceAdSet.optimization_goal || !sourceAdSet.billing_event) {
        throw new Error("Source ad set is missing optimization_goal or billing_event and cannot be cloned safely.");
      }

      // Note: when both source and target have no budget, we assume the parent
      // campaign uses CBO (Campaign Budget Optimization). Meta will reject the
      // create call if that assumption is wrong, with a clear error.
      if (target_ad_set.lifetime_budget !== undefined && !target_ad_set.end_time) {
        throw new Error("target_ad_set.lifetime_budget requires target_ad_set.end_time.");
      }

      const adsFieldsParam = buildFieldsParam(undefined, [...AD_DEFAULT_FIELDS]);
      const sourceAds = await metaApiClient.getPaginated<Ad>(
        `/${sourceAdSetIdValidated}/ads`,
        { fields: adsFieldsParam, limit: 100 },
        500,
      );

      const warnings: string[] = [];
      const skipped: CloneAdSetBundleSkip[] = [];

      const clonedTargeting = applyGeoOverride(sourceAdSet.targeting, target_ad_set.geo_override);
      const targetStatus = target_ad_set.status ?? "PAUSED";
      // Force PAUSED unless the caller explicitly asked for ACTIVE — never
      // INHERITED_FROM_SOURCE, which could silently activate a copy of an active ad.
      const statusOption = targetStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";

      interface AdCopyPlan {
        sourceAd: Ad;
        sourceCreativeId?: string;
        sourceCreative?: AdCreative;
        override?: CreativeOverrideInput;
        strategy: OverrideStrategy;
        plannedName: string;
      }

      const adPlans: AdCopyPlan[] = [];
      for (const sourceAd of sourceAds) {
        const sourceCreativeId = sourceAd.creative?.id;
        const override = findCreativeOverride(creative_overrides, sourceAd.id, sourceCreativeId);
        // The creative is only read to apply an override (swap) or to detect a
        // dynamic creative an override can't touch. Plain copies never read it —
        // native copy duplicates the creative server-side for every type.
        let sourceCreative: AdCreative | undefined;
        if (override && sourceCreativeId) {
          sourceCreative = await metaApiClient.get<AdCreative>(`/${sourceCreativeId}`, {
            fields: buildFieldsParam(undefined, [...CREATIVE_DEFAULT_FIELDS]),
          });
        }
        adPlans.push({
          sourceAd,
          sourceCreativeId,
          sourceCreative,
          override,
          strategy: classifyOverride(override, sourceCreative),
          plannedName: deriveClonedName(sourceAd.name, sourceAdSet.name, target_ad_set.name),
        });
      }

      const result: CloneAdSetBundleResult = {
        dry_run,
        idempotency_key,
        new_ad_set: {
          name: target_ad_set.name,
          campaign_id: sourceAdSet.campaign_id,
          status: targetStatus,
          planned: dry_run,
        },
        created_creatives: [],
        created_ads: [],
        skipped,
        warnings,
      };

      if (dry_run) {
        for (const plan of adPlans) {
          result.created_ads.push({
            source_ad_id: plan.sourceAd.id,
            name: plan.plannedName,
            status: targetStatus,
            planned: true,
          });
          if (plan.strategy === "swap") {
            result.created_creatives.push({
              source_ad_id: plan.sourceAd.id,
              source_creative_id: plan.sourceCreativeId,
              name: plan.override?.name ?? plan.plannedName,
              status: targetStatus,
              planned: true,
            });
          }
          if (plan.strategy === "warn_override_ignored") {
            warnings.push(`Ad ${plan.sourceAd.id}: creative_overrides cannot be applied to this ${describeIgnoredOverrideReason(plan.sourceCreative)}; the ad will be copied without the override.`);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: `Dry run ready: ${target_ad_set.name}\nSource ads to copy: ${adPlans.length}\nWith overrides (swap): ${adPlans.filter((p) => p.strategy === "swap").length}\nOverrides ignored (dynamic): ${adPlans.filter((p) => p.strategy === "warn_override_ignored").length}`,
            },
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      if (adPlans.length === 0) {
        throw new Error(`ads_clone_ad_set_bundle: source ad set ${sourceAdSetIdValidated} has no ads to copy.`);
      }

      if (cacheKey) {
        const claim = await store.claim(cacheKey, requestSignature);
        if (claim.status === "duplicate") {
          const existing = claim.existing!;
          if (existing.signature !== requestSignature) {
            throw new Error("idempotency_key already exists for a different ads_clone_ad_set_bundle payload.");
          }
          if (existing.state === "completed" && existing.result) {
            return {
              content: [
                { type: "text", text: `ads_clone_ad_set_bundle reused cached result for key ${idempotency_key}.` },
                { type: "text", text: JSON.stringify(existing.result, null, 2) },
              ],
            };
          }
          throw new Error(`ads_clone_ad_set_bundle: concurrent execution detected for idempotency_key ${idempotency_key}.`);
        }
      }

      const createdResources = { adSetId: undefined as string | undefined, creativeIds: [] as string[], adIds: [] as string[] };
      const markFailed = async (error: unknown): Promise<void> => {
        if (!cacheKey) return;
        try {
          await store.update(cacheKey, {
            state: "failed",
            lastError: error instanceof Error ? error.message : String(error),
            createdResources,
          });
        } catch (storeErr) {
          // best-effort; do not mask the original error
          void storeErr;
        }
      };

      const createAdSetBody: Record<string, string | number | boolean> = {
        campaign_id: sourceAdSet.campaign_id,
        name: target_ad_set.name,
        status: targetStatus,
        optimization_goal: sourceAdSet.optimization_goal,
        billing_event: sourceAdSet.billing_event,
        targeting: JSON.stringify(clonedTargeting),
      };
      const resolvedDestinationType = target_ad_set.destination_type ?? sourceAdSet.destination_type;
      if (resolvedDestinationType) createAdSetBody.destination_type = resolvedDestinationType;

      // Budget resolution: user-provided overrides win regardless of source
      // budget shape. Only fall back to source when the user provides neither.
      // If both source and user provide nothing, leave both unset (CBO case).
      let resolvedDailyBudget: number | undefined;
      let resolvedLifetimeBudget: number | undefined;
      let resolvedEndTime: string | undefined;
      if (target_ad_set.lifetime_budget !== undefined) {
        resolvedLifetimeBudget = target_ad_set.lifetime_budget;
        resolvedEndTime = target_ad_set.end_time;
      } else if (target_ad_set.daily_budget !== undefined) {
        resolvedDailyBudget = target_ad_set.daily_budget;
      } else if (sourceAdSet.lifetime_budget) {
        resolvedLifetimeBudget = Number(sourceAdSet.lifetime_budget);
        resolvedEndTime = sourceAdSet.end_time;
      } else if (sourceAdSet.daily_budget) {
        resolvedDailyBudget = Number(sourceAdSet.daily_budget);
      }

      if (resolvedLifetimeBudget !== undefined) createAdSetBody.lifetime_budget = String(resolvedLifetimeBudget);
      if (resolvedDailyBudget !== undefined) createAdSetBody.daily_budget = String(resolvedDailyBudget);
      if (sourceAdSet.bid_amount !== undefined) createAdSetBody.bid_amount = sourceAdSet.bid_amount;
      if (sourceAdSet.bid_strategy) createAdSetBody.bid_strategy = sourceAdSet.bid_strategy;
      if (sourceAdSet.start_time) createAdSetBody.start_time = sourceAdSet.start_time;
      if (resolvedEndTime && resolvedLifetimeBudget !== undefined) createAdSetBody.end_time = resolvedEndTime;

      const promotedObject = target_ad_set.promoted_object ?? sourceAdSet.promoted_object;
      if (promotedObject) createAdSetBody.promoted_object = JSON.stringify(promotedObject);

      let newAdSet: { id: string };
      try {
        newAdSet = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/adsets`, createAdSetBody);
      } catch (err) {
        await markFailed(err);
        throw err;
      }
      createdResources.adSetId = newAdSet.id;
      if (cacheKey) await store.update(cacheKey, { createdResources });
      result.new_ad_set = {
        id: newAdSet.id,
        name: target_ad_set.name,
        campaign_id: sourceAdSet.campaign_id,
        status: targetStatus,
      };

      for (const plan of adPlans) {
        const { sourceAd, plannedName, strategy } = plan;

        // 1. Native copy — duplicates the ad + its creative into the new ad set
        //    for every creative type, inheriting the new ad set's pixel.
        const copyBody: Record<string, string | number | boolean> = {
          adset_id: newAdSet.id,
          status_option: statusOption,
          // NO_RENAME suppresses Meta's localized "- Copy" suffix; we apply the
          // source→target name transform ourselves in step 2.
          rename_options: JSON.stringify({ rename_strategy: "NO_RENAME" }),
        };

        let copiedAdId: string;
        try {
          const copyResp = await metaApiClient.postForm<{ copied_ad_id?: string; id?: string }>(
            `/${validateMetaId(sourceAd.id, "ad")}/copies`,
            copyBody,
            { accountId: accountPath },
          );
          const id = copyResp.copied_ad_id ?? copyResp.id;
          if (!id) throw new Error("Meta /copies returned no copied ad id.");
          copiedAdId = String(id);
        } catch (err) {
          // Skip-and-continue: one ad's failure must not abort the bundle.
          const msg = err instanceof Error ? err.message : String(err);
          skipped.push({ source_ad_id: sourceAd.id, name: plannedName, reason: `Copy failed: ${msg}` });
          warnings.push(`Ad ${sourceAd.id} could not be copied: ${msg}`);
          continue;
        }
        createdResources.adIds.push(copiedAdId);
        if (cacheKey) await store.update(cacheKey, { createdResources });

        // 2. Apply the source→target name transform (skip when unchanged).
        if (plannedName !== sourceAd.name) {
          try {
            await metaApiClient.postForm<{ success?: boolean }>(
              `/${copiedAdId}`,
              { name: plannedName },
              { accountId: accountPath },
            );
          } catch (err) {
            warnings.push(`Copied ad ${copiedAdId} could not be renamed to "${plannedName}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 3. Apply a creative override by swapping a modified creative onto the
        //    copied ad. Built from the real source spec so all media is reused.
        let creativeId: string | undefined;
        if (strategy === "swap" && plan.sourceCreative && plan.override) {
          try {
            const patched = buildPatchedObjectStorySpec(plan.sourceCreative, plan.override);
            if (!patched) throw new Error("source creative has no patchable object_story_spec.");
            const newCreative = await metaApiClient.postForm<{ id: string }>(
              `/${accountPath}/adcreatives`,
              { name: plan.override.name ?? plannedName, object_story_spec: JSON.stringify(patched) },
            );
            createdResources.creativeIds.push(newCreative.id);
            if (cacheKey) await store.update(cacheKey, { createdResources });
            await metaApiClient.postForm<{ success?: boolean }>(
              `/${copiedAdId}`,
              { creative: JSON.stringify({ creative_id: newCreative.id }) },
              { accountId: accountPath },
            );
            creativeId = newCreative.id;
            result.created_creatives.push({
              id: newCreative.id,
              name: plan.override.name ?? plannedName,
              source_ad_id: sourceAd.id,
              source_creative_id: plan.sourceCreativeId,
              status: targetStatus,
            });
          } catch (err) {
            // The ad is already copied with its original creative — degrade to a
            // warning rather than dropping the ad.
            warnings.push(`Override could not be applied to copied ad ${copiedAdId}: ${err instanceof Error ? err.message : String(err)}. Ad copied with its original creative.`);
          }
        } else if (strategy === "warn_override_ignored") {
          warnings.push(`Override for ad ${sourceAd.id} was not applied (${describeIgnoredOverrideReason(plan.sourceCreative)}); copied as ${copiedAdId} unchanged. Edit the copied ad manually if needed.`);
        }

        result.created_ads.push({
          id: copiedAdId,
          name: plannedName,
          ad_set_id: newAdSet.id,
          creative_id: creativeId,
          source_ad_id: sourceAd.id,
          source_creative_id: plan.sourceCreativeId,
          status: targetStatus,
        });
      }

      // Every copy failed — the ad set exists but is empty. Mark failed so the
      // operator cleans it up, mirroring the original all-or-nothing safety.
      if (result.created_ads.length === 0) {
        const err = new Error(`ads_clone_ad_set_bundle: every ad copy failed for source ad set ${sourceAdSetIdValidated} (partial state: ad_set=${newAdSet.id}, ads=[]). Skipped: ${JSON.stringify(skipped)}`);
        await markFailed(err);
        throw err;
      }

      if (cacheKey) {
        await store.update(cacheKey, {
          state: "completed",
          completedAt: Date.now(),
          result,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Bundle cloned!\nAd Set: ${target_ad_set.name} (${result.new_ad_set.id})\nAds copied: ${result.created_ads.length}\nOverrides swapped: ${result.created_creatives.length}\nWarnings: ${result.warnings.length}\nSkipped (copy failed): ${result.skipped.length}`,
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_create_ad_set",
    {
      description: `${WRITE_WARNING}Create a new ad set within a campaign. Requires targeting specification, optimization goal, budget, and destination_type (required for ODAX campaigns). Common destination_type values: WEBSITE (traffic/sales to website), APP (app installs), MESSENGER/WHATSAPP/INSTAGRAM_DIRECT (messaging), ON_AD (lead forms, instant experiences). Ad sets are created in PAUSED status by default.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        campaign_id: z.string().describe("Parent campaign ID"),
        name: z.string().min(1).describe("Ad set name"),
        destination_type: destinationTypeEnum.describe("Where the ad traffic is directed. Required for ODAX campaigns. Common values: WEBSITE (website traffic/conversions), APP (app installs), MESSENGER (Messenger conversations), WHATSAPP (WhatsApp conversations), INSTAGRAM_DIRECT (Instagram DMs), ON_AD (lead forms, instant experiences, post engagement), ON_VIDEO (video views), ON_PAGE (page engagement), SHOP_AUTOMATIC (shop)"),
        status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
        daily_budget: z.number().optional().describe("Daily budget in cents (e.g., 2000 = $20.00)"),
        lifetime_budget: z.number().optional().describe("Lifetime budget in cents"),
        optimization_goal: optimizationGoalEnum.describe("Optimization goal"),
        billing_event: billingEventEnum.default("IMPRESSIONS"),
        bid_amount: z.number().optional().describe("Bid cap in cents"),
        bid_strategy: bidStrategyEnum.optional(),
        targeting: targetingSchema,
        start_time: z.string().optional().describe("ISO 8601 start time"),
        end_time: z.string().optional().describe("ISO 8601 end time (required for lifetime_budget)"),
        promoted_object: z.record(z.unknown()).optional().describe("Promoted object (e.g., { page_id: '123' } or { pixel_id: '456', custom_event_type: 'PURCHASE' })"),
      },
      annotations: { ...CREATE },
    },
    async ({
      account_id, campaign_id, name, destination_type, status, daily_budget, lifetime_budget,
      optimization_goal, billing_event, bid_amount, bid_strategy, targeting,
      start_time, end_time, promoted_object,
    }) => {
      const accountPath = normalizeAccountId(account_id);
      const campaignIdValidated = validateMetaId(campaign_id, "campaign");

      const body: Record<string, string | number | boolean> = {
        campaign_id: campaignIdValidated,
        name,
        destination_type,
        status,
        optimization_goal,
        billing_event,
        targeting: JSON.stringify(targeting),
      };

      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (bid_amount !== undefined) body.bid_amount = String(bid_amount);
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (start_time) body.start_time = start_time;
      if (end_time) body.end_time = end_time;
      if (promoted_object) body.promoted_object = JSON.stringify(promoted_object);

      const result = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/adsets`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad set created successfully!\nID: ${result.id}\nName: ${name}\nCampaign: ${campaignIdValidated}\nStatus: ${status}\nOptimization: ${optimization_goal}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_update_ad_set",
    {
      description: `${WRITE_WARNING}Update an existing ad set in place. Common use cases: change daily_budget or lifetime_budget (values in cents — e.g., 2000 = $20.00), pause/reactivate via status (ACTIVE/PAUSED), extend end_time, replace targeting, adjust bid_amount/bid_strategy, or rename. Only the fields you pass are sent to Meta — omitted fields keep their current value. lifetime_budget requires a corresponding end_time on the ad set. Authentication is handled transparently: the active Meta token is resolved from the request context (Sign in with Meta OAuth, registered System User token, or X-Meta-Token header in service-to-service mode). Note that meaningful changes to bid_amount, bid_strategy, or targeting can re-trigger Meta's learning phase.`,
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID to update"),
        name: z.string().optional().describe("New ad set name"),
        status: statusEnum.optional().describe("New status. Use ACTIVE to start delivery, PAUSED to stop, ARCHIVED to retire. Use ads_delete_ad_set for soft-deletion."),
        destination_type: destinationTypeEnum.optional().describe("Where the ad traffic is directed. Common values: WEBSITE (website traffic/conversions), APP (app installs), MESSENGER (Messenger conversations), WHATSAPP (WhatsApp conversations), INSTAGRAM_DIRECT (Instagram DMs), ON_AD (lead forms, instant experiences, post engagement), ON_VIDEO (video views), ON_PAGE (page engagement), SHOP_AUTOMATIC (shop)"),
        daily_budget: z.number().optional().describe("Daily budget in cents (e.g., 2000 = $20.00). Mutually exclusive with lifetime_budget."),
        lifetime_budget: z.number().optional().describe("Lifetime budget in cents. Requires the ad set to have an end_time set; pass end_time in the same call if it isn't already configured."),
        targeting: targetingSchema.optional().describe("Replacement targeting spec. Replaces the entire targeting object — pass the full spec, not a partial one."),
        bid_amount: z.number().optional().describe("Bid cap in cents. Only meaningful with bid_strategy = LOWEST_COST_WITH_BID_CAP or COST_CAP."),
        bid_strategy: bidStrategyEnum.optional().describe("Bidding strategy. Changing strategy may require corresponding changes to bid_amount."),
        end_time: z.string().optional().describe("ISO 8601 end time. Required when setting or keeping lifetime_budget."),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_set_id, name, status, destination_type, daily_budget, lifetime_budget, targeting, bid_amount, bid_strategy, end_time }) => {
      const id = validateMetaId(ad_set_id, "adset");
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (destination_type !== undefined) body.destination_type = destination_type;
      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (targeting !== undefined) body.targeting = JSON.stringify(targeting);
      if (bid_amount !== undefined) body.bid_amount = String(bid_amount);
      if (bid_strategy !== undefined) body.bid_strategy = bid_strategy;
      if (end_time !== undefined) body.end_time = end_time;

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      return {
        content: [
          { type: "text", text: `Ad set ${id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Delete Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_delete_ad_set",
    {
      description: `${WRITE_WARNING}Delete an ad set (soft delete — sets status to DELETED).`,
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ ad_set_id }) => {
      const id = validateMetaId(ad_set_id, "adset");
      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad set ${id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
