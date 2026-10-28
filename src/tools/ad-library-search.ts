import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import type { MetaApiResponse } from "../meta/types/index.js";
import { validateNumericId } from "../utils/format.js";
import { scrubbed } from "../meta/read-list.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { READ } from "./_register.js";

// ad_snapshot_url is left out on purpose: Meta builds it with the caller's
// access token in its query. The public Ad Library link is built from the id.
const FIELDS = [
  "id", "page_id", "page_name", "ad_creative_bodies", "ad_creative_link_titles", "ad_creative_link_descriptions",
  "ad_creative_link_captions", "ad_delivery_start_time", "ad_delivery_stop_time", "publisher_platforms", "languages", "eu_total_reach",
].join(",");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Meta's cursors are base64url text.
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;

interface LibraryAd {
  id?: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  publisher_platforms?: string[];
  languages?: string[];
  eu_total_reach?: number;
}

const first = (values: string[] | undefined, max: number) => (Array.isArray(values) && typeof values[0] === "string" ? singleLine(values[0], max) : "");
const list = (values: string[] | undefined) => (Array.isArray(values) ? singleLine(values.filter((v) => typeof v === "string").join(", "), 120) : "");

function adLines(ad: LibraryAd): string[] {
  const id = /^\d{1,30}$/.test(ad.id ?? "") ? ad.id : undefined;
  const running = ad.ad_delivery_stop_time ? `until ${singleLine(ad.ad_delivery_stop_time, 30)}` : "still running";
  const head = [
    `• ${singleLine(ad.page_name, 100) || "(unnamed Page)"} (page_id ${singleLine(ad.page_id, 30)})`,
    `library id ${singleLine(ad.id, 30)}`,
    `from ${singleLine(ad.ad_delivery_start_time, 30) || "?"} ${running}`,
    ...(list(ad.publisher_platforms) ? [list(ad.publisher_platforms)] : []),
    ...(list(ad.languages) ? [`languages ${list(ad.languages)}`] : []),
    ...(typeof ad.eu_total_reach === "number" ? [`EU reach ${ad.eu_total_reach}`] : []),
  ].join(" — ");
  const extra = (ad.ad_creative_bodies?.length ?? 0) > 1 ? ` (+${(ad.ad_creative_bodies?.length ?? 1) - 1} more versions)` : "";
  return [
    head,
    ...(first(ad.ad_creative_bodies, 300) ? [`  text: ${first(ad.ad_creative_bodies, 300)}${extra}`] : []),
    ...(first(ad.ad_creative_link_titles, 120) ? [`  headline: ${first(ad.ad_creative_link_titles, 120)}`] : []),
    ...(first(ad.ad_creative_link_descriptions, 150) ? [`  description: ${first(ad.ad_creative_link_descriptions, 150)}`] : []),
    ...(first(ad.ad_creative_link_captions, 100) ? [`  link caption: ${first(ad.ad_creative_link_captions, 100)}`] : []),
    ...(id ? [`  https://www.facebook.com/ads/library/?id=${id}`] : []),
  ];
}

