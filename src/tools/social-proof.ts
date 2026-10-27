import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { errorMessage, hasFeedContent } from "../meta/creative-rebuild.js";
import { wasRefused } from "../meta/errors.js";
import { readEngagement } from "../meta/post-engagement.js";
import type { AdCreative } from "../meta/types/index.js";
import { getCloneBundleStore, type CloneBundleRecord } from "../store/clone-bundle-store.js";
import { isMetaId, normalizeAccountId } from "../utils/format.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { applyAttributionDefault, enforceInsightsGuardrails } from "./insights-guardrails.js";
import { CREATE, READ, WRITE_WARNING } from "./_register.js";

// Meta offers no filter for the ads on a post, so finding the others means
// reading the account's ads, as route B of ads_update_ad_content does.
const MAX_SCANNED_ADS = 5000;
const MAX_INSTAGRAM_READS = 100;
const INSIGHTS_BATCH = 50;
// Ads found after a lost answer are those created from this long before the
// run started, so a clock skew between this server and Meta cannot hide one.
const CLOCK_SKEW_MS = 60_000;
const NUMERIC_ID = /^\d+$/;
const STATUS = /^[A-Z_]+$/;

interface AdRead {
  id: string;
  account_id?: string;
  name?: string;
  status?: string;
  creative?: { id?: string; effective_object_story_id?: string; effective_instagram_media_id?: string };
}

const AD_POST_FIELDS = "id,name,status,creative{id,effective_object_story_id,effective_instagram_media_id}";

// IDs in Meta's answers still reach a path or the JSON block only in an ID's shape.
const numericOrUndefined = (value: unknown) => (typeof value === "string" && NUMERIC_ID.test(value) ? value : undefined);
const metaIdOrUndefined = (value: unknown) => (isMetaId(value) ? value : undefined);
const postOf = (ad: AdRead) => metaIdOrUndefined(ad.creative?.effective_object_story_id);
const mediaOf = (ad: AdRead) => metaIdOrUndefined(ad.creative?.effective_instagram_media_id);

interface AdEngagement {
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
}

const ENGAGEMENT_ACTIONS: Record<string, keyof AdEngagement> = {
  post_reaction: "reactions",
  comment: "comments",
  post: "shares",
  "onsite_conversion.post_save": "saves",
};

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function reply(lines: string[], notes: string[], json: unknown) {
  const text = notes.length > 0
    ? [...lines, "", "Meta's answers:", ADVERTISER_CONTENT_OPEN, ...notes.map((note) => `• ${singleLine(note, 400)}`), ADVERTISER_CONTENT_CLOSE]
    : lines;
  return {
    content: [
      { type: "text" as const, text: text.join("\n") },
      { type: "text" as const, text: JSON.stringify(json, null, 2) },
    ],
  };
}

// Each ad's own lifetime engagement, from one insights call per batch of ads.
// It counts what people did on that ad, wherever it showed: unlike the post's
// counts it needs no Page permission.
async function readAdEngagement(accountId: string, adIds: string[]): Promise<Map<string, AdEngagement>> {
  const byAd = new Map<string, AdEngagement>();
  enforceInsightsGuardrails({ level: "ad", date_preset: "maximum" });
  for (let i = 0; i < adIds.length; i += INSIGHTS_BATCH) {
    const batch = adIds.slice(i, i + INSIGHTS_BATCH);
    const params: Record<string, string | number | boolean> = {
      level: "ad",
      date_preset: "maximum",
      fields: "ad_id,actions",
      filtering: JSON.stringify([{ field: "ad.id", operator: "IN", value: batch }]),
      limit: INSIGHTS_BATCH,
    };
    applyAttributionDefault(params, undefined);
    const rows = await metaApiClient.getPaginated<{ ad_id?: string; actions?: Array<{ action_type?: string; value?: string }> }>(
      `/${normalizeAccountId(accountId)}/insights`, params, batch.length,
    );
    for (const id of batch) byAd.set(id, { reactions: 0, comments: 0, shares: 0, saves: 0 });
    for (const row of rows) {
      const engagement = row.ad_id ? byAd.get(row.ad_id) : undefined;
      if (!engagement) continue;
      for (const action of row.actions ?? []) {
        const key = action.action_type ? ENGAGEMENT_ACTIONS[action.action_type] : undefined;
        const value = Number(action.value ?? 0);
        if (key) engagement[key] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
      }
    }
  }
  return byAd;
}

