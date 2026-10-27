import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeUrlTags } from "../utils/validation.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import {
  PlanError,
  planContentEdit,
  type ContentChanges,
  type ContentPlan,
  type FieldChange,
  type PlanErrorCode,
  type PostEdit,
  type ReasonCode,
} from "../meta/ad-content.js";
import { grantedPermissions } from "../meta/page-token.js";
import {
  editPost,
  findPostUsers,
  hasServableTemporary,
  POST_EDIT_BUDGET_MS,
  realClock,
  type Clock,
  type PostEditOutcome,
  type PostUser,
} from "../meta/post-edit.js";
import { claimPostEditLease, releasePostEditLease } from "../store/post-edit-lease.js";

interface PostEditLeases {
  claim(postId: string, holder: string): Promise<boolean>;
  release(postId: string, holder: string): Promise<void>;
}

const sharedLeases: PostEditLeases = { claim: claimPostEditLease, release: releasePostEditLease };
import {
  createReplacementCreative,
  deleteCreative,
  errorMessage,
  groupAdsByCreative,
  readCreativeForRebuild,
  repointGroup,
  type CreativeGroup,
  type FailedAd,
  type UpdatedAd,
} from "../meta/creative-rebuild.js";
import { readEngagement, type Engagement } from "../meta/post-engagement.js";
import type { AdCreative } from "../meta/types/index.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, exactLine, singleLine } from "../utils/single-line.js";
import { ctaEnum } from "./creatives.js";
import { UPDATE, WRITE_WARNING } from "./_register.js";

const textChange = (label: string) =>
  z
    .object({
      set: z.array(z.string()).min(1).max(5).optional().describe(`Replace every ${label} with these`),
      add: z.array(z.string()).min(1).max(5).optional().describe(`${label}s to add`),
      remove: z.array(z.string()).min(1).max(5).optional().describe(`${label}s to remove, by exact text`),
    })
    .optional()
    .describe(`Changes to the ${label}s: set replaces all, then remove, then add. At most 5 remain.`);

// The JSON block carries these without their messages, which can quote ad
// copy; the messages appear only inside the fenced summary.
interface PlanningProblem {
  creative_id: string;
  ad_ids: string[];
  code: PlanErrorCode | "invalid_change";
  message: string;
}

type KindedFailure = FailedAd & {
  kind: "read_failed" | "create_failed" | "repoint_failed" | "changed_meanwhile" | "post_edit_failed" | "left_on_temporary";
};

// Every ad of the account on the post a route-B plan edits, with each one's
// creative, read for the preview and bound by the plan_token.
interface PostScope {
  account_id: string;
  post: PostEdit;
  users: PostUser[];
  creatives: Record<string, AdCreative>;
}

interface GroupReport {
  creative_id: string;
  ad_ids: string[];
  route?: ContentPlan["route"];
  before: ContentPlan["before"];
  after: ContentPlan["after"];
  social_proof?: ContentPlan["social_proof"];
  field_changes: FieldChange[];
  engagement?: Engagement;
  reason?: string;
  reason_code?: ReasonCode;
  blocking: boolean;
  warnings: string[];
  // The replacement that would be sent; it only feeds the plan_token.
  body?: Record<string, string>;
  post_edit?: PostEdit;
  post_scope?: PostScope;
}

const NUMERIC_ID = /^\d+$/;
// Every ad on an edited post moves off it and back, each move a bounded call
// that may need a read back: past this many, moving them all back at worst no
// longer fits in the request's time limit next to the edit itself.
const MAX_POST_EDIT_ADS = 5;

