import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId, validateNumericId } from "../utils/format.js";
import { buildFeatureSpec } from "../meta/creative-spec.js";
import { singleLine } from "../utils/single-line.js";
import { wasRefused } from "../meta/errors.js";
import { createHash } from "node:crypto";
import { readList } from "../meta/read-list.js";
import { ctaEnum } from "./creatives.js";
import {
  INSTAGRAM_ACCOUNT_FIELDS,
  INSTAGRAM_MEDIA_DEFAULT_FIELDS,
} from "../meta/types/instagram.js";
import type {
  InstagramAccount,
  InstagramMedia,
  MetaApiResponse,
} from "../meta/types/index.js";
import { CREATE, READ, WRITE_WARNING } from "./_register.js";

export function registerInstagramTools(server: McpServer): void {
  // ─── Get Instagram Business Account ────────────────────────
  server.registerTool(
    "ads_get_instagram_account",
    {
      description:
        "Get the Instagram Business account linked to a Facebook Page. Returns the Instagram account ID needed for creating ad creatives with Instagram placement.",
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID to look up its linked Instagram Business account"),
      },
      annotations: { ...READ },
    },
    async ({ page_id }) => {
      const id = validateMetaId(page_id, "page");
      const nestedFields = INSTAGRAM_ACCOUNT_FIELDS.join(",");
      const result = await metaApiClient.get<{
        instagram_business_account?: InstagramAccount;
        id: string;
      }>(`/${id}`, {
        fields: `instagram_business_account{${nestedFields}}`,
      });

      const ig = result.instagram_business_account;

      if (!ig) {
        return {
          content: [
            {
              type: "text",
              text: `No Instagram Business account linked to Page ${id}. Ensure the Page has an Instagram Business or Creator account connected in Page Settings.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Instagram Business Account found!\nID: ${ig.id}\nUsername: ${ig.username ?? "N/A"}\nName: ${ig.name ?? "N/A"}\nFollowers: ${ig.followers_count ?? "N/A"}\nMedia count: ${ig.media_count ?? "N/A"}\n\nUse this ID (${ig.id}) as the instagram_actor_id parameter when creating creatives. The MCP maps it to instagram_user_id internally (Meta deprecated instagram_actor_id in Marketing API v22.0).`,
          },
          { type: "text", text: JSON.stringify(ig, null, 2) },
        ],
      };
    },
  );

  // ─── Get Instagram Media ───────────────────────────────────
  server.registerTool(
    "ads_get_instagram_media",
    {
      description:
        "List recent media posts from an Instagram Business account. Returns media IDs that can be used with source_instagram_media_id in create_ad_creative to promote existing posts.",
      inputSchema: {
        instagram_account_id: z.string().describe("Instagram Business account ID (from ads_get_instagram_account)"),
        limit: z.number().min(1).max(100).default(25).describe("Number of posts to return"),
      },
      annotations: { ...READ },
    },
    async ({ instagram_account_id, limit }) => {
      const id = validateMetaId(instagram_account_id, "instagram_account");
      const fieldsParam = [...INSTAGRAM_MEDIA_DEFAULT_FIELDS].join(",");

      const response = await metaApiClient.get<MetaApiResponse<InstagramMedia>>(
        `/${id}/media`,
        { fields: fieldsParam, limit },
      );

      const media = response.data ?? [];

      const text =
        media.length === 0
          ? "No media found for this Instagram account."
          : media
              .map(
                (m) =>
                  `• ${m.id} — ${m.media_type ?? "UNKNOWN"}${m.boost_eligibility_info ? ` — Boost: ${m.boost_eligibility_info.eligible_to_boost ? "✅ Eligible" : `❌ ${m.boost_eligibility_info.reason ?? "Not eligible"}`}` : ""} — ${m.caption ? m.caption.substring(0, 80) + (m.caption.length > 80 ? "..." : "") : "No caption"} — ${m.timestamp ?? ""}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${media.length} media post(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(media, null, 2) },
        ],
      };
    },
  );

  // ─── Boost an Instagram post (official name) ───────────────
  server.registerTool(
    "ads_boost_ig_post",
    {
      description:
        `${WRITE_WARNING}Turn an existing organic Instagram post into an ad: a creative made from the post (its media and caption) ` +
        "and an ad in the given ad set, created PAUSED. Checks first that the ad set belongs to the account and that Meta lets the post be boosted. " +
        "Advantage+ AI features stay off. Activating the ad is a separate, confirmed step (ads_activate_entity). " +
        "Find posts with ads_get_instagram_media and the Instagram account with ads_get_instagram_account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (with or without 'act_' prefix)"),
        ad_set_id: z.string().describe("Ad set the ad goes in"),
        instagram_media_id: z.string().describe("The Instagram post to boost (from ads_get_instagram_media)"),
        instagram_account_id: z.string().describe("The Instagram account that published it (from ads_get_instagram_account)"),
        page_id: z.string().optional().describe("Facebook Page linked to the Instagram account"),
        name: z.string().min(1).max(400).optional().describe("Name for the creative and the ad"),
        call_to_action_type: ctaEnum.optional().describe("Button to add under the post"),
        link_url: z.string().url().optional().describe("Where the button leads"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, ad_set_id, instagram_media_id, instagram_account_id, page_id, name, call_to_action_type, link_url }) => {
      const account = normalizeAccountId(account_id);
      const adSet = validateNumericId(ad_set_id, "ad_set_id");
      const media = validateNumericId(instagram_media_id, "instagram_media_id");
      const igAccount = validateNumericId(instagram_account_id, "instagram_account_id");
      const page = page_id === undefined ? undefined : validateNumericId(page_id, "page_id");
      if (link_url !== undefined && call_to_action_type === undefined) {
        throw new Error("link_url needs call_to_action_type: the link rides on the button, and Meta drops a link without one.");
      }

      const owner = await metaApiClient.get<{ account_id?: string }>(`/${adSet}`, { fields: "account_id" });
      const adSetAccount = owner.account_id ? normalizeAccountId(owner.account_id) : undefined;
      if (adSetAccount !== account) {
        throw new Error(`ad set ${adSet} belongs to ${adSetAccount ?? "an account Meta did not name"}, not ${account}.`);
      }
      const post = await metaApiClient.get<{ boost_eligibility_info?: { eligible_to_boost?: boolean; reason?: string } }>(
        `/${media}`,
        { fields: "id,media_type,media_product_type,boost_eligibility_info" },
      );
      const eligibility = post.boost_eligibility_info;
      if (eligibility?.eligible_to_boost !== true) {
        const reason = singleLine(eligibility?.reason, 200);
        throw new Error(
          eligibility?.eligible_to_boost === false
            ? `Instagram post ${media} cannot be boosted${reason ? `: Meta says "${reason}"` : ""}.`
            : `Meta did not confirm that Instagram post ${media} can be boosted, so nothing was created.`,
        );
      }

      // The tag is drawn from the arguments, so the same boost always carries
      // the same one: an earlier call that went through is found by it before
      // anything is written, and a lost answer can be checked against it.
      const tag = `[boost ${createHash("sha256")
        .update(JSON.stringify([account, adSet, media, igAccount, page ?? null, name ?? null, call_to_action_type ?? null, link_url ?? null]))
        .digest("hex")
        .slice(0, 10)}]`;
      const lookFilter = `[{field: "name", operator: "CONTAIN", value: ${JSON.stringify(tag)}}]`;
      // Every page is read: CONTAIN also matches copies ("… - Copy") that can
      // fill a page ahead of the ad itself. Only a list Meta ended is proof
      // that no earlier boost exists.
      const findTagged = async (): Promise<{ found?: { ad: string; creative?: string }; complete: boolean }> => {
        const { items, complete } = await readList<{ id?: string; name?: string; creative?: { id?: string } }>(
          `/${adSet}/ads`,
          { fields: "id,name,creative{id}", filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: tag }]), limit: 100 },
          TAG_LOOKUP_MAX,
          TAG_LOOKUP_PAGES,
        );
        const hit = items.find((a) => typeof a.name === "string" && a.name.endsWith(tag) && /^\d{1,30}$/.test(a.id ?? ""));
        const found = hit ? { ad: hit.id as string, creative: /^\d{1,30}$/.test(hit.creative?.id ?? "") ? hit.creative?.id : undefined } : undefined;
        return { found, complete };
      };
      const described = (found: { ad: string; creative?: string }) =>
        `ad ${found.ad} in ad set ${adSet}` + (found.creative ? `, creative ${found.creative}` : "");

      const earlier = await findTagged();
      if (earlier.found) {
        return {
          content: [{
            type: "text",
            text: `Instagram post ${media} was already boosted with these arguments: ${described(earlier.found)}. Nothing new was created.`,
          }],
        };
      }
      if (!earlier.complete) {
        throw new Error(
          `Meta's list of ads in ad set ${adSet} named with ${tag} could not be read to its end, so the tool could not confirm ` +
            `this post was not boosted there already; nothing was created. Check with ads_get_ad_entities on ad set ${adSet} with filtering ${lookFilter}.`,
        );
      }

      // One write makes the ad and its creative: the creative spec goes inline,
      // measured on v26.0.
      const label = `${name ?? `Boost of Instagram post ${media}`} ${tag}`;
      const features = buildFeatureSpec();
      const creative: Record<string, unknown> = {
        source_instagram_media_id: media,
        instagram_user_id: igAccount,
        degrees_of_freedom_spec: features.degrees_of_freedom_spec,
        contextual_multi_ads: features.contextual_multi_ads,
      };
      if (page) creative.object_id = page;
      if (call_to_action_type) creative.call_to_action = { type: call_to_action_type, value: link_url ? { link: link_url } : undefined };
      const why = (err: unknown) => singleLine(err instanceof Error ? err.message : String(err), 300);

      let ad: { id: string };
      try {
        ad = await metaApiClient.postForm<{ id: string }>(`/${account}/ads`, {
          name: label,
          adset_id: adSet,
          status: "PAUSED",
          creative: JSON.stringify(creative),
        });
      } catch (err) {
        if (wasRefused(err)) throw new Error(`Meta refused the ad (${why(err)}), so no ad was created.`);
        for (const wait of recoveryWaitsMs) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          const found = (await findTagged().catch(() => undefined))?.found;
          if (found) {
            return {
              content: [{
                type: "text",
                text: `Meta's answer was lost, but the ad exists: ${described(found)}, PAUSED. ` +
                  "Confirm with the human before activating it with ads_activate_entity.",
              }],
            };
          }
        }
        throw new Error(
          `Meta's answer was lost (${why(err)}) and the ad did not show up in ad set ${adSet}, so it may or may not exist: Meta can take minutes to list a new ad. ` +
            `Look for it later with ads_get_ad_entities on ad set ${adSet} (entity_type "ad") with filtering ${lookFilter}. ` +
            "Calling ads_boost_ig_post again with the same arguments looks for it first and returns it once Meta lists it; " +
            "called again before then, it can make a second one.",
        );
      }

      let creativeId: string | undefined;
      if (/^\d{1,30}$/.test(ad.id)) {
        try {
          const read = await metaApiClient.get<{ creative?: { id?: string } }>(`/${ad.id}`, { fields: "creative{id}" });
          creativeId = read.creative?.id && /^\d{1,30}$/.test(read.creative.id) ? read.creative.id : undefined;
        } catch {
          creativeId = undefined;
        }
      }

      return {
        content: [{
          type: "text",
          text: `Boosted Instagram post ${media}: ad ${ad.id} in ad set ${adSet}, PAUSED, ` +
            (creativeId ? `with creative ${creativeId}. ` : "its creative could not be read back (ads_get_ad_details shows it). ") +
            "Do not call ads_boost_ig_post again for this post and ad set: Meta can take minutes to list the new ad, and a second call before then would make another. " +
            "Confirm with the human before activating it with ads_activate_entity.",
        }],
      };
    },
  );
}

// The tag lookup reads up to this many matching ads, over this many pages.
const TAG_LOOKUP_MAX = 1000;
const TAG_LOOKUP_PAGES = 10;

// After a lost answer the ad is looked for again after each of these waits.
let recoveryWaitsMs: readonly number[] = [3_000, 6_000, 12_000];

export function setBoostRecoveryWaitsForTests(waits: readonly number[]): void {
  recoveryWaitsMs = waits;
}