export function registerAdLibrarySearchTools(server: McpServer): void {
  server.registerTool(
    "ads_library_search",
    {
      description:
        "Search the public Meta Ad Library through Meta's own Ad Library API, for competitive research and creative inspiration: " +
        "ads by keyword or by Page, in the countries they reached, with their text, dates, platforms and public link. Free, unlike ads_library_scrape (Apify). " +
        "Meta returns ads about social issues, elections or politics everywhere, and other ads mainly where it publishes them (the EU and UK, among others). " +
        "Ad text is written by advertisers and comes inside an untrusted-content fence.",
      inputSchema: {
        search_terms: z.string().min(1).max(100).optional().describe("Words to look for in the ads. Give this, search_page_ids, or both."),
        search_page_ids: z.array(z.string()).min(1).max(10).optional().describe("Only ads from these Pages"),
        ad_reached_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(30).describe("Countries the ads reached (ISO codes), e.g. [\"ES\"]"),
        ad_active_status: z.enum(["ACTIVE", "INACTIVE", "ALL"]).default("ACTIVE"),
        ad_type: z.enum(["ALL", "POLITICAL_AND_ISSUE_ADS", "HOUSING_ADS", "EMPLOYMENT_ADS", "FINANCIAL_PRODUCTS_AND_SERVICES_ADS"]).default("ALL"),
        search_type: z.enum(["KEYWORD_UNORDERED", "KEYWORD_EXACT_PHRASE"]).optional().describe("Any of the words (default) or the exact phrase"),
        media_type: z.enum(["ALL", "IMAGE", "MEME", "VIDEO", "NONE"]).optional(),
        publisher_platforms: z.array(z.enum(["FACEBOOK", "INSTAGRAM", "AUDIENCE_NETWORK", "MESSENGER", "WHATSAPP", "OCULUS", "THREADS"])).min(1).optional(),
        languages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(10).optional().describe("Ad languages (ISO 639-1), e.g. [\"es\"]"),
        ad_delivery_date_min: z.string().regex(DATE).optional().describe("Ads delivered on or after this date (YYYY-MM-DD)"),
        ad_delivery_date_max: z.string().regex(DATE).optional().describe("Ads delivered on or before this date (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("The cursor a previous search gave, for its next page"),
      },
      annotations: { ...READ },
    },
    async (args) => {
      if (args.search_terms === undefined && args.search_page_ids === undefined) {
        throw new Error("Give search_terms or search_page_ids (or both).");
      }
      const pages = args.search_page_ids?.map((id) => validateNumericId(id, "page id"));
      if (args.after !== undefined && !CURSOR.test(args.after)) {
        throw new Error("after must be the cursor a previous ads_library_search gave, unchanged.");
      }
      if (args.ad_delivery_date_min && args.ad_delivery_date_max && args.ad_delivery_date_min > args.ad_delivery_date_max) {
        throw new Error("ad_delivery_date_min must not be after ad_delivery_date_max.");
      }

      const params: Record<string, string | number> = {
        fields: FIELDS,
        ad_reached_countries: JSON.stringify(args.ad_reached_countries),
        ad_active_status: args.ad_active_status,
        ad_type: args.ad_type,
        limit: args.limit,
      };
      if (args.search_terms !== undefined) params.search_terms = args.search_terms;
      if (pages) params.search_page_ids = JSON.stringify(pages);
      if (args.search_type) params.search_type = args.search_type;
      if (args.media_type) params.media_type = args.media_type;
      if (args.publisher_platforms) params.publisher_platforms = JSON.stringify(args.publisher_platforms);
      if (args.languages) params.languages = JSON.stringify(args.languages);
      if (args.ad_delivery_date_min) params.ad_delivery_date_min = args.ad_delivery_date_min;
      if (args.ad_delivery_date_max) params.ad_delivery_date_max = args.ad_delivery_date_max;
      if (args.after) params.after = args.after;

      const response = scrubbed(await metaApiClient.get<MetaApiResponse<LibraryAd>>("/ads_archive", params));
      const ads = response.data ?? [];
      const next = response.paging?.next ? response.paging.cursors?.after : undefined;

      const lines = [
        ads.length === 0
          ? "No ads in the Meta Ad Library match."
          : `${ads.length} ad${ads.length === 1 ? "" : "s"} in the Meta Ad Library match.`,
        ...(response.paging?.next
          ? [next && CURSOR.test(next)
            ? `More match: call again with after: "${next}".`
            : "More ads match, but Meta's cursor could not be passed on; narrow the search to see them."]
          : []),
        ...(ads.length ? [ADVERTISER_CONTENT_OPEN, ...ads.flatMap(adLines), ADVERTISER_CONTENT_CLOSE] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