// Binds an apply call to the dry run the person saw: the same ads, source
// creatives, routes and replacement bodies, and the same problems. Creatives
// are immutable, so the same source creative gives the same body.
function planToken(reports: GroupReport[], planningErrors: PlanningProblem[], failed: KindedFailure[]): string {
  const postScope = (r: GroupReport) => r.post_scope && [
    r.post_scope.post.post_id,
    ["text", r.post_scope.post.message],
    r.post_scope.users.map((u) => [u.ad_id, u.creative_id, u.status]),
  ];
  const plan = {
    plans: reports.map((r) => [
      r.creative_id, r.ad_ids, r.route ?? null, r.reason_code ?? null,
      r.body ? canonicalBody(r.body) : null, postScope(r) ?? null,
    ]),
    planning_errors: planningErrors.map((p) => [p.creative_id, p.ad_ids, p.code]),
    unreadable: failed.map((f) => f.ad_id),
  };
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 32);
}

// The body fields the rebuild writes with JSON.stringify. Every other field
// (name, url_tags, link_url, IDs) is text Meta receives as is.
const JSON_BODY_FIELDS = new Set([
  "object_story_spec", "asset_feed_spec", "degrees_of_freedom_spec", "destination_spec",
  "wamo_whatsapp_identity_spec", "contextual_multi_ads", "platform_customizations", "adlabels",
]);

// Key order is not part of a plan: Meta may return the same creative with its
// keys in another order, and the JSON fields inherit that order. Text fields
// are compared literally, tagged apart from JSON ones, so no text can stand in
// for another value.
function canonicalBody(body: Record<string, string>): unknown {
  return Object.keys(body).sort().map((key) => {
    const value = body[key];
    if (!JSON_BODY_FIELDS.has(key)) return [key, "text", value];
    try {
      return [key, "json", sortKeys(JSON.parse(value))];
    } catch {
      return [key, "text", value];
    }
  });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}

// The JSON block is built from these projections only: IDs, codes, field
// names and numbers. Ad copy, URLs, Meta's messages and any other text stay in
// the fenced summary.
function planJson(report: GroupReport) {
  const count = (copy: GroupReport["before"]) => ({
    primary: copy.primary.length, headlines: copy.headlines.length, descriptions: copy.descriptions.length,
  });
  const engagement = report.engagement && {
    facebook: report.engagement.facebook,
    instagram: report.engagement.instagram,
    unavailable: report.engagement.unavailable.length > 0 ? report.engagement.unavailable : undefined,
  };
  return {
    creative_id: report.creative_id,
    ad_ids: report.ad_ids,
    route: report.route,
    blocking: report.blocking,
    reason_code: report.reason_code,
    social_proof: report.social_proof,
    changed_fields: report.field_changes.map((change) => change.field),
    text_option_counts: { before: count(report.before), after: count(report.after) },
    engagement,
    post_edit: report.post_scope && {
      post_id: report.post_scope.post.post_id,
      affected_ad_ids: report.post_scope.users.map((u) => u.ad_id),
      instagram_reset_ad_ids: instagramResetAds(report.post_scope),
    },
    warning_count: report.warnings.length,
  };
}

function failureJson(failure: KindedFailure) {
  return { ad_id: failure.ad_id, kind: failure.kind, code: failure.code, new_creative_id: failure.new_creative_id };
}

function postEditJson(outcome: PostEditOutcome) {
  return {
    edited: outcome.edited,
    edit_unconfirmed: outcome.edit_unconfirmed,
    stage: outcome.stage,
    temporary_creative_id: outcome.temporary_creative_id,
    temporary_deleted: outcome.temporary_deleted,
    new_creatives: outcome.new_creatives,
    ads: outcome.ads.map((a) => ({
      ad_id: a.ad_id, outcome: a.outcome, creative_id: a.creative_id,
      previous_creative_id: a.previous_creative_id, instagram: a.instagram,
    })),
  };
}

// Ads whose creative created the post: once it is edited they move to a
// creative reusing it, with a new Instagram media.
function instagramResetAds(scope: PostScope): string[] {
  return scope.users.filter((u) => scope.creatives[u.creative_id]?.object_story_spec).map((u) => u.ad_id);
}

