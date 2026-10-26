import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import {
  ctaEnum,
  headlineOptions,
  MAX_HEADLINE_LENGTH,
  MAX_TEXT_OPTIONS,
  resolveTextOptions,
  textOptions,
} from "./creatives.js";
import { buildFeatureSpec, buildStorySpec, FEATURE_NAME_PATTERN } from "../meta/creative-spec.js";
import { normalizeUrlTags } from "../utils/validation.js";
import { CREATE, WRITE_WARNING } from "./_register.js";

const POLL_INTERVAL_MS = 5000;
const MAX_VIDEOS_PER_CALL = 20;

// Cloud Run kills the request at 300s (--timeout=300 in deploy.yml). Finishing
// under that is what keeps already-created ad IDs in the response: losing them
// makes a retry create paid duplicates. A single Graph request can still take
// up to its own timeout, so these reserves keep headroom rather than pretending
// to be an exact clock.
const BATCH_BUDGET_MS = 180_000;
const ITEM_START_RESERVE_MS = 30_000;
const FINALIZE_RESERVE_MS = 15_000;

// A shared bad input (page_id, ad_set_id, creative option) fails every video the
// same way. Meta reports it per request, so the only signal is the repetition:
// stop rather than push 20 doomed uploads.
const REPEATED_FAILURE_LIMIT = 2;

interface VideoStatus {
  status?: { video_status?: string };
  thumbnails?: { data?: Array<{ uri?: string; is_preferred?: boolean }> };
}

type Stage = "upload" | "processing" | "creative" | "ad";

interface ItemResult {
  file_url: string;
  ad_name: string;
  video_id?: string;
  creative_id?: string;
  ad_id?: string;
  thumbnail_url?: string;
  skipped?: boolean;
  error?: string;
  failed_stage?: Stage;
  warnings?: string[];
}

class StageError extends Error {
  constructor(readonly stage: Stage, message: string) {
    super(message);
  }
}

/**
 * Meta errors that only condemn the current video (bad file, rejected params)
 * versus ones that condemn every remaining video (expired token, rate limit,
 * abuse signal, open circuit). Only the former may be isolated per item —
 * retrying the rest under a throttle or abuse signal makes the block worse.
 */
function isItemScopedError(err: unknown): boolean {
  if (err instanceof StageError || err instanceof UnsafeUrlError) return true;
  if (err instanceof McpError) return err.code === ErrorCode.InvalidParams;
  return false;
}