interface FailedAdSet {
  ad_set_id: string;
  kind: "unreadable" | "other_account" | "refused" | "unconfirmed";
  candidate_ad_ids?: string[];
}

// After a create whose answer was lost, the ad sets's ads that this run may
// have made: on the source's creative, or copied from the source ad, created
// since it started. Another run can make the same, so these are only
// candidates; none is ever reported or changed as this run's own.
async function findCandidates(
  adSetId: string,
  match: (ad: { creative?: { id?: string }; source_ad_id?: string }) => boolean,
  since: number,
  known: Set<string>,
): Promise<string[]> {
  const ads = await metaApiClient.getPaginated<{ id: string; created_time?: string; source_ad_id?: string; creative?: { id?: string } }>(
    `/${adSetId}/ads`, { fields: "id,created_time,source_ad_id,creative{id}", limit: 200 }, 1000,
  );
  return ads
    .filter((ad) => numericOrUndefined(ad.id) && !known.has(ad.id) && match(ad) && Date.parse(ad.created_time ?? "") >= since - CLOCK_SKEW_MS)
    .sort((a, b) => Date.parse(b.created_time ?? "") - Date.parse(a.created_time ?? ""))
    .map((ad) => ad.id);
}

export function registerSocialProofTools(server: McpServer, deps: { maxScannedAds?: number } = {}): void {
  const maxScannedAds = deps.maxScannedAds ?? MAX_SCANNED_ADS;

  server.registerTool(
    "ads_duplicate_ad",
    {
      description: `${WRITE_WARNING}Copy an ad into one or more ad sets of its account, keeping its likes, comments and shares. By default every copy uses the source ad's own creative, so it shows the same Facebook post and the same Instagram media, and every text option comes along (measured on v26.0). Each copy also carries the source's tracking specs, conversion domain and ad labels. With keep_social_proof: false, Meta's own ad copy gives each copy a creative and post of its own, starting from zero. Copies are created PAUSED unless status says otherwise. A real run needs an idempotency_key: the same key and payload return the first run's result instead of creating again, and a key whose run did not finish is never run again. Creating copies needs the server's Firestore store, which keeps that record across restarts; without it only dry_run works. When Meta's answer to a create is lost, the ad set is reported unconfirmed, with any ad that may be the copy as a candidate: list that ad set's ads before running again. To read the social proof itself, use ads_get_ad_social_proof.`,
      inputSchema: {
        ad_id: z.string().describe("The ad to copy"),
        ad_set_ids: z.array(z.string()).min(1).max(20).describe("Ad sets of the source ad's account to put one copy in each"),
        name: z.string().min(1).max(400).optional().describe("Name of every copy. Defaults to the source ad's name"),
        status: z.enum(["PAUSED", "ACTIVE"]).default("PAUSED").describe("Status of the copies. ACTIVE spends as soon as the ad set runs"),
        keep_social_proof: z.boolean().default(true).describe("true: copies share the source's post and Instagram media. false: Meta copies the ad with a new post, which starts from zero"),
        dry_run: z.boolean().default(false).describe("Read and check everything without creating anything"),
        idempotency_key: z.string().min(1).max(200).optional().describe("Required unless dry_run. Running again with the same key and payload returns the first result instead of creating copies again"),
      },
      annotations: { ...CREATE },
    },
    async ({ ad_id, ad_set_ids, name, status = "PAUSED", keep_social_proof = true, dry_run = false, idempotency_key }) => {
      // Malformed input is named by its position and never repeated, so it
      // cannot reach the reply as framing.
      if (!NUMERIC_ID.test(ad_id)) throw new Error("ad_id is not an ad ID: ad IDs are numeric.");
      const badSet = ad_set_ids.findIndex((id) => !NUMERIC_ID.test(id));
      if (badSet !== -1) throw new Error(`ad_set_ids[${badSet}] is not an ad set ID: ad set IDs are numeric.`);
      if (!dry_run && !idempotency_key) throw new Error("idempotency_key is required when dry_run is false.");
      const store = getCloneBundleStore();
      // A record kept in memory is gone after a restart, and is not seen by
      // other instances: the same key could then create the copies again.
      if (!dry_run && !store.persistent) {
        throw new Error("ads_duplicate_ad creates copies only on a server with its Firestore store, which keeps the idempotency record across restarts and instances. Run it with dry_run: true, or create each copy with ads_create_ad and the source ad's creative_id.");
      }
      const adId = ad_id;
      const adSetIds = unique(ad_set_ids);
      const notes: string[] = [];

      // The source is read with the caller's token before anything else, an
      // earlier run's result included: only someone who reaches the ad, and
      // so its account, gets the IDs created there.
      let source: AdRead & { tracking_specs?: unknown[]; conversion_domain?: string; adlabels?: Array<{ id?: string; name?: string }> };
      let accountPath: string;
      try {
        source = await metaApiClient.get(`/${adId}`, { fields: "name,account_id,status,creative{id},tracking_specs,conversion_domain,adlabels" });
        accountPath = normalizeAccountId(String(source.account_id ?? ""));
      } catch (err) {
        notes.push(`Ad ${adId}: ${errorMessage(err)}`);
        return reply([`Ad ${adId} could not be read with this token, so nothing was created.`], notes, { dry_run, error: "source_unreadable" });
      }
      const creativeId = numericOrUndefined(source.creative?.id);
      if (!creativeId) return reply([`Ad ${adId} has no creative to copy, so nothing was created.`], notes, { dry_run, error: "source_without_creative" });

      const signature = JSON.stringify({ ad_id: adId, ad_set_ids: adSetIds, name: name ?? null, status, keep_social_proof });
      // "|" and an encoded key keep these records apart from
      // ads_clone_ad_set_bundle's, which share the store and use ":".
      const cacheKey = idempotency_key ? ["ads_duplicate_ad", accountPath, adId, encodeURIComponent(idempotency_key)].join("|") : undefined;
      // A run that did not finish may have created copies its record never
      // got, so its key is never run again, however old the run.
      const earlierRun = (existing: CloneBundleRecord) => {
        if (existing.signature !== signature) throw new Error("idempotency_key already used for a different ads_duplicate_ad payload.");
        if (existing.state === "completed" && existing.result) {
          return reply(["ads_duplicate_ad: an earlier run used this idempotency_key with the same payload. Nothing was created now; its result is below."], [], existing.result);
        }
        const recorded = existing.createdResources.adIds.filter((id) => NUMERIC_ID.test(id));
        throw new Error(`An earlier ads_duplicate_ad run with this idempotency_key is still running or did not finish${recorded.length > 0 ? `, after creating ads ${recorded.join(", ")}` : ""}. It may have created copies its record never got: list the ads of ad sets ${adSetIds.join(", ")} with ads_get_ads, then run again with a new idempotency_key for the ad sets still without a copy.`);
      };
      if (cacheKey && !dry_run) {
        const existing = await store.getDoc(cacheKey);
        if (existing) return earlierRun(existing);
      }

      let creative: AdCreative;
      try {
        creative = await metaApiClient.get<AdCreative>(`/${creativeId}`, { fields: "effective_object_story_id,effective_instagram_media_id,asset_feed_spec" });
      } catch (err) {
        notes.push(`Creative ${creativeId}: ${errorMessage(err)}`);
        return reply([`The creative of ad ${adId} could not be read, so nothing was created.`], notes, { dry_run, error: "creative_unreadable" });
      }
      const textOptions = hasFeedContent(creative);
      const sourcePost = metaIdOrUndefined(creative.effective_object_story_id);

      const failed: FailedAdSet[] = [];
      const eligible: string[] = [];
      for (const adSetId of adSetIds) {
        try {
          const adSet = await metaApiClient.get<{ account_id?: string }>(`/${adSetId}`, { fields: "account_id" });
          if (adSet.account_id && normalizeAccountId(adSet.account_id) === accountPath) eligible.push(adSetId);
          else failed.push({ ad_set_id: adSetId, kind: "other_account" });
        } catch (err) {
          failed.push({ ad_set_id: adSetId, kind: "unreadable" });
          notes.push(`Ad set ${adSetId}: ${errorMessage(err)}`);
        }
      }

      const report: Record<string, unknown> = {
        dry_run,
        keep_social_proof,
        source: {
          ad_id: adId,
          creative_id: creativeId,
          post_id: sourcePost ?? null,
          instagram_media_id: metaIdOrUndefined(creative.effective_instagram_media_id) ?? null,
          text_options: textOptions,
        },
        social_proof: keep_social_proof ? { facebook: "kept", instagram: "kept" } : { facebook: "new", instagram: "new" },
      };
      const created: Array<{ ad_set_id: string; ad_id: string }> = [];
      const notAttempted: string[] = [];
      let recordSaved = true;

      if (!dry_run) {
        const startedAt = Date.now();
        const createdResources = { creativeIds: [] as string[], adIds: [] as string[] };
        if (cacheKey) {
          const claim = await store.claim(cacheKey, signature, { reclaimStale: false });
          if (claim.status === "duplicate") return earlierRun(claim.existing!);
        }

        const optionalFields: Record<string, string> = {};
        if (Array.isArray(source.tracking_specs) && source.tracking_specs.length > 0) {
          optionalFields.tracking_specs = JSON.stringify(source.tracking_specs);
        }
        if (source.conversion_domain) optionalFields.conversion_domain = source.conversion_domain;
        const labels = (source.adlabels ?? [])
          .map((label) => (label.id ? { id: label.id } : label.name ? { name: label.name } : undefined))
          .filter((label) => label !== undefined);
        if (labels.length > 0) optionalFields.adlabels = JSON.stringify(labels);

        for (const adSetId of eligible) {
          // The record of what this run made is what keeps a retry from making
          // it twice, so a run whose record cannot be saved stops creating.
          if (!recordSaved) {
            notAttempted.push(adSetId);
            continue;
          }
          let newAdId: string;
          try {
            let answered: unknown;
            if (keep_social_proof) {
              const result = await metaApiClient.postForm<{ id?: unknown }>(`/${accountPath}/ads`, {
                name: name ?? source.name ?? `Copy of ${adId}`,
                adset_id: adSetId,
                creative: JSON.stringify({ creative_id: creativeId }),
                status,
                ...optionalFields,
              });
              answered = result.id;
            } else {
              const result = await metaApiClient.postForm<{ copied_ad_id?: unknown; id?: unknown }>(`/${adId}/copies`, {
                adset_id: adSetId,
                status_option: status,
                rename_options: JSON.stringify({ rename_strategy: "NO_RENAME" }),
              }, { accountId: accountPath });
              answered = result.copied_ad_id ?? result.id;
            }
            // A number past 2^53 has already been rounded by JSON.parse.
            const id = numericOrUndefined(typeof answered === "number" && Number.isSafeInteger(answered) ? String(answered) : answered);
            if (!id) throw new Error("Meta's answer did not name the new ad.");
            newAdId = id;
          } catch (err) {
            if (wasRefused(err)) {
              failed.push({ ad_set_id: adSetId, kind: "refused" });
              notes.push(`Ad set ${adSetId}: ${errorMessage(err)}`);
              continue;
            }
            let candidates: string[] = [];
            try {
              candidates = await findCandidates(
                adSetId,
                (ad) => (keep_social_proof ? ad.creative?.id === creativeId : ad.source_ad_id === adId),
                startedAt,
                new Set([adId, ...createdResources.adIds]),
              );
            } catch (readErr) {
              notes.push(`Ad set ${adSetId}: its ads could not be read after the lost answer: ${errorMessage(readErr)}`);
            }
            failed.push({ ad_set_id: adSetId, kind: "unconfirmed", candidate_ad_ids: candidates });
            notes.push(`Ad set ${adSetId}: no usable answer from Meta (${errorMessage(err)}).`);
            continue;
          }

          created.push({ ad_set_id: adSetId, ad_id: newAdId });
          createdResources.adIds.push(newAdId);
          if (cacheKey) {
            try {
              await store.update(cacheKey, { createdResources });
            } catch {
              recordSaved = false;
            }
          }
          if (!keep_social_proof && name !== undefined && name !== source.name) {
            try {
              await metaApiClient.postForm(`/${newAdId}`, { name });
            } catch (err) {
              notes.push(`Ad ${newAdId} keeps the source's name: renaming it failed (${errorMessage(err)}).`);
            }
          }
        }

        report.created = created;
        report.failed = failed;
        report.not_attempted = notAttempted;
        if (cacheKey && recordSaved) {
          try {
            await store.update(cacheKey, { state: "completed", completedAt: Date.now(), result: { ...report, record_saved: true }, createdResources });
          } catch {
            recordSaved = false;
          }
        }
        report.record_saved = recordSaved;
      } else {
        report.planned_ad_set_ids = eligible;
        report.failed = failed;
      }

      const lines: string[] = [];
      lines.push(dry_run
        ? `Dry run: would copy ad ${adId} into ${count(eligible.length, "ad set", "ad sets")} (${status}). Nothing was created.`
        : `Copied ad ${adId} into ${created.length} of ${count(adSetIds.length, "ad set", "ad sets")} (${status}).`);
      if (keep_social_proof) {
        lines.push(`Each copy uses the source's own creative ${creativeId}: the same Facebook post and Instagram media, so they share its likes, comments and shares${textOptions ? ", and every text option comes along" : ""}.`);
        if (!sourcePost) lines.push("Meta has not made the source's post yet; the copies will show it once it exists.");
      } else {
        lines.push("Meta copies the ad with a creative and post of its own: likes, comments and shares start from zero on Facebook and Instagram. The new post appears within minutes.");
      }
      for (const c of created) lines.push(`• Ad set ${c.ad_set_id}: ad ${c.ad_id}`);
      for (const f of failed) {
        const why = {
          unreadable: "could not be read; nothing was created there",
          other_account: "belongs to another ad account, and a creative is used only in its own; nothing was created there",
          refused: "Meta refused the copy; nothing was created there",
          unconfirmed: `Meta's answer was lost, so the copy may or may not exist${f.candidate_ad_ids && f.candidate_ad_ids.length > 0 ? ` (ads made there since this run started: ${f.candidate_ad_ids.join(", ")})` : ""}. List the ad set's ads with ads_get_ads before running again`,
        }[f.kind];
        lines.push(`• Ad set ${f.ad_set_id}: ${why}.`);
      }
      if (!recordSaved) {
        lines.push(`The record of this run could not be saved, so it stopped${notAttempted.length > 0 ? ` before ad sets ${notAttempted.join(", ")}` : ""}. This idempotency_key cannot be used again: run what is left with a new one.`);
      }
      if (status === "ACTIVE" && created.length > 0) lines.push("The copies are ACTIVE: they spend as soon as their ad sets run.");
      return reply(lines, notes, report);
    },
  );

  server.registerTool(
    "ads_get_ad_social_proof",
    {
      description: `Likes, comments and shares behind ads, grouped by the post they show. For each ad: its Facebook post, its Instagram media, and its own reactions, comments, shares and saves since it started, from its insights. For each post: the post's Facebook counts (Meta returns them only with the pages_read_user_content permission), the likes and comments of each Instagram media showing it, and which other ads of the account show the same post (find_other_ads reads the account's ads, up to ${MAX_SCANNED_ADS.toLocaleString("en-US")}). Use it before changing the copy of live ads, or to pick the post to duplicate with ads_duplicate_ad.`,
      inputSchema: {
        ad_ids: z.array(z.string()).min(1).max(50).describe("Ads to read"),
        find_other_ads: z.boolean().default(true).describe("Read the account's ads to list every ad showing the same posts"),
      },
      annotations: { ...READ },
    },
    async ({ ad_ids, find_other_ads = true }) => {
      const badAd = ad_ids.findIndex((id) => !NUMERIC_ID.test(id));
      if (badAd !== -1) throw new Error(`ad_ids[${badAd}] is not an ad ID: ad IDs are numeric.`);
      const failed: Array<{ ad_id: string }> = [];
      const notes: string[] = [];
      const ads: Array<AdRead & { account: string }> = [];
      for (const id of unique(ad_ids)) {
        try {
          const ad = await metaApiClient.get<AdRead>(`/${id}`, { fields: `account_id,${AD_POST_FIELDS}` });
          ads.push({ ...ad, id, account: normalizeAccountId(String(ad.account_id ?? "")) });
        } catch (err) {
          failed.push({ ad_id: id });
          notes.push(`Ad ${id}: ${errorMessage(err)}`);
        }
      }

      const withPost = ads.filter((ad) => postOf(ad));
      const postIds = unique(withPost.map((ad) => postOf(ad)!));
      const others = new Map<string, AdRead[]>(postIds.map((post) => [post, []]));
      // Complete only when every account showing the post was read in full.
      const othersComplete = new Map<string, boolean>(postIds.map((post) => [post, find_other_ads]));
      if (find_other_ads) {
        const asked = new Set(ads.map((ad) => ad.id));
        for (const account of unique(withPost.map((ad) => ad.account))) {
          const accountPosts = new Set(withPost.filter((ad) => ad.account === account).map((ad) => postOf(ad)!));
          try {
            const scanned = await metaApiClient.getPaginated<AdRead>(`/${account}/ads`, { fields: AD_POST_FIELDS, limit: 500 }, maxScannedAds + 1);
            for (const ad of scanned.slice(0, maxScannedAds)) {
              const post = postOf(ad);
              if (post && accountPosts.has(post) && numericOrUndefined(ad.id) && !asked.has(ad.id)) others.get(post)!.push(ad);
            }
            if (scanned.length > maxScannedAds) for (const post of accountPosts) othersComplete.set(post, false);
          } catch (err) {
            for (const post of accountPosts) othersComplete.set(post, false);
            notes.push(`The ads of ${account} could not be listed: ${errorMessage(err)}`);
          }
        }
      }

      const adEngagement = new Map<string, AdEngagement>();
      for (const account of unique(ads.map((ad) => ad.account))) {
        try {
          const read = await readAdEngagement(account, ads.filter((ad) => ad.account === account).map((ad) => ad.id));
          for (const [id, engagement] of read) adEngagement.set(id, engagement);
        } catch (err) {
          notes.push(`The ads' own engagement in ${account} could not be read: ${errorMessage(err)}`);
        }
      }

      let instagramReads = 0;
      let facebookRefused = false;
      const posts = [];
      for (const postId of postIds) {
        const groupAds = [...withPost.filter((ad) => postOf(ad) === postId), ...others.get(postId)!];
        const facebook = await readEngagement(postId);
        if (!facebook.facebook) facebookRefused = true;
        notes.push(...facebook.notes.map((note) => `Post ${postId}: ${note}`));
        const media = new Map<string, string[]>();
        for (const ad of groupAds) {
          const mediaId = mediaOf(ad);
          if (mediaId) media.set(mediaId, [...(media.get(mediaId) ?? []), ad.id]);
        }
        const instagram = [];
        for (const [mediaId, mediaAds] of media) {
          if (instagramReads >= MAX_INSTAGRAM_READS) {
            instagram.push({ media_id: mediaId, likes: null, comments: null, unavailable: true, ad_ids: mediaAds });
            continue;
          }
          instagramReads++;
          const read = await readEngagement(undefined, mediaId);
          notes.push(...read.notes.map((note) => `Instagram media ${mediaId}: ${note}`));
          instagram.push({
            media_id: mediaId,
            likes: read.instagram?.likes ?? null,
            comments: read.instagram?.comments ?? null,
            unavailable: !read.instagram,
            ad_ids: mediaAds,
          });
        }
        posts.push({
          post_id: postId,
          facebook: facebook.facebook ?? null,
          facebook_unavailable: !facebook.facebook,
          instagram,
          ad_ids: groupAds.map((ad) => ad.id),
          other_ad_ids: others.get(postId)!.map((ad) => ad.id),
          others_complete: othersComplete.get(postId)!,
        });
      }

      const report = {
        posts,
        ads: withPost.map((ad) => ({
          ad_id: ad.id,
          status: typeof ad.status === "string" && STATUS.test(ad.status) ? ad.status : null,
          creative_id: numericOrUndefined(ad.creative?.id) ?? null,
          post_id: postOf(ad)!,
          instagram_media_id: mediaOf(ad) ?? null,
          ad_engagement: adEngagement.get(ad.id) ?? null,
        })),
        without_post: ads.filter((ad) => !postOf(ad)).map((ad) => ad.id),
        failed,
      };

      const lines: string[] = [`Social proof of ${count(ads.length, "ad", "ads")} on ${count(posts.length, "post", "posts")}.`];
      for (const post of posts) {
        lines.push("", `Post ${post.post_id}`);
        lines.push(post.facebook
          ? `  Facebook: ${count(post.facebook.reactions, "reaction", "reactions")}, ${count(post.facebook.comments, "comment", "comments")}, ${count(post.facebook.shares, "share", "shares")}`
          : "  Facebook: Meta did not return the post's counts (see its answer below).");
        for (const media of post.instagram) {
          lines.push(media.unavailable
            ? `  Instagram media ${media.media_id} (ads ${media.ad_ids.join(", ")}): not read`
            : `  Instagram media ${media.media_id} (ads ${media.ad_ids.join(", ")}): ${count(media.likes!, "like", "likes")}, ${count(media.comments!, "comment", "comments")}`);
        }
        const asked = post.ad_ids.filter((id) => !post.other_ad_ids.includes(id));
        lines.push(`  Ads showing it: ${asked.join(", ")} (asked)${post.other_ad_ids.length > 0 ? `; also ${post.other_ad_ids.join(", ")}` : ""}${find_other_ads && !post.others_complete ? " — other ads of the account could be missing from this list" : ""}`);
      }
      if (facebookRefused) {
        lines.push("", "Meta returns a Facebook post's reactions, comments and shares only to a token with the pages_read_user_content permission, which needs Meta's App Review. Each ad's own counts below need no Page permission.");
      }
      if (report.ads.length > 0) {
        lines.push("", "Each ad's own engagement since it started (its insights):");
        for (const ad of report.ads) {
          const e = ad.ad_engagement;
          lines.push(e
            ? `• Ad ${ad.ad_id}: ${count(e.reactions, "reaction", "reactions")}, ${count(e.comments, "comment", "comments")}, ${count(e.shares, "share", "shares")}, ${count(e.saves, "save", "saves")}`
            : `• Ad ${ad.ad_id}: not read`);
        }
      }
      if (report.without_post.length > 0) {
        lines.push("", `No post yet: ${report.without_post.join(", ")}. Meta makes an ad's post within minutes of its creation.`);
      }
      if (failed.length > 0) lines.push("", `Not read: ${failed.map((f) => f.ad_id).join(", ")}.`);
      const named = [...ads, ...[...others.values()].flat()].filter((ad) => ad.name);
      if (named.length > 0 || notes.length > 0) {
        lines.push("", ADVERTISER_CONTENT_OPEN);
        for (const ad of named) lines.push(`• Ad ${ad.id}: ${singleLine(ad.name, 200)}`);
        for (const note of notes) lines.push(`• ${singleLine(note, 400)}`);
        lines.push(ADVERTISER_CONTENT_CLOSE);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(report, null, 2) },
        ],
      };
    },
  );
}