// A route-B plan needs the permission to edit the post and every ad of the
// account on it, and runs on its own. Each check that fails turns the plan
// into a refusal with a code.
async function preparePostEdits(entries: Array<{ report: GroupReport; creative: AdCreative; group: CreativeGroup }>): Promise<void> {
  const edits = entries.filter((e) => e.report.route === "edit_post" && e.report.post_edit);
  if (edits.length === 0) return;
  const refuse = (reason_code: ReasonCode, reason: string) => {
    for (const { report } of edits) {
      Object.assign(report, { route: undefined, social_proof: undefined, blocking: true, reason_code, reason });
    }
  };
  const post = edits[0].report.post_edit!;
  const accountId = edits[0].group.account_id;
  const alone = edits.every((e) => e.report.post_edit!.post_id === post.post_id && e.report.post_edit!.message === post.message && e.group.account_id === accountId)
    && entries.every((e) => !e.report.route || e.report.route === "edit_post");
  if (!alone) {
    return refuse("post_edit_alone", "a post edit runs on its own: one post and one new text per call, with no other change in the same call");
  }

  let granted: Set<string>;
  try {
    granted = await grantedPermissions();
  } catch {
    return refuse("post_edit_permission", "it could not be confirmed that the token has pages_manage_posts, which editing a post needs");
  }
  if (!granted.has("pages_manage_posts")) {
    return refuse("post_edit_permission", "the token lacks pages_manage_posts, which editing a post needs. The person has to re-authorize with it (the server asks for it when META_OAUTH_EXTRA_SCOPES lists it), or use allow_new_post instead");
  }

  let users: PostUser[];
  try {
    const found = await findPostUsers(accountId, post.post_id);
    if (!found.complete) return refuse("post_edit_scan_incomplete", "the account has too many ads to find every one using this post");
    users = found.users;
  } catch {
    return refuse("post_edit_scan_incomplete", "the account's ads could not be read to find every one using this post");
  }
  if (users.length > MAX_POST_EDIT_ADS) {
    return refuse("post_edit_too_many_ads", `${users.length} ads use this post; editing it moves every one of them off it and back, which is limited to ${MAX_POST_EDIT_ADS} so the call finishes in time`);
  }
  const requested = edits.flatMap((e) => e.report.ad_ids);
  if (requested.some((id) => !users.some((u) => u.ad_id === id))) {
    return refuse("post_edit_scan_incomplete", "an ad of this request is not in the account's ad list, so the ads using the post cannot all be found");
  }

  const creatives: Record<string, AdCreative> = Object.fromEntries(edits.map((e) => [e.report.creative_id, e.creative]));
  for (const creativeId of new Set(users.map((u) => u.creative_id))) {
    if (creatives[creativeId]) continue;
    try {
      creatives[creativeId] = await readCreativeForRebuild(creativeId, ["body", "title"]);
    } catch {
      return refuse("post_edit_scan_incomplete", `creative ${creativeId}, used by an ad on this post, could not be read`);
    }
  }
  // Active ads keep running on the temporary creative while the post is
  // edited, so it has to be a real copy of the ad.
  if (users.some((u) => u.status === "ACTIVE") && !hasServableTemporary({ users, creatives })) {
    return refuse("post_edit_no_temporary", "an active ad uses this post and no creative on it can be copied to keep it running while the post is edited (it is a promoted post). Pause those ads first, or use allow_new_post");
  }
  const scope: PostScope = { account_id: accountId, post, users, creatives };
  for (const { report } of edits) report.post_scope = scope;
}

