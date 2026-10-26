import { metaApiClient } from "./client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { DEPRECATED_FEATURES } from "./creative-spec.js";
import type { Ad, AdCreative } from "./types/index.js";

// Meta creatives are immutable except for name/status/adlabels, so changing
// anything else means minting a replacement creative and pointing the ad at it.
// The ad keeps its ID and history, and goes back through review.

export const CREATIVE_REBUILD_FIELDS =
  "id,name,object_story_spec,asset_feed_spec,effective_object_story_id,url_tags,instagram_user_id,source_instagram_media_id,effective_instagram_media_id,link_url,degrees_of_freedom_spec,destination_spec,wamo_whatsapp_identity_spec,call_to_action_type,adlabels,contextual_multi_ads";

// asset_feed_spec keys that hold ad content. A feed with none of them (some
// carousels report only promotional_metadata) does not change what the ad
// shows, so the creative can be rebuilt as if it had no feed.
const FEED_CONTENT_KEYS = [
  "bodies", "titles", "descriptions", "images", "videos", "link_urls", "call_to_action_types",
  "call_to_actions", "ad_formats", "carousels", "audios", "optimization_type", "asset_customization_rules",
] as const;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasFeedContent(creative: AdCreative): boolean {
  const feed = asRecord(creative.asset_feed_spec);
  return Boolean(feed && FEED_CONTENT_KEYS.some((key) => key in feed));
}

export function resolveInstagramUserId(creative: AdCreative): string | undefined {
  if (creative.instagram_user_id) return creative.instagram_user_id;
  const embedded = asRecord(creative.object_story_spec)?.["instagram_user_id"];
  return typeof embedded === "string" ? embedded : undefined;
}

// Creatives built before v22.0 still report standard_enhancements, which Meta
// now rejects in any form (subcode 3858504), so a replacement must drop it.
export function cleanDegreesOfFreedomSpec(
  spec: Record<string, unknown> | undefined,
): { spec?: Record<string, unknown>; dropped: string[] } {
  if (!spec) return { dropped: [] };
  const features = asRecord(spec.creative_features_spec);
  if (!features) return { spec, dropped: [] };
  const dropped = Object.keys(features).filter((name) => (DEPRECATED_FEATURES as readonly string[]).includes(name));
  if (dropped.length === 0) return { spec, dropped };
  const kept = Object.fromEntries(Object.entries(features).filter(([name]) => !dropped.includes(name)));
  return { spec: { ...spec, creative_features_spec: kept }, dropped };
}

// Fields that live beside the story/spec rather than inside it, carried onto
// every replacement so a rebuild changes only what was asked.
export function carryOverFields(creative: AdCreative): { body: Record<string, string>; warnings: string[] } {
  const body: Record<string, string> = {};
  const warnings: string[] = [];

  // link_url is a creatable destination override, and dropping
  // degrees_of_freedom_spec would silently reset the ad's Advantage+ creative
  // settings.
  if (creative.link_url) body.link_url = creative.link_url;
  const dof = cleanDegreesOfFreedomSpec(creative.degrees_of_freedom_spec);
  if (dof.spec) body.degrees_of_freedom_spec = JSON.stringify(dof.spec);
  if (dof.dropped.length > 0) {
    warnings.push(`Dropped ${dof.dropped.join(", ")} from creative ${creative.id}'s Advantage+ settings: Meta rejects it since v22.0. Its other feature settings are kept.`);
  }
  // Since Marketing API v26.0 a creative created without destination_spec
  // defaults to Website and Shop for advertisers with a shop.
  if (creative.destination_spec) body.destination_spec = JSON.stringify(creative.destination_spec);
  // Since v26.0 Meta no longer defaults the WhatsApp identity for third-party
  // callers, so a replacement without it leaves WhatsApp Status delivery.
  if (creative.wamo_whatsapp_identity_spec) {
    body.wamo_whatsapp_identity_spec = JSON.stringify(creative.wamo_whatsapp_identity_spec);
  }
  const multiAdvertiser = asRecord((creative as AdCreative & { contextual_multi_ads?: unknown }).contextual_multi_ads);
  if (multiAdvertiser) body.contextual_multi_ads = JSON.stringify(multiAdvertiser);
  // Agencies key reporting and automations off ad labels; a replacement without
  // them drops out of those views silently.
  const adlabels = (creative.adlabels ?? [])
    .map((label) => (label.id ? { id: label.id } : label.name ? { name: label.name } : undefined))
    .filter((label): label is { id: string } | { name: string } => label !== undefined);
  if (adlabels.length > 0) body.adlabels = JSON.stringify(adlabels);

  return { body, warnings };
}