async function waitForVideoReady(videoId: string, maxWaitSeconds: number): Promise<VideoStatus> {
  const deadline = Date.now() + maxWaitSeconds * 1000;

  for (;;) {
    const video = await metaApiClient.get<VideoStatus>(`/${videoId}`, {
      fields: "status,thumbnails{uri,is_preferred}",
    });

    const videoStatus = video.status?.video_status;
    if (videoStatus === "ready") return video;

    if (videoStatus === "error") {
      throw new StageError("processing", `Meta reported a processing error for video ${videoId}.`);
    }

    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      throw new StageError(
        "processing",
        `Video ${videoId} was still "${videoStatus ?? "unknown"}" when the ${maxWaitSeconds}s processing budget ran out. The video is uploaded and keeps processing on Meta's side — finish it later with ads_create_ad_creative using this video_id.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function pickThumbnail(video: VideoStatus): string | undefined {
  const thumbs = video.thumbnails?.data ?? [];
  return (thumbs.find((t) => t.is_preferred) ?? thumbs[0])?.uri;
}

export function registerBulkAdTools(server: McpServer): void {
  server.registerTool(
    "ads_bulk_create_video_ads",
    {
      description: `${WRITE_WARNING}Turn a list of public video URLs into ads in one call: uploads each video, waits for Meta to finish processing, auto-selects a thumbnail, builds the creative, and creates the ad in the given ad set. Ads are created PAUSED by default. Per-video copy overrides the shared defaults. Up to ${MAX_TEXT_OPTIONS} primary texts, headlines and descriptions per ad (primary_texts / headlines / descriptions) become Ads Manager-style text options. Advantage+ AI features and multi-advertiser ads stay off unless requested. A video rejected by Meta does not abort the rest — every item reports its own outcome and the stage it failed at — but an expired token, rate limit or abuse signal stops the batch immediately, as does the same failure repeating (which means a shared input like page_id or ad_set_id is wrong). The whole call is capped at ${BATCH_BUDGET_MS / 1000}s so it always returns the IDs it created; videos left unprocessed come back marked "skipped", and re-running with only those is safe. Use this instead of chaining ads_upload_ad_video → ads_create_ad_creative → ads_create_ad manually.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        ad_set_id: z.string().describe("Ad set ID that will hold the new ads"),
        page_id: z.string().describe("Facebook Page ID used as the ad's identity"),
        instagram_actor_id: z
          .string()
          .optional()
          .describe("Instagram account ID for IG placements (from ads_get_instagram_account)"),
        videos: z
          .array(
            z.object({
              file_url: z.string().min(1).describe("Public https URL of the video file (MP4/MOV)"),
              ad_name: z.string().min(1).optional().describe("Name of the resulting ad. Defaults to the video name, then to 'Video ad N'."),
              video_name: z.string().min(1).optional().describe("Name of the video in the ad account library"),
              message: z.string().optional().describe("Primary text. Overrides the shared message."),
              headline: z.string().max(MAX_HEADLINE_LENGTH).optional().describe("Headline. Overrides the shared headline."),
              description: z.string().optional().describe("Description below the headline. Overrides the shared description."),
              primary_texts: textOptions().describe(`Up to ${MAX_TEXT_OPTIONS} primary texts for this video's ad. Overrides the shared primary text(s).`),
              headlines: headlineOptions().describe(`Up to ${MAX_TEXT_OPTIONS} headlines for this video's ad. Overrides the shared headline(s).`),
              descriptions: textOptions().describe(`Up to ${MAX_TEXT_OPTIONS} descriptions for this video's ad. Overrides the shared description(s).`),
              link_url: z.string().min(1).optional().describe("Destination URL. Overrides the shared link_url."),
              call_to_action_type: ctaEnum.optional().describe("CTA button. Overrides the shared call_to_action_type."),
            }),
          )
          .min(1)
          .max(MAX_VIDEOS_PER_CALL)
          .describe(`Videos to turn into ads (max ${MAX_VIDEOS_PER_CALL} per call)`),
        message: z.string().optional().describe("Shared primary text applied to every video without its own message"),
        headline: z.string().max(MAX_HEADLINE_LENGTH).optional().describe("Shared headline applied to every video without its own headline"),
        description: z.string().optional().describe("Shared description applied to every video without its own description"),
        primary_texts: textOptions().describe(`Shared primary texts (up to ${MAX_TEXT_OPTIONS}) for every video without its own. Several texts become Ads Manager-style text options.`),
        headlines: headlineOptions().describe(`Shared headlines (up to ${MAX_TEXT_OPTIONS}) for every video without its own.`),
        descriptions: textOptions().describe(`Shared descriptions (up to ${MAX_TEXT_OPTIONS}) for every video without its own.`),
        advantage_creative: z
          .record(z.string().regex(FEATURE_NAME_PATTERN), z.enum(["OPT_IN", "OPT_OUT"]))
          .optional()
          .describe("Advantage+ creative features to turn on for every ad, e.g. { \"text_optimizations\": \"OPT_IN\" }. Every feature is OPT_OUT unless listed."),
        multi_advertiser_ads: z.boolean().optional().describe("Let Meta show these ads alongside other advertisers' ads. Off unless true."),
        link_url: z.string().min(1).optional().describe("Shared destination URL applied to every video without its own link_url"),
        call_to_action_type: ctaEnum.optional().describe("Shared CTA button applied to every video without its own CTA"),
        url_tags: z.string().optional().describe("Query params appended to clicked URLs (e.g. 'utm_source=meta&utm_medium=paid')"),
        status: z
          .enum(["ACTIVE", "PAUSED"])
          .default("PAUSED")
          .describe("Status of the created ads. PAUSED by default so nothing starts spending unreviewed."),
        max_wait_seconds: z
          .number()
          .min(0)
          .max(240)
          .default(120)
          .describe("Per-video cap on waiting for Meta to finish processing. Also bounded by the batch-wide time budget."),
      },
      annotations: { ...CREATE },
    },
    async ({
      account_id, ad_set_id, page_id, instagram_actor_id, videos,
      message, headline, description, primary_texts, headlines, descriptions,
      link_url, call_to_action_type, url_tags, advantage_creative, multi_advertiser_ads,
      status, max_wait_seconds,
    }) => {
      const sharedCopy = {
        primary: resolveTextOptions(message, primary_texts, "message", "primary_texts"),
        headlines: resolveTextOptions(headline, headlines, "headline", "headlines"),
        descriptions: resolveTextOptions(description, descriptions, "description", "descriptions"),
      };
      const itemCopies = videos.map((video, index) => {
        const where = `videos[${index}]`;
        return {
          primary: resolveTextOptions(video.message, video.primary_texts, `${where}.message`, `${where}.primary_texts`),
          headlines: resolveTextOptions(video.headline, video.headlines, `${where}.headline`, `${where}.headlines`),
          descriptions: resolveTextOptions(video.description, video.descriptions, `${where}.description`, `${where}.descriptions`),
        };
      });
      const featureSpec = buildFeatureSpec(advantage_creative, multi_advertiser_ads === true);
      const normalizedUrlTags = url_tags === undefined ? "" : normalizeUrlTags(url_tags);
      const accountPath = normalizeAccountId(account_id);
      const adSetIdValidated = validateMetaId(ad_set_id, "adset");
      const pageIdValidated = validateMetaId(page_id, "page");
      const instagramActorIdValidated = instagram_actor_id
        ? validateMetaId(instagram_actor_id, "instagram_actor")
        : undefined;

      const batchDeadline = Date.now() + BATCH_BUDGET_MS;
      const remainingMs = () => batchDeadline - Date.now();
      const results: ItemResult[] = [];
      let systemicError: unknown;
      let lastFailure: string | undefined;
      let repeatedFailures = 0;

      for (const [index, video] of videos.entries()) {
        const adName = video.ad_name ?? video.video_name ?? `Video ad ${index + 1}`;
        const result: ItemResult = { file_url: video.file_url, ad_name: adName };

        if (systemicError || remainingMs() <= ITEM_START_RESERVE_MS) {
          result.skipped = true;
          result.error = systemicError
            ? "Not attempted — the batch stopped after an error that affects every video."
            : "Not attempted — too little of the batch time budget left to start another video. Re-run with the remaining videos.";
          results.push(result);
          continue;
        }

        let stage: Stage = "upload";
        try {
          try {
            await assertSafePublicUrl(video.file_url);
          } catch (err) {
            if (err instanceof UnsafeUrlError) {
              throw new StageError("upload", `Refusing to forward file_url to Meta: ${err.message}`);
            }
            throw err;
          }

          const uploaded = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/advideos`, {
            file_url: video.file_url,
            ...(video.video_name ? { name: video.video_name } : {}),
          });
          result.video_id = uploaded.id;

          stage = "processing";
          const waitBudgetMs = Math.max(0, remainingMs() - FINALIZE_RESERVE_MS);
          const budgetSeconds = Math.min(max_wait_seconds, Math.floor(waitBudgetMs / 1000));
          const ready = await waitForVideoReady(uploaded.id, budgetSeconds);

          stage = "creative";
          const thumbnailUrl = pickThumbnail(ready);
          if (!thumbnailUrl) {
            throw new StageError(
              "creative",
              `Meta returned no thumbnail for video ${uploaded.id}; video creatives require one.`,
            );
          }
          result.thumbnail_url = thumbnailUrl;

          const itemCopy = itemCopies[index];
          const story = buildStorySpec({
            pageId: pageIdValidated,
            instagramUserId: instagramActorIdValidated,
            videoId: uploaded.id,
            imageUrl: thumbnailUrl,
            linkUrl: video.link_url ?? link_url,
            primaryTexts: itemCopy.primary.length > 0 ? itemCopy.primary : sharedCopy.primary,
            headlines: itemCopy.headlines.length > 0 ? itemCopy.headlines : sharedCopy.headlines,
            descriptions: itemCopy.descriptions.length > 0 ? itemCopy.descriptions : sharedCopy.descriptions,
            callToActionType: video.call_to_action_type ?? call_to_action_type,
          });
          if (story.warnings.length > 0) result.warnings = story.warnings;

          const creativeBody: Record<string, string | number | boolean> = {
            name: `${adName} — creative`,
            object_story_spec: JSON.stringify(story.objectStorySpec),
            degrees_of_freedom_spec: JSON.stringify(featureSpec.degrees_of_freedom_spec),
            contextual_multi_ads: JSON.stringify(featureSpec.contextual_multi_ads),
          };
          if (story.assetFeedSpec) creativeBody.asset_feed_spec = JSON.stringify(story.assetFeedSpec);
          if (normalizedUrlTags) creativeBody.url_tags = normalizedUrlTags;

          const creative = await metaApiClient.postForm<{ id: string }>(
            `/${accountPath}/adcreatives`,
            creativeBody,
          );
          result.creative_id = creative.id;

          stage = "ad";
          const ad = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/ads`, {
            name: adName,
            adset_id: adSetIdValidated,
            creative: JSON.stringify({ creative_id: creative.id }),
            status,
          });
          result.ad_id = ad.id;
          lastFailure = undefined;
          repeatedFailures = 0;
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
          result.failed_stage = err instanceof StageError ? err.stage : stage;

          // Only Meta's own verdicts can betray a shared bad input. Locally
          // decided rejections (unsafe URL, missing thumbnail) are per-video by
          // construction and would otherwise halt a batch over two bad URLs.
          if (err instanceof McpError) {
            const signature = `${result.failed_stage}:${result.error}`;
            repeatedFailures = signature === lastFailure ? repeatedFailures + 1 : 1;
            lastFailure = signature;
          } else {
            lastFailure = undefined;
            repeatedFailures = 0;
          }

          if (!isItemScopedError(err) || repeatedFailures >= REPEATED_FAILURE_LIMIT) {
            systemicError = err;
          }
        }

        results.push(result);
      }

      const created = results.filter((r) => r.ad_id);
      const skipped = results.filter((r) => r.skipped);
      const failed = results.filter((r) => !r.ad_id && !r.skipped);

      // Throw only when the batch left nothing behind on Meta's side. A video or
      // creative without its ad still has an ID the caller needs to finish or
      // clean up, and an exception would discard the whole report.
      const leftArtifacts = results.some((r) => r.video_id ?? r.creative_id ?? r.ad_id);
      if (systemicError && !leftArtifacts) throw systemicError;

      const lines = [
        `Created ${created.length} of ${results.length} ad(s) in ad set ${adSetIdValidated} with status ${status}.`,
      ];
      if (systemicError) {
        lines.push(
          "",
          `⚠️ The batch stopped early — this error affects every video, not just one: ${
            systemicError instanceof Error ? systemicError.message : String(systemicError)
          }`,
          "Fix that first, then re-run with the skipped videos only.",
        );
      }
      if (created.length > 0) {
        lines.push(
          "",
          "Created:",
          ...created.map((r) => `• ${r.ad_name} — ad ${r.ad_id} (creative ${r.creative_id}, video ${r.video_id})`),
        );
      }
      if (failed.length > 0) {
        lines.push(
          "",
          "Failed:",
          ...failed.map((r) => `• ${r.ad_name} — failed at ${r.failed_stage}: ${r.error}`),
        );
      }
      if (skipped.length > 0) {
        lines.push(
          "",
          `Not attempted (${skipped.length}):`,
          ...skipped.map((r) => `• ${r.ad_name} — ${r.file_url}\n  ${r.error}`),
        );
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(results, null, 2) },
        ],
      };
    },
  );
}