export function registerAdContentTools(server: McpServer, options: { clock?: Clock; leases?: PostEditLeases } = {}): void {
  const clock = options.clock ?? realClock;
  const leases = options.leases ?? sharedLeases;
  server.registerTool(
    "ads_update_ad_content",
    {
      description: `${WRITE_WARNING}Change the copy, link, button or media of live ads: add, remove or replace primary texts, headlines and descriptions, including removing one option of several. Meta creatives are immutable, so each ad gets a replacement creative and goes back through review; the ad keeps its ID, history and previous creative (point it back with ads_update_ad to undo, which brings its post back too). Likes, comments and shares live on the ad's post. When only primary texts change and at least two remain, the ad keeps its Facebook post and that engagement (its Instagram side starts over and the Facebook headline stays the post's own). Anything else creates a new post, which resets the visible engagement, and only happens with allow_new_post: true. With allow_post_edit: true, an ad with one primary text (an image or link ad, or a promoted post) can instead have its post itself edited: the Facebook post and its engagement stay, and Instagram too when the ad reuses the post rather than having created it. The new text then shows on every ad using the post, which the preview lists; while the post is edited (about a minute) active ads keep running on a temporary copy of the ad with the new text; headline and description cannot change this way; one post per call, with no other change, at most 5 ads on the post, and one edit of a post at a time; the token needs pages_manage_posts. dry_run defaults to true: the first call shows, per creative, the copy before and after, any link, button, media or url_tags change, the route and the engagement at stake, without changing anything. The preview is read from the replacement that would be sent, so it includes what a change brings along (a video given a new link and no button gets a LEARN_MORE button). Show that to the person and, once they agree, call again with dry_run: false and the plan_token the dry run returned. Only that exact plan is applied: if the ads or the request changed since, nothing is written and the reply is the new preview with a new plan_token. Nothing changes if any ad cannot be read, has an invalid change or would need a route that is not allowed, or if any replacement creative cannot be created: all replacements are created before any ad is repointed. Right before each repoint the ad is read again; an ad someone moved to another creative meanwhile is left untouched. If Meta then refuses to repoint an ad, ads already repointed stay changed, and the response lists each one with its previous creative so it can be undone. Repeating a set, link, button or media change that is already applied does nothing; add and remove are not repeatable, so after a partial failure preview again with only the ads that failed. An ad with per-platform media (platform_customizations) cannot have its image or video changed here. Carousels, dynamic creative and other asset feeds are not supported. Meta lets an ad change creative at most once every 30 seconds (error 613): wait before changing the same ad again.`,
      inputSchema: {
        ad_ids: z.array(z.string()).min(1).max(50).describe("Ad IDs to change (1-50). Ads sharing a creative get one replacement."),
        primary_texts: textChange("primary text"),
        headlines: textChange("headline"),
        descriptions: textChange("description"),
        link_url: z.string().optional().describe("New destination URL"),
        call_to_action_type: ctaEnum.optional().describe("New button type"),
        image_hash: z.string().optional().describe("New image (from ads_upload_ad_image), or a video's new thumbnail"),
        image_url: z.string().optional().describe("New image URL, or a video's new thumbnail. Ignored when image_hash is given."),
        video_id: z.string().optional().describe("New video for a video ad"),
        url_tags: z.string().optional().describe("New UTM query string, applied with the other changes. A leading '?' is stripped."),
        allow_new_post: z
          .boolean()
          .default(false)
          .describe("Allow changes that need a new post. Its likes, comments and shares start from zero."),
        allow_post_edit: z
          .boolean()
          .default(false)
          .describe("Allow editing the ad's post itself to change its one primary text, which keeps the Facebook post and its engagement (Instagram too when the ad reuses the post). Changes the text for every ad on the post. Needs pages_manage_posts."),
        dry_run: z
          .boolean()
          .default(true)
          .describe("Preview only (default). Set false to apply after the person agrees."),
        plan_token: z
          .string()
          .optional()
          .describe("Required with dry_run: false: the plan_token of the dry run the person approved, for the same request. The change is applied only if the plan is still exactly that one."),
      },
      annotations: { ...UPDATE },
    },
    async ({
      ad_ids, primary_texts, headlines, descriptions, link_url, call_to_action_type,
      image_hash, image_url, video_id, url_tags, allow_new_post, allow_post_edit, dry_run, plan_token,
    }) => {
      // A post edit has to be over, ads put back included, before the
      // request's time limit, counting from here.
      const startedAt = clock.now();
      const preview = dry_run !== false;
      if (!preview && !plan_token) {
        throw new Error("dry_run: false needs the plan_token of a dry run of the same request: run it with dry_run: true, show the preview to the person, then pass its plan_token.");
      }
      // Malformed input is named by its position and never repeated, so it
      // cannot reach the reply as framing.
      const badAd = ad_ids.findIndex((id) => !NUMERIC_ID.test(id));
      if (badAd !== -1) throw new Error(`ad_ids[${badAd}] is not an ad ID: ad IDs are numeric.`);
      if (video_id !== undefined && !NUMERIC_ID.test(video_id)) throw new Error("video_id is not a video ID: video IDs are numeric.");
      const changes: ContentChanges = {
        primary_texts, headlines, descriptions, link_url, call_to_action_type,
        image_hash, image_url, video_id,
        url_tags: url_tags === undefined ? undefined : normalizeUrlTags(url_tags),
      };
      if (image_url && !image_hash) {
        try {
          await assertSafePublicUrl(image_url);
        } catch (err) {
          if (err instanceof UnsafeUrlError) {
            throw new Error("Refusing to forward image_url to Meta: it must be a well-formed public https URL, not a local or private address.");
          }
          throw err;
        }
      }

      const grouped = await groupAdsByCreative(ad_ids);
      const { groups } = grouped;
      const failed: KindedFailure[] = grouped.failed.map((f) => ({ ...f, kind: "read_failed" }));
      const reports: GroupReport[] = [];
      const routed: Array<{ report: GroupReport; creative: AdCreative; group: CreativeGroup }> = [];
      const actionable: Array<{ group: CreativeGroup; body: Record<string, string> }> = [];
      const planningErrors: PlanningProblem[] = [];

      for (const group of groups) {
        let creative: AdCreative;
        try {
          creative = await readCreativeForRebuild(group.creative_id, ["body", "title"]);
        } catch (err) {
          for (const adId of group.ad_ids) failed.push({ ad_id: adId, error: errorMessage(err), kind: "read_failed" });
          continue;
        }
        let plan: ContentPlan;
        try {
          plan = planContentEdit(creative, changes, allow_new_post === true, allow_post_edit === true);
        } catch (err) {
          planningErrors.push({
            creative_id: group.creative_id,
            ad_ids: group.ad_ids,
            code: err instanceof PlanError ? err.code : "invalid_change",
            message: errorMessage(err),
          });
          continue;
        }
        const report: GroupReport = {
          creative_id: group.creative_id,
          ad_ids: group.ad_ids,
          route: plan.route,
          before: plan.before,
          after: plan.after,
          social_proof: plan.social_proof,
          field_changes: plan.field_changes ?? [],
          reason: plan.reason,
          reason_code: plan.reason_code,
          blocking: plan.blocking === true,
          warnings: plan.warnings,
          body: plan.body,
          post_edit: plan.post_edit,
        };
        reports.push(report);
        if (plan.route) routed.push({ report, creative, group });
        if (plan.route && plan.body) actionable.push({ group, body: plan.body });
      }
      await preparePostEdits(routed);

      // An apply call writes only the plan the person saw: if the ads or the
      // request changed since that dry run, this call becomes a new preview.
      const token = planToken(reports, planningErrors, failed);
      const planChanged = !preview && plan_token !== token;
      if (preview || planChanged) {
        for (const { report, creative } of routed) {
          if (!report.route) continue;
          report.engagement = await readEngagement(creative.effective_object_story_id, creative.effective_instagram_media_id);
        }
      }

      const updated: UpdatedAd[] = [];
      const warnings: string[] = [];
      const unused: string[] = [];
      const leftover: string[] = [];
      // Every ad has to be read and planned before anything is written, and
      // any ad left out (unreadable, invalid change, refused route) stops the
      // batch: a batch never half-applies on a plan.
      let aborted = planChanged || (!preview && (planningErrors.length > 0 || failed.length > 0 || reports.some((r) => r.blocking)));
      let postEditOutcome: PostEditOutcome | undefined;
      let postEditBusy = false;
      const postScope = reports.find((r) => r.route === "edit_post")?.post_scope;
      // Two edits of one post at once would move each other's ads.
      const leaseHolder = randomUUID();
      if (!preview && !aborted && postScope && !(await leases.claim(postScope.post.post_id, leaseHolder))) {
        aborted = true;
        postEditBusy = true;
      }
      if (!preview && !aborted && postScope) {
        try {
          postEditOutcome = await editPost(postScope, clock, startedAt + POST_EDIT_BUDGET_MS);
        } finally {
          // The report of what was done matters more than the lock, which
          // expires on its own.
          await leases.release(postScope.post.post_id, leaseHolder).catch(() => {
            warnings.push(`The lock on post ${postScope.post.post_id} could not be released: another edit of it may have to wait up to ten minutes.`);
          });
        }
        for (const ad of postEditOutcome.ads) {
          if (ad.outcome === "updated") {
            updated.push({ ad_id: ad.ad_id, old_creative_id: ad.previous_creative_id, new_creative_id: ad.creative_id });
            if (ad.error) warnings.push(`Ad ${ad.ad_id}: ${ad.error}`);
          } else {
            failed.push({
              ad_id: ad.ad_id,
              kind: ad.outcome === "left_on_temporary" ? "left_on_temporary" : "post_edit_failed",
              error: ad.outcome === "left_on_temporary"
                ? `It stays on creative ${ad.creative_id} (the temporary one, unless read back otherwise), and keeps running if it is active: ${ad.error ?? "it could not be moved back"}. Point it at a creative reusing post ${postScope.post.post_id} with ads_update_ad.`
                : `The post was not edited (${ad.outcome === "restored" ? "the ad is back on its creative" : "the ad was not changed"}): ${ad.error ?? postEditOutcome.error ?? "unknown reason"}`,
            });
          }
        }
        if (postEditOutcome.temporary_creative_id && !postEditOutcome.temporary_deleted) leftover.push(postEditOutcome.temporary_creative_id);
      } else if (!preview && !aborted) {
        // Two phases: every replacement creative first (it changes no ad), and
        // only when all of them exist, the repoints.
        const ready: Array<{ group: CreativeGroup; newCreativeId: string }> = [];
        for (const { group, body } of actionable) {
          try {
            ready.push({ group, newCreativeId: await createReplacementCreative(group.account_id, body) });
          } catch (err) {
            for (const adId of group.ad_ids) {
              failed.push({ ad_id: adId, error: `Failed to create the replacement creative: ${errorMessage(err)}`, kind: "create_failed" });
            }
            aborted = true;
            break;
          }
        }
        if (aborted) {
          unused.push(...ready.map((r) => r.newCreativeId));
          for (const id of unused) {
            if (!(await deleteCreative(id))) leftover.push(id);
          }
        } else {
          for (const { group, newCreativeId } of ready) {
            const outcome = await repointGroup(group, newCreativeId, { verifyUnchanged: true });
            updated.push(...outcome.updated);
            failed.push(...outcome.failed.map((f) => ({ ...f, kind: f.code === "changed_meanwhile" ? "changed_meanwhile" as const : "repoint_failed" as const })));
            warnings.push(...outcome.warnings);
          }
        }
      }

      return {
        content: [
          { type: "text", text: summarize(reports, planningErrors, updated, failed, warnings, leftover, { preview, aborted, planChanged, token, postEditOutcome, postEditBusy }) },
          {
            type: "text",
            text: JSON.stringify({
              dry_run: preview,
              aborted,
              plan_changed: planChanged,
              plan_token: token,
              plans: reports.map(planJson),
              planning_errors: planningErrors.map((p) => ({ creative_id: p.creative_id, ad_ids: p.ad_ids, code: p.code })),
              updated: updated.map((u) => ({ ad_id: u.ad_id, old_creative_id: u.old_creative_id, new_creative_id: u.new_creative_id })),
              failed: failed.map(failureJson),
              repoint_notes: warnings.length,
              leftover_creatives: leftover,
              post_edit: postEditBusy ? { busy: true } : postEditOutcome && postEditJson(postEditOutcome),
            }, null, 2),
          },
        ],
      };
    },
  );
}

