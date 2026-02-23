import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import type {
  Interest,
  Behavior,
  DemographicOption,
  GeoLocationResult,
  MetaApiResponse,
} from "../meta/types/index.js";

const demographicClassEnum = z.enum([
  "demographics", "work_employers", "work_positions",
  "education_schools", "education_majors", "family_statuses",
  "life_events", "industries", "income", "net_worth",
  "home_type", "home_ownership", "home_value",
  "ethnic_affinity", "generation", "politics",
]);

const locationTypeEnum = z.enum([
  "country", "region", "city", "zip", "geo_market",
  "electoral_district", "neighborhood", "country_group",
]);

export function registerTargetingTools(server: McpServer): void {
  // ─── Search Interests ────────────────────────────────────────
  server.tool(
    "meta_ads_search_interests",
    "Search for interest targeting options by keyword. Returns matching interests with audience sizes.",
    {
      query: z.string().min(1).describe("Interest keyword to search"),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ query, limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<Interest>>(
        "/search",
        { type: "adinterest", q: query, limit },
      );

      const interests = response.data ?? [];
      const text =
        interests.length === 0
          ? `No interests found for "${query}".`
          : interests
              .map(
                (i) =>
                  `• ${i.name} (ID: ${i.id}) — Audience: ${i.audience_size_lower_bound?.toLocaleString() ?? "?"}-${i.audience_size_upper_bound?.toLocaleString() ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Interest search for "${query}" — ${interests.length} result(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(interests, null, 2) },
        ],
      };
    },
  );

  // ─── Get Interest Suggestions ────────────────────────────────
  server.tool(
    "meta_ads_get_interest_suggestions",
    "Get interest suggestions based on existing interests. Useful for expanding targeting.",
    {
      interest_list: z
        .array(z.string())
        .min(1)
        .describe("List of interest names to get suggestions for"),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ interest_list, limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<Interest>>(
        "/search",
        {
          type: "adinterestsuggestion",
          interest_list: JSON.stringify(interest_list),
          limit,
        },
      );

      const suggestions = response.data ?? [];
      const text =
        suggestions.length === 0
          ? "No suggestions found."
          : suggestions
              .map(
                (i) =>
                  `• ${i.name} (ID: ${i.id}) — Audience: ${i.audience_size_lower_bound?.toLocaleString() ?? "?"}-${i.audience_size_upper_bound?.toLocaleString() ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `${suggestions.length} suggestion(s) based on [${interest_list.join(", ")}]:\n\n${text}` },
          { type: "text", text: JSON.stringify(suggestions, null, 2) },
        ],
      };
    },
  );

  // ─── Search Behaviors ────────────────────────────────────────
  server.tool(
    "meta_ads_search_behaviors",
    "Get behavior targeting options. Behaviors include purchase behavior, device usage, travel, etc.",
    {
      limit: z.number().min(1).max(200).default(50),
    },
    async ({ limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<Behavior>>(
        "/search",
        { type: "adTargetingCategory", class: "behaviors", limit },
      );

      const behaviors = response.data ?? [];
      const text =
        behaviors.length === 0
          ? "No behaviors found."
          : behaviors
              .map(
                (b) =>
                  `• ${b.name} (ID: ${b.id}) — Audience: ${b.audience_size_lower_bound?.toLocaleString() ?? "?"}-${b.audience_size_upper_bound?.toLocaleString() ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `${behaviors.length} behavior(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(behaviors, null, 2) },
        ],
      };
    },
  );

  // ─── Search Demographics ─────────────────────────────────────
  server.tool(
    "meta_ads_search_demographics",
    "Get demographic targeting options by category (e.g., income, family status, education, life events, industries).",
    {
      demographic_class: demographicClassEnum.describe("Demographic category to search"),
      limit: z.number().min(1).max(200).default(50),
    },
    async ({ demographic_class, limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<DemographicOption>>(
        "/search",
        { type: "adTargetingCategory", class: demographic_class, limit },
      );

      const options = response.data ?? [];
      const text =
        options.length === 0
          ? `No options found for "${demographic_class}".`
          : options
              .map(
                (d) =>
                  `• ${d.name} (ID: ${d.id}) — Audience: ${d.audience_size_lower_bound?.toLocaleString() ?? "?"}-${d.audience_size_upper_bound?.toLocaleString() ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `${options.length} ${demographic_class} option(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(options, null, 2) },
        ],
      };
    },
  );

  // ─── Search Geo Locations ────────────────────────────────────
  server.tool(
    "meta_ads_search_geo_locations",
    "Search for geographic targeting locations (countries, regions, cities, zip codes, etc.).",
    {
      query: z.string().min(1).describe("Location to search for"),
      location_types: z
        .array(locationTypeEnum)
        .default(["country", "region", "city"])
        .describe("Types of locations to include"),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ query, location_types, limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<GeoLocationResult>>(
        "/search",
        {
          type: "adgeolocation",
          q: query,
          location_types: JSON.stringify(location_types),
          limit,
        },
      );

      const locations = response.data ?? [];
      const text =
        locations.length === 0
          ? `No locations found for "${query}".`
          : locations
              .map(
                (l) =>
                  `• ${l.name} (Key: ${l.key}) — Type: ${l.type} — Country: ${l.country_name ?? l.country_code ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `${locations.length} location(s) for "${query}":\n\n${text}` },
          { type: "text", text: JSON.stringify(locations, null, 2) },
        ],
      };
    },
  );

  // ─── Estimate Audience Size ──────────────────────────────────
  server.tool(
    "meta_ads_estimate_audience_size",
    "Estimate the audience size for a targeting specification. Useful for validating targeting before creating ad sets.",
    {
      account_id: z.string().describe("Ad account ID"),
      targeting_spec: z
        .record(z.unknown())
        .describe("Targeting specification (same format as create_adset targeting)"),
    },
    async ({ account_id, targeting_spec }) => {
      const id = normalizeAccountId(account_id);

      const response = await metaApiClient.get<{
        data: Array<{
          users_lower_bound: number;
          users_upper_bound: number;
          estimate_ready: boolean;
        }>;
      }>(`/${id}/delivery_estimate`, {
        targeting_spec: JSON.stringify(targeting_spec),
        optimization_goal: "REACH",
      });

      const estimate = response.data?.[0];

      if (!estimate || !estimate.estimate_ready) {
        return {
          content: [
            { type: "text", text: "Audience estimate is not ready. This can happen with very specific targeting. Try broadening the targeting spec." },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Estimated Audience Size: ${estimate.users_lower_bound.toLocaleString()} - ${estimate.users_upper_bound.toLocaleString()} people`,
          },
          { type: "text", text: JSON.stringify(estimate, null, 2) },
        ],
      };
    },
  );
}