export interface CreativeGroup {
  creative_id: string;
  account_id: string;
  ad_ids: string[];
}

export interface FailedAd {
  ad_id: string;
  error: string;
  new_creative_id?: string;
}

export interface UpdatedAd {
  ad_id: string;
  old_creative_id: string;
  new_creative_id: string;
}

// Reads each ad's creative and groups ads that share one, so each shared
// creative gets a single replacement.
export async function groupAdsByCreative(
  adIds: string[],
): Promise<{ groups: CreativeGroup[]; failed: FailedAd[] }> {
  const groups = new Map<string, CreativeGroup>();
  const failed: FailedAd[] = [];
  for (const rawAdId of new Set(adIds)) {
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
      const group = groups.get(ad.creative.id);
      if (group) group.ad_ids.push(adId);
      else groups.set(ad.creative.id, { creative_id: ad.creative.id, account_id: ad.account_id, ad_ids: [adId] });
    } catch (err) {
      failed.push({ ad_id: rawAdId, error: errorMessage(err) });
    }
  }
  return { groups: [...groups.values()], failed };
}

export async function readCreativeForRebuild(creativeId: string): Promise<AdCreative> {
  return metaApiClient.get<AdCreative>(`/${validateMetaId(creativeId, "creative")}`, {
    fields: CREATIVE_REBUILD_FIELDS,
  });
}

export async function createReplacementCreative(accountId: string, body: Record<string, string>): Promise<string> {
  const created = await metaApiClient.postForm<{ id: string }>(`/${normalizeAccountId(accountId)}/adcreatives`, body);
  return created.id;
}

async function readCreativeIdAfterFailedRepoint(adId: string): Promise<string | undefined> {
  try {
    const ad = await metaApiClient.get<Ad>(`/${adId}`, { fields: "creative{id}" });
    return ad.creative?.id;
  } catch {
    return undefined;
  }
}

// Points every ad of a group at the replacement. A write may reach Meta with
// only its response lost, so a failed repoint is read back before the ad is
// reported as untouched.
export async function repointGroup(
  group: CreativeGroup,
  newCreativeId: string,
): Promise<{ updated: UpdatedAd[]; failed: FailedAd[]; warnings: string[] }> {
  const updated: UpdatedAd[] = [];
  const failed: FailedAd[] = [];
  const warnings: string[] = [];
  for (const adId of group.ad_ids) {
    try {
      await metaApiClient.postForm<{ success: boolean }>(
        `/${adId}`,
        { creative: JSON.stringify({ creative_id: newCreativeId }) },
        { accountId: normalizeAccountId(group.account_id) },
      );
      updated.push({ ad_id: adId, old_creative_id: group.creative_id, new_creative_id: newCreativeId });
    } catch (err) {
      const outcome = await readCreativeIdAfterFailedRepoint(adId);
      if (outcome === newCreativeId) {
        updated.push({ ad_id: adId, old_creative_id: group.creative_id, new_creative_id: newCreativeId });
        warnings.push(`Ad ${adId} reported an error (${errorMessage(err)}) but is confirmed to point at creative ${newCreativeId}.`);
        continue;
      }
      const state = outcome === undefined
        ? "the ad's creative could not be read back, so its state is unknown"
        : `the ad still points at ${outcome}`;
      failed.push({
        ad_id: adId,
        error: `Creative ${newCreativeId} was created but ${state}: ${errorMessage(err)}. Retry with ads_update_ad { ad_id: "${adId}", creative_id: "${newCreativeId}" }.`,
        new_creative_id: newCreativeId,
      });
    }
  }
  return { updated, failed, warnings };
}
