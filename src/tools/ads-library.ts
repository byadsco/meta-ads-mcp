import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  ADS_LIBRARY_ACTOR_ID,
  apifyApiClient,
  isApifyEnvFallbackUsable,
  maskApifyToken,
  resolveApifyTenantId,
  validateApifyId,
} from "../apify/client.js";
import {
  DATASET_ITEM_EVENT,
  USD_PER_AD,
  USD_PER_RUN_START,
  type AdLibraryActiveStatus,
  type AdLibraryActorInput,
  type AdLibraryAdType,
  type AdLibraryPeriod,
  type AdLibrarySearchType,
  type AdLibrarySortBy,
  type ApifyEnvelope,
  type ApifyRun,
  type ApifyUser,
} from "../apify/types.js";
import { getApifyTokenRepo } from "../store/apify-token-repo.js";
import { hashToken } from "../auth/token-store.js";
import { truncateResponse } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { APIFY_WRITE_WARNING, DELETE, READ, TOKEN, TOGGLE, CREATE } from "./_register.js";

/**
 * Hosts the actor knows how to scrape. Deliberately NOT routed through
 * assertSafePublicUrl: we never fetch this URL ourselves — Apify does — so the
 * risk is not SSRF against our network but "spend the tenant's Apify credit
 * scraping an unrelated site". An exact host allowlist is the right control.
 */
const ALLOWED_URL_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "web.facebook.com",
  "m.facebook.com",
]);

const MAX_COUNT = 2000;

function tenantId(): string {
  return resolveApifyTenantId();
}

function estimateMaxChargeUsd(count: number): number {
  // Cent-rounded ceiling over the per-ad events plus the one-time start event.
  return Math.ceil((count * USD_PER_AD + USD_PER_RUN_START) * 100) / 100;
}

/** Facebook's own outbound redirectors — following one would leave the allowlisted host. */
const REDIRECT_PATHS = new Set(["/l.php", "/flx/warn", "/away.php", "/away"]);

/**
 * Facebook normalizes percent-encoded and duplicated path segments, so a raw
 * `pathname` comparison is bypassable with `/%6c.php`, `//l.php` or `/l.php/`.
 * Decode (repeatedly, to defeat double-encoding), then collapse.
 */
function canonicalPath(pathname: string): string {
  let decoded = pathname;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const collapsed = decoded.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

function validateFacebookUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `"${raw}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new McpError(ErrorCode.InvalidParams, "Only https:// URLs are accepted.");
  }
  if (!ALLOWED_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Host "${parsed.hostname}" is not allowed. Use a facebook.com Ad Library search URL or a Facebook page URL.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new McpError(ErrorCode.InvalidParams, "URLs with embedded credentials are not accepted.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Port ${parsed.port} is not allowed; only the default https port is accepted.`,
    );
  }
  if (REDIRECT_PATHS.has(canonicalPath(parsed.pathname))) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${parsed.pathname}" is a Facebook redirect endpoint, which would send the scraper off-site. Pass the destination URL directly.`,
    );
  }
  return parsed.toString();
}