// The preview is what the person approves, so values are shown exactly (see
// exactLine), one line each, inside the untrusted fence.
const PREVIEW_VALUE_MAX = 1000;

function listCopy(texts: string[]): string {
  return texts.length === 0 ? "(none)" : `[${texts.map((text) => exactLine(text, PREVIEW_VALUE_MAX)).join(", ")}]`;
}

function describeEngagement(engagement: Engagement | undefined): string {
  if (!engagement) return "";
  const parts: string[] = [];
  if (engagement.facebook) {
    parts.push(`Facebook ${engagement.facebook.reactions} reactions, ${engagement.facebook.comments} comments, ${engagement.facebook.shares} shares`);
  }
  if (engagement.instagram) {
    parts.push(`Instagram ${engagement.instagram.likes} likes, ${engagement.instagram.comments} comments`);
  }
  return parts.length > 0 ? ` Engagement now: ${parts.join("; ")}.` : "";
}

function summarize(
  reports: GroupReport[],
  planningErrors: PlanningProblem[],
  updated: UpdatedAd[],
  failed: FailedAd[],
  repointNotes: string[],
  leftover: string[],
  state: { preview: boolean; aborted: boolean; planChanged: boolean; token: string; postEditOutcome?: PostEditOutcome; postEditBusy?: boolean },
): string {
  const lines: string[] = [];
  const editedPost = reports.find((r) => r.route === "edit_post")?.post_scope?.post.post_id;
  if (state.postEditBusy) {
    lines.push(`Nothing was changed: another edit of post ${editedPost} is running. Run a new dry run in a few minutes.`);
  } else if (state.planChanged) {
    lines.push(`Nothing was changed: the plan differs from the dry run that plan_token came from (the ads or the request changed). This is the new plan: show it to the person and apply it with dry_run: false and plan_token: ${state.token}`);
  } else if (state.aborted) {
    lines.push("Nothing was changed: fix the problems below and run a new dry run.");
  } else if (state.preview) {
    lines.push(`Dry run — nothing was changed. Show this to the person; to apply exactly this plan, call again with dry_run: false and plan_token: ${state.token}`);
  } else {
    lines.push(`Updated ${updated.length} ad(s), failed ${failed.length}.`);
  }
  const preview = state.preview;

  for (const report of reports) {
    const ads = report.ad_ids.join(", ");
    if (!report.route) {
      lines.push(`• Ads ${ads}: not changed — ${singleLine(report.reason, 400)}`);
      continue;
    }
    const proof = report.route === "edit_post"
      ? `its post itself gets the new text: it keeps the Facebook post and that post's likes, comments and shares; Instagram ${report.social_proof?.instagram === "kept" ? "keeps its media too" : "starts over"}`
      : report.social_proof?.facebook === "kept"
        ? "keeps its Facebook post and that post's likes, comments and shares; Instagram starts over"
        : "gets a new post: likes, comments and shares start from zero";
    lines.push(`• Ads ${ads} (creative ${report.creative_id}): ${proof}.${describeEngagement(report.engagement)}`);
    for (const warning of report.warnings) lines.push(`  ⚠️ ${warning}`);
    lines.push(ADVERTISER_CONTENT_OPEN);
    lines.push(`Primary texts before: ${listCopy(report.before.primary)}`);
    lines.push(`Primary texts after: ${listCopy(report.after.primary)}`);
    lines.push(`Headlines before: ${listCopy(report.before.headlines)}`);
    lines.push(`Headlines after: ${listCopy(report.after.headlines)}`);
    lines.push(`Descriptions before: ${listCopy(report.before.descriptions)}`);
    lines.push(`Descriptions after: ${listCopy(report.after.descriptions)}`);
    const value = (text: string | undefined) => (text === undefined ? "(none)" : exactLine(text, PREVIEW_VALUE_MAX));
    for (const change of report.field_changes) lines.push(`${change.field}: ${value(change.before)} → ${value(change.after)}`);
    for (const note of report.engagement?.notes ?? []) lines.push(singleLine(note, 400));
    lines.push(ADVERTISER_CONTENT_CLOSE);
  }
  const scope = reports.find((r) => r.route === "edit_post")?.post_scope;
  if (scope && (preview || state.planChanged)) {
    const reset = new Set(instagramResetAds(scope));
    const active = scope.users.filter((u) => u.status === "ACTIVE").map((u) => u.ad_id);
    lines.push("", `Editing post ${scope.post.post_id} changes its text for every ad on it, not only the ones asked for:`);
    for (const user of scope.users) {
      lines.push(`• Ad ${user.ad_id}: Facebook post kept; Instagram ${reset.has(user.ad_id) ? "starts over (its creative created the post, and Meta does not let it come back to that creative once the post is edited)" : "kept"}`);
    }
    lines.push(
      "Headlines and descriptions stay as they are: Meta does not let them be edited on the post.",
      active.length > 0
        ? `The active ads (${active.join(", ")}) keep running: for about a minute, while the post is edited, they show the new text on a temporary copy of the ad (same link and media, on a post of its own), then move back. Every ad goes back through review.`
        : "Every ad goes back through review.",
      "Applying takes one to three minutes. The temporary creative the edit needs is deleted afterwards when Meta allows it; otherwise it stays in the account, with no ad using it.",
    );
  }
  // Problems and Meta's errors can quote ad copy, so they stay one bounded
  // line each, inside the fence.
  if (planningErrors.length > 0) {
    lines.push("", "Problems:", ADVERTISER_CONTENT_OPEN, ...planningErrors.map((p) => `• Creative ${p.creative_id} (ads ${p.ad_ids.join(", ")}): ${singleLine(p.message, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  if (repointNotes.length > 0) {
    lines.push("", "Notes:", ADVERTISER_CONTENT_OPEN, ...repointNotes.map((note) => `• ${singleLine(note, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  if (failed.length > 0) {
    lines.push("", "Failed:", ADVERTISER_CONTENT_OPEN, ...failed.map((f) => `• Ad ${f.ad_id}: ${singleLine(f.error, 400)}`), ADVERTISER_CONTENT_CLOSE);
  }
  const outcome = state.postEditOutcome;
  if (outcome) {
    lines.push("", outcome.edited
      ? `Post ${editedPost} was edited.`
      : outcome.edit_unconfirmed
        ? `Post ${editedPost} may or may not have the new text: Meta's answer to the edit was lost and the post could not be read back. Every ad was moved to a creative that works either way; check the post before editing it again.`
        : `Post ${editedPost} was not edited: it stopped while ${outcome.stage === "edit" ? "editing the post" : `at step "${outcome.stage}"`}, and every ad went back to its creative unless listed under Failed.`);
  }
  for (const id of leftover) {
    if (id !== outcome?.temporary_creative_id) {
      lines.push(`Creative ${id} could not be deleted. No ad uses it; delete it in Ads Manager.`);
      continue;
    }
    const stuck = outcome.ads.filter((a) => a.outcome === "left_on_temporary").map((a) => a.ad_id);
    lines.push(stuck.length > 0
      ? `Creative ${id}, the temporary one, stays in the account and ad${stuck.length > 1 ? "s" : ""} ${stuck.join(", ")} may still be on it (see Failed).`
      : `Creative ${id}, the temporary one the edit needed, stays in the account: Meta refused to delete it. No ad uses it.`);
  }
  if (!preview && updated.length > 0 && outcome) {
    // The text lives on the post, and a creative that created it is refused
    // once it is edited: undoing means editing the post back.
    lines.push("", "Updated ads go back through Meta review. To undo, run ads_update_ad_content again with the previous text and allow_post_edit: true. An Instagram media that started over cannot come back.");
  } else if (!preview && updated.length > 0) {
    lines.push("", "Updated ads go back through Meta review. To undo, point an ad at its previous creative with ads_update_ad:");
    for (const u of updated) lines.push(`• Ad ${u.ad_id}: previous creative ${u.old_creative_id}, new ${u.new_creative_id}`);
  }
  return lines.join("\n");
}