function buildAdLibrarySearchUrl(opts: {
  query: string;
  country: string;
  activeStatus: AdLibraryActiveStatus;
  adType: AdLibraryAdType;
  searchType: AdLibrarySearchType;
}): string {
  const params = new URLSearchParams({
    active_status: opts.activeStatus,
    ad_type: opts.adType,
    country: opts.country,
    q: opts.query,
    search_type: opts.searchType,
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function buildActorInput(opts: {
  url: string;
  count: number;
  scrapeAdDetails: boolean;
  activeStatus: AdLibraryActiveStatus;
  country: string;
  period: AdLibraryPeriod;
  sortBy: AdLibrarySortBy;
}): AdLibraryActorInput {
  return {
    urls: [{ url: opts.url }],
    count: opts.count,
    scrapeAdDetails: opts.scrapeAdDetails,
    "scrapePageAds.activeStatus": opts.activeStatus,
    "scrapePageAds.countryCode": opts.country,
    "scrapePageAds.period": opts.period,
    "scrapePageAds.sortBy": opts.sortBy,
  };
}

interface RawAd {
  [key: string]: unknown;
}

/** The actor returns some copy fields as `{ text }` objects and others as plain strings. */
function flattenText(value: unknown): unknown {
  if (value && typeof value === "object" && "text" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).text ?? null;
  }
  return value ?? null;
}

function slimAd(ad: RawAd): Record<string, unknown> {
  const snapshot = (ad.snapshot ?? {}) as Record<string, unknown>;
  return {
    ad_archive_id: ad.ad_archive_id ?? ad.adArchiveID ?? null,
    page_id: ad.page_id ?? ad.pageID ?? null,
    page_name: ad.page_name ?? ad.pageName ?? snapshot.page_name ?? null,
    is_active: ad.is_active ?? ad.isActive ?? null,
    start_date: ad.start_date ?? ad.startDate ?? null,
    end_date: ad.end_date ?? ad.endDate ?? null,
    publisher_platform: ad.publisher_platform ?? ad.publisherPlatform ?? null,
    currency: ad.currency ?? null,
    spend: ad.spend ?? null,
    body: flattenText(snapshot.body),
    title: snapshot.title ?? null,
    cta_text: snapshot.cta_text ?? null,
    link_url: snapshot.link_url ?? null,
    display_format: snapshot.display_format ?? null,
    collation_count: ad.collation_count ?? null,
    reach_estimate: ad.reach_estimate ?? null,
  };
}

/**
 * Apify populates usageTotalUsd with a lag, so a run that has just flipped to
 * SUCCEEDED often still reports $0 — which reads as "this was free". The
 * charged event count is accurate immediately, so fall back to deriving the
 * amount from it and say plainly that Apify has not settled the figure yet.
 */
function describeCost(run: ApifyRun): string {
  const ads = run.chargedEventCounts?.[DATASET_ITEM_EVENT];
  const billed = run.eventUsage?.[DATASET_ITEM_EVENT]?.eventTotalUsd ?? run.usageTotalUsd;

  if (billed) {
    // The runs-list endpoint omits chargedEventCounts, so the ad count is only
    // available on a single-run lookup.
    return ads !== undefined
      ? ` — ${ads} ad(s) charged, $${billed.toFixed(4)}`
      : ` — $${billed.toFixed(4)} charged`;
  }
  if (ads) {
    return ` — ${ads} ad(s) charged, ≈$${(ads * USD_PER_AD).toFixed(4)} (Apify has not settled the final amount yet)`;
  }
  return "";
}

function describeRun(run: ApifyRun): string {
  const runtime = run.stats?.runTimeSecs !== undefined ? ` — ${Math.round(run.stats.runTimeSecs)}s` : "";
  return `${run.id} — ${run.status}${runtime}${describeCost(run)}`;
}

export function registerAdsLibraryTools(server: McpServer): void {
  server.registerTool(
    "ads_library_register_apify_token",
    {
      description: `${APIFY_WRITE_WARNING}Register your Apify API token so the ads_library_* tools can scrape the public Meta Ad Library. The token is validated against the Apify API and then stored encrypted (AES-256-GCM) and scoped to your account. Get a token at console.apify.com/settings/integrations. Most users register it on the server's /auth/connections page instead of calling this tool.`,
      inputSchema: {
        apify_token: z
          .string()
          .min(10)
          .max(200)
          .describe("Apify API token (starts with apify_api_)"),
      },
      annotations: { ...TOKEN },
    },
    async ({ apify_token }) => {
      const token = apify_token.trim();
      logger.info({ tokenHash: hashToken(token) }, "Validating Apify token before registration");

      let user: ApifyUser;
      try {
        const response = await apifyApiClient.get<ApifyEnvelope<ApifyUser>>(
          "/v2/users/me",
          undefined,
          token,
        );
        user = response.data;
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Apify token validation failed: ${
                error instanceof Error ? error.message : String(error)
              }\n\nThe token was NOT stored.`,
            },
          ],
          isError: true,
        };
      }

      await getApifyTokenRepo().saveToken(tenantId(), token, {
        id: user.id,
        username: user.username,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Apify token registered and encrypted at rest.\n` +
              `Apify account: ${user.username} (${user.id})\n` +
              `Token: ${maskApifyToken(token)}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_get_apify_token_status",
    {
      description:
        "Check whether an Apify token is available for the current user, where it comes from (encrypted per-user storage or the APIFY_TOKEN environment fallback), and optionally verify it is still valid against the Apify API.",
      inputSchema: {
        verify: z
          .boolean()
          .default(false)
          .describe("Also call the Apify API to confirm the token still works"),
      },
      annotations: { ...READ },
    },
    async ({ verify }) => {
      const status = await getApifyTokenRepo().getStatus(tenantId());
      const envAvailable = isApifyEnvFallbackUsable();
      const source = status.registered ? "encrypted_user_storage" : envAvailable ? "env" : "none";

      let verification = "not requested";
      if (verify && source !== "none") {
        try {
          const me = await apifyApiClient.get<ApifyEnvelope<ApifyUser>>("/v2/users/me");
          verification = `valid — ${me.data.username}`;
        } catch (error) {
          verification = `invalid — ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const summary =
        source === "none"
          ? "No Apify token available. Register one on the /auth/connections page, or with ads_library_register_apify_token."
          : `Apify token source: ${source}` +
            (status.apifyUsername ? `\nApify account: ${status.apifyUsername}` : "") +
            (status.updatedAt ? `\nLast updated: ${new Date(status.updatedAt * 1000).toISOString()}` : "") +
            `\nVerification: ${verification}`;

      return {
        content: [
          { type: "text", text: summary },
          {
            type: "text",
            text: JSON.stringify(
              { source, envFallbackAvailable: envAvailable, ...status, verification },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_delete_apify_token",
    {
      description: `${APIFY_WRITE_WARNING}Delete the Apify token stored for the current user. Does not affect the APIFY_TOKEN environment fallback, if one is configured.`,
      inputSchema: {},
      annotations: { ...DELETE },
    },
    async () => {
      const deleted = await getApifyTokenRepo().deleteToken(tenantId());
      const envAvailable = isApifyEnvFallbackUsable();

      if (!deleted) {
        return {
          content: [
            {
              type: "text",
              text: `No stored Apify token found for this user.${
                envAvailable ? " The APIFY_TOKEN environment fallback is still active." : ""
              }`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Stored Apify token deleted.${
              envAvailable
                ? " Note: the APIFY_TOKEN environment fallback is still active and will be used."
                : ""
            }`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_scrape",
    {
      description: `${APIFY_WRITE_WARNING}Start an asynchronous scrape of the public Meta Ad Library (competitor ad research) via the curious_coder/facebook-ads-library-scraper Apify actor. Costs about $0.75 per 1,000 ads; a hard spend cap derived from "count" is sent to Apify so a run can never bill beyond it. Returns a run_id and dataset_id — poll ads_library_get_run_status, then read ads_library_get_results.`,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Keyword to search in the Ad Library. Mutually exclusive with 'url'."),
        url: z
          .string()
          .optional()
          .describe(
            "An https://www.facebook.com Ad Library search URL or a Facebook page URL to scrape ads from. Mutually exclusive with 'query'.",
          ),
        country: z
          .string()
          .regex(/^([A-Z]{2}|ALL)$/)
          .default("ALL")
          .describe("Uppercase ISO 3166-1 alpha-2 country code (e.g. CO, US), or ALL"),
        active_status: z
          .enum(["all", "active", "inactive"])
          .default("active")
          .describe("Filter by whether the ad is currently running"),
        ad_type: z
          .enum([
            "all",
            "political_and_issue_ads",
            "housing_ads",
            "employment_ads",
            "financial_products_and_services_ads",
          ])
          .default("all")
          .describe("Ad Library category filter (applies to keyword searches)"),
        search_type: z
          .enum(["keyword_unordered", "keyword_exact_phrase"])
          .default("keyword_unordered")
          .describe("Whether the keyword must match as an exact phrase"),
        period: z
          .enum(["", "last24h", "last7d", "last14d", "last30d"])
          .default("")
          .describe("Date range filter. Only applies when scraping a Facebook page URL."),
        sort_by: z
          .enum(["impressions_desc", "most_recent"])
          .default("impressions_desc")
          .describe("Result ordering. Only applies when scraping a Facebook page URL."),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_COUNT)
          .default(100)
          .describe(
            `Maximum ads to scrape (1-${MAX_COUNT}). Drives the spend cap: roughly $0.75 per 1,000 ads.`,
          ),
        scrape_ad_details: z
          .boolean()
          .default(false)
          .describe("Also fetch per-ad detail such as EU reach/transparency data. Slower."),
      },
      annotations: { ...CREATE },
    },
    async ({
      query,
      url,
      country,
      active_status,
      ad_type,
      search_type,
      period,
      sort_by,
      count,
      scrape_ad_details,
    }) => {
      // Re-trim rather than trusting the Zod transform: a whitespace-only
      // keyword would otherwise become an unbounded (and billable) search.
      const keyword = query?.trim();
      if ((keyword && url) || (!keyword && !url)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Provide exactly one of 'query' (keyword search) or 'url' (Ad Library search URL or Facebook page URL).",
        );
      }

      const targetUrl = url
        ? validateFacebookUrl(url)
        : buildAdLibrarySearchUrl({
            query: keyword as string,
            country,
            activeStatus: active_status,
            adType: ad_type,
            searchType: search_type,
          });

      const maxTotalChargeUsd = estimateMaxChargeUsd(count);

      const response = await apifyApiClient.post<ApifyEnvelope<ApifyRun>>(
        `/v2/acts/${ADS_LIBRARY_ACTOR_ID}/runs`,
        buildActorInput({
          url: targetUrl,
          count,
          scrapeAdDetails: scrape_ad_details,
          activeStatus: active_status,
          country,
          period,
          sortBy: sort_by,
        }),
        // Server-side hard cap: this actor bills PAY_PER_EVENT, so Apify aborts
        // the run rather than billing past this amount.
        { maxTotalChargeUsd },
      );

      const run = response.data;

      return {
        content: [
          {
            type: "text",
            text:
              `Ad Library scrape started.\n` +
              `run_id: ${run.id}\n` +
              `dataset_id: ${run.defaultDatasetId}\n` +
              `status: ${run.status}\n` +
              `target: ${targetUrl}\n` +
              `spend cap: $${maxTotalChargeUsd.toFixed(2)} (up to ${count} ads)\n\n` +
              `Poll ads_library_get_run_status with this run_id, then read the ads with ads_library_get_results.`,
          },
          {
            type: "text",
            text: JSON.stringify(
              {
                runId: run.id,
                datasetId: run.defaultDatasetId,
                status: run.status,
                targetUrl,
                maxTotalChargeUsd,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_get_run_status",
    {
      description:
        "Check the status of an Ad Library scrape started with ads_library_scrape. Returns the run state, elapsed runtime, accrued cost, and the dataset id to read results from.",
      inputSchema: {
        run_id: z.string().describe("Run id returned by ads_library_scrape"),
      },
      annotations: { ...READ },
    },
    async ({ run_id }) => {
      const id = validateApifyId(run_id, "run");
      const { data: run } = await apifyApiClient.get<ApifyEnvelope<ApifyRun>>(
        `/v2/actor-runs/${id}`,
      );

      const nextStep =
        run.status === "SUCCEEDED"
          ? `\n\nDone. Read the ads with ads_library_get_results (dataset_id: ${run.defaultDatasetId}).`
          : run.status === "RUNNING" || run.status === "READY"
            ? "\n\nStill running — poll again in a few seconds."
            : "";

      return {
        content: [
          { type: "text", text: `${describeRun(run)}${nextStep}` },
          { type: "text", text: JSON.stringify(run, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_get_results",
    {
      description:
        "Read scraped ads from a completed Ad Library run's dataset. Returns a compact projection of each ad (page, copy, CTA, dates, platforms, spend) by default; pass raw=true for every field the actor produced.",
      inputSchema: {
        dataset_id: z.string().describe("Dataset id from ads_library_scrape or ads_library_get_run_status"),
        offset: z.number().int().min(0).default(0).describe("Number of ads to skip"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Ads to return per call (1-200)"),
        raw: z
          .boolean()
          .default(false)
          .describe("Return the actor's full untrimmed records instead of the compact projection"),
      },
      annotations: { ...READ },
    },
    async ({ dataset_id, offset, limit, raw }) => {
      const id = validateApifyId(dataset_id, "dataset");
      const items = await apifyApiClient.get<RawAd[]>(`/v2/datasets/${id}/items`, {
        offset,
        limit,
        clean: true,
        format: "json",
      });

      const ads = Array.isArray(items) ? items : [];
      const projected = raw ? ads : ads.map(slimAd);

      const summary =
        ads.length === 0
          ? `No ads at offset ${offset}. The run may still be in progress, or you have reached the end of the dataset.`
          : `Fetched ${ads.length} ad(s) starting at offset ${offset}.` +
            (ads.length === limit
              ? ` More may be available — call again with offset=${offset + ads.length}.`
              : "");

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: truncateResponse(JSON.stringify(projected, null, 2)) },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_abort_run",
    {
      description: `${APIFY_WRITE_WARNING}Abort a running Ad Library scrape to stop it accruing cost. Ads already written to the dataset remain readable with ads_library_get_results.`,
      inputSchema: {
        run_id: z.string().describe("Run id to abort"),
      },
      annotations: { ...TOGGLE },
    },
    async ({ run_id }) => {
      const id = validateApifyId(run_id, "run");
      const { data: run } = await apifyApiClient.post<ApifyEnvelope<ApifyRun>>(
        `/v2/actor-runs/${id}/abort`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Run ${run.id} is now ${run.status}. Partial results remain in dataset ${run.defaultDatasetId}.`,
          },
          { type: "text", text: JSON.stringify(run, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "ads_library_list_runs",
    {
      description:
        "List recent Ad Library scrape runs for the current Apify account, newest first. Useful for recovering a run_id or dataset_id, and for reviewing what each run cost.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe("Runs to return (1-50)"),
      },
      annotations: { ...READ },
    },
    async ({ limit }) => {
      const { data } = await apifyApiClient.get<ApifyEnvelope<{ items: ApifyRun[] }>>(
        `/v2/acts/${ADS_LIBRARY_ACTOR_ID}/runs`,
        { desc: true, limit },
      );

      const runs = data.items ?? [];
      const summary =
        runs.length === 0
          ? "No Ad Library scrape runs found for this Apify account."
          : `Found ${runs.length} run(s):\n\n${runs.map((r) => `• ${describeRun(r)}`).join("\n")}`;

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(runs, null, 2) },
        ],
      };
    },
  );
}
