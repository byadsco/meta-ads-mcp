import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { normalizeAccountId } from "../utils/format.js";
import type { PostEdit } from "./ad-content.js";
import { metaApiClient } from "./client.js";
import {
  asRecord,
  carryOverFields,
  errorMessage,
  hasFeedContent,
  resolveInstagramUserId,
} from "./creative-rebuild.js";
import { withPageToken } from "./page-token.js";
import type { AdCreative } from "./types/index.js";

// Measured on v26.0: Meta refuses to edit a post while any ad uses it, and
// accepts the edit about 40-50 seconds after the last ad moves off it. It
// allows one creative change per ad every 30 seconds.
const CREATIVE_CHANGE_GAP_MS = 31_000;
const EDIT_RETRY_MS = 15_000;
const EDIT_WINDOW_MS = 105_000;
const POST_POLL_MS = 10_000;
const POST_WINDOW_MS = 40_000;
// Every Meta call of an edit is bounded: never retried by the client, not
// sent if pacing would hold it this long, given up after this long. That
// bound, not how fast Meta happened to be, is what the deadline checks count.
const CALL_MS = 10_000;
// A whole edit, putting every ad back included, has to end inside the
// server's 300-second request limit: past it the request dies and nobody is
// told where the ads are.
export const POST_EDIT_BUDGET_MS = 270_000;
const MAX_SCANNED_ADS = 5000;
const TEMPORARY_NAME = "Temporary creative of a post edit (no ad uses it)";
const TOO_SLOW = "There was not enough time left in this call to edit the post and still move every ad back: every ad touched was put back and the post was not edited.";
const STILL_IN_USE = /Failed to edit object/;

export interface PostUser {
  ad_id: string;
  status: string;
  creative_id: string;
}

export interface PostEditInput {
  account_id: string;
  post: PostEdit;
  // Every ad of the account on the post, and each one's creative.
  users: PostUser[];
  creatives: Record<string, AdCreative>;
}

export interface PostEditAd {
  ad_id: string;
  outcome: "updated" | "restored" | "unchanged" | "left_on_temporary";
  creative_id: string;
  previous_creative_id: string;
  instagram: "kept" | "reset";
  // Meta's message: untrusted text.
  error?: string;
}

export interface PostEditOutcome {
  // The post has the new text, confirmed.
  edited: boolean;
  // Meta's answer to the edit was lost and the post did not read back with
  // the new text: it may have the new text or the old one.
  edit_unconfirmed?: boolean;
  stage?: "temporary_creative" | "detach" | "time" | "wait" | "edit";
  error?: string;
  ads: PostEditAd[];
  temporary_creative_id?: string;
  temporary_deleted: boolean;
  new_creatives: string[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Meta offers no filter for the ads on a post, so the account's ads are read
// and filtered here. `complete` is false when there were more than maxAds.
export async function findPostUsers(
  accountId: string,
  postId: string,
  maxAds = MAX_SCANNED_ADS,
): Promise<{ users: PostUser[]; complete: boolean }> {
  const ads = await metaApiClient.getPaginated<{ id: string; status?: string; creative?: { id?: string; effective_object_story_id?: string } }>(
    `/${normalizeAccountId(accountId)}/ads`,
    { fields: "id,status,creative{id,effective_object_story_id}", limit: 500 },
    maxAds + 1,
  );
  const users = ads
    .slice(0, maxAds)
    .filter((ad) => ad.creative?.id && ad.creative.effective_object_story_id === postId)
    .map((ad) => ({ ad_id: ad.id, status: ad.status ?? "", creative_id: ad.creative!.id! }));
  return { users, complete: ads.length <= maxAds };
}

// The spec of the creative that created the post, with the new text: the
// same link, image or video and button, as a different post.
function ownSpecWithText(input: Pick<PostEditInput, "users" | "creatives">, message: string): Record<string, unknown> | undefined {
  for (const user of input.users) {
    const spec = asRecord(input.creatives[user.creative_id]?.object_story_spec);
    for (const key of ["link_data", "video_data"]) {
      const data = asRecord(spec?.[key]);
      if (spec && data) return { ...structuredClone(spec), [key]: { ...structuredClone(data), message } };
    }
  }
  return undefined;
}

// Active ads keep running on the temporary creative while the post is edited,
// so it has to be a real copy of the ad. Only when no creative on the post
// created it (a promoted post) is there nothing to copy.
export function hasServableTemporary(input: Pick<PostEditInput, "users" | "creatives">): boolean {
  return ownSpecWithText(input, "") !== undefined;
}

// The ads wait on a creative of their own post while the post is edited: the
// own spec with the new text, or, when only creatives reusing the post use it
// and every ad is paused, a plain link to the Page.
function temporarySpec(input: PostEditInput): Record<string, unknown> {
  const own = ownSpecWithText(input, input.post.message);
  if (own) return own;
  const spec: Record<string, unknown> = {
    page_id: input.post.page_id,
    link_data: { link: `https://www.facebook.com/${input.post.page_id}`, message: input.post.message },
  };
  for (const user of input.users) {
    const instagramUserId = resolveInstagramUserId(input.creatives[user.creative_id] ?? ({} as AdCreative));
    if (instagramUserId) return { ...spec, instagram_user_id: instagramUserId };
  }
  return spec;
}

// Once the post is edited Meta refuses the creative that created it
// (subcode 1815697), so its ads move to one reusing the post with everything
// it carried. Its Instagram media is a new one.
function reusingCreativeBody(own: AdCreative, postId: string): Record<string, string> {
  const body: Record<string, string> = { object_story_id: postId };
  if (own.name) body.name = own.name;
  const instagramUserId = resolveInstagramUserId(own);
  if (instagramUserId) body.instagram_user_id = instagramUserId;
  if (hasFeedContent(own)) body.asset_feed_spec = JSON.stringify(own.asset_feed_spec);
  Object.assign(body, carryOverFields(own).body);
  if (own.url_tags) body.url_tags = own.url_tags;
  return body;
}

// Meta answered and turned the call down, or it was never sent: nothing was
// written. Anything else (a lost answer, a timeout, Meta's own "unknown
// error" or "service unavailable") may hide a write that went through.
function wasRefused(err: unknown): boolean {
  return err instanceof McpError && (err.code === ErrorCode.InvalidParams || err.code === ErrorCode.InvalidRequest);
}

/**
 * Edits the message of a post that ads use (route B). Meta refuses the edit
 * while any ad uses the post, so every ad on it moves to a temporary creative
 * (a copy of the ad with the new text, so active ads keep running), the post
 * is edited with a Page token, and each ad moves back: to its own creative
 * when that creative reuses the post, to a new creative reusing the post when
 * its own created it. No ad's status is changed. Any failure before the edit
 * puts every ad back. An ad that cannot be moved back stays on the temporary
 * creative, and the outcome says so. Every Meta call is bounded, and before
 * each step the edit checks that moving every ad back still ends before
 * `deadline`.
 */
export async function editPost(
  input: PostEditInput,
  clock: Clock = realClock,
  deadline: number = clock.now() + POST_EDIT_BUDGET_MS,
): Promise<PostEditOutcome> {
  const { post } = input;
  const accountId = normalizeAccountId(input.account_id);
  const bounded = { accountId, timeoutMs: CALL_MS };
  const ads = new Map<string, PostEditAd>(input.users.map((u) => [u.ad_id, {
    ad_id: u.ad_id,
    outcome: "unchanged",
    creative_id: u.creative_id,
    previous_creative_id: u.creative_id,
    instagram: "kept",
  }]));
  const result: PostEditOutcome = { edited: false, ads: [...ads.values()], temporary_deleted: false, new_creatives: [] };

  // Returns Meta's message when the write failed.
  const pointAt = async (adId: string, creativeId: string): Promise<string | undefined> => {
    try {
      await metaApiClient.postForm(`/${adId}`, { creative: JSON.stringify({ creative_id: creativeId }) }, bounded);
      return undefined;
    } catch (err) {
      return errorMessage(err);
    }
  };
  // undefined when it cannot be read.
  const creativeOf = async (adId: string): Promise<string | undefined> => {
    try {
      return (await metaApiClient.get<{ creative?: { id?: string } }>(`/${adId}`, { fields: "creative{id}" }, bounded)).creative?.id;
    } catch {
      return undefined;
    }
  };
  const createCreative = async (body: Record<string, string>) =>
    (await metaApiClient.postForm<{ id: string }>(`/${accountId}/adcreatives`, body, bounded)).id;
  // Moving `count` ads back at worst: the 30-second gap, a write and a read
  // back for each, then deleting the temporary creative.
  const putBackCost = (count: number) => CREATIVE_CHANGE_GAP_MS + (2 * count + 1) * CALL_MS;

  if (clock.now() + CALL_MS + putBackCost(0) > deadline) return { ...result, stage: "time", error: TOO_SLOW };
  let temporary: string;
  try {
    temporary = await createCreative({ name: TEMPORARY_NAME, object_story_spec: JSON.stringify(temporarySpec(input)) });
  } catch (err) {
    return { ...result, stage: "temporary_creative", error: errorMessage(err) };
  }
  result.temporary_creative_id = temporary;

  const detachedAt = new Map<string, number>();
  // Own creative -> its new creative reusing the post, once the post is edited.
  const replacements = new Map<string, string>();

  const putBack = async (targetOf: (user: PostUser) => string | undefined, outcome: PostEditAd["outcome"], noTarget: string) => {
    for (const user of input.users) {
      const since = detachedAt.get(user.ad_id);
      if (since === undefined) continue;
      const ad = ads.get(user.ad_id)!;
      const target = targetOf(user);
      if (!target) {
        Object.assign(ad, { outcome: "left_on_temporary", creative_id: temporary, instagram: "reset", error: noTarget });
        continue;
      }
      const wait = since + CREATIVE_CHANGE_GAP_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const error = await pointAt(user.ad_id, target);
      // The answer may be lost with the write applied.
      const now = error === undefined ? target : await creativeOf(user.ad_id);
      if (now === target) {
        Object.assign(ad, { creative_id: target, outcome });
        continue;
      }
      Object.assign(ad, {
        outcome: "left_on_temporary",
        creative_id: now ?? temporary,
        instagram: "reset",
        error: now === undefined ? `${error} Its creative could not be read back.` : error,
      });
    }
  };

  const finish = async (): Promise<PostEditOutcome> => {
    try {
      await metaApiClient.delete(`/${temporary}`, undefined, bounded);
      result.temporary_deleted = true;
    } catch {
      result.temporary_deleted = false;
    }
    return result;
  };

  const stopAndRestore = async (stage: NonNullable<PostEditOutcome["stage"]>, error: string): Promise<PostEditOutcome> => {
    result.stage = stage;
    result.error = error;
    await putBack((user) => user.creative_id, "restored", "It could not be moved back.");
    return finish();
  };

  for (const user of input.users) {
    // The move, a read back if it fails, and moving everything back after it.
    if (clock.now() + 2 * CALL_MS + putBackCost(detachedAt.size + 1) > deadline) return stopAndRestore("time", TOO_SLOW);
    const error = await pointAt(user.ad_id, temporary);
    const now = error === undefined ? temporary : await creativeOf(user.ad_id);
    if (now === temporary) {
      detachedAt.set(user.ad_id, clock.now());
      continue;
    }
    const ad = ads.get(user.ad_id)!;
    ad.error = error;
    // Unreadable, it may be on the temporary creative: it is moved back like
    // the ones that did move.
    if (now === undefined) detachedAt.set(user.ad_id, clock.now());
    else ad.creative_id = now;
    return stopAndRestore("detach", error ?? "It could not be moved off the post.");
  }

  // Once the post is edited every ad has to go back, through a new creative
  // for each own one: that, and one last read of the post, have to fit.
  const ownCreatives = new Set(input.users.map((u) => u.creative_id).filter((id) => input.creatives[id]?.object_story_spec));
  const editUntil = Math.min(clock.now() + EDIT_WINDOW_MS, deadline - ownCreatives.size * CALL_MS - putBackCost(input.users.length) - CALL_MS);

  // The temporary creative has to free the post: a creative Meta matched to
  // the same post would keep it in use and the edit would never go through.
  const temporaryPost = await waitForPost(temporary, clock, Math.min(clock.now() + POST_WINDOW_MS, editUntil - 3 * CALL_MS), bounded);
  if (temporaryPost === post.post_id) {
    return stopAndRestore("wait", "The temporary creative uses the same post, so the post stays in use and cannot be edited.");
  }
  // The Page token, one attempt and a read back.
  if (clock.now() + 3 * CALL_MS > editUntil) return stopAndRestore("time", TOO_SLOW);

  let edit: { state: "edited" | "not_edited" | "unknown"; error?: string };
  try {
    edit = await withPageToken(post.page_id, () => editMessage(post, clock, editUntil), CALL_MS);
  } catch (err) {
    // No Page token, so nothing was sent.
    return stopAndRestore("edit", errorMessage(err));
  }
  if (edit.state === "not_edited") return stopAndRestore("edit", edit.error ?? "The post was not edited.");
  result.edited = edit.state === "edited";
  if (edit.state === "unknown") {
    // A creative reusing the post carries the ads whether or not the edit
    // went through, while the creative that created it is refused if it did.
    result.edit_unconfirmed = true;
    result.error = edit.error;
  }

  const replacementErrors = new Map<string, string>();
  for (const creativeId of ownCreatives) {
    try {
      const id = await createCreative(reusingCreativeBody(input.creatives[creativeId], post.post_id));
      replacements.set(creativeId, id);
      result.new_creatives.push(id);
    } catch (err) {
      replacementErrors.set(creativeId, `Its new creative reusing the post could not be created: ${errorMessage(err)}`);
    }
  }
  for (const user of input.users) {
    if (replacements.has(user.creative_id)) ads.get(user.ad_id)!.instagram = "reset";
  }
  await putBack(
    (user) => (ownCreatives.has(user.creative_id) ? replacements.get(user.creative_id) : user.creative_id),
    "updated",
    "Its new creative reusing the post could not be created.",
  );
  for (const user of input.users) {
    const error = replacementErrors.get(user.creative_id);
    const ad = ads.get(user.ad_id)!;
    if (error && ad.outcome === "left_on_temporary") ad.error = error;
  }
  return finish();
}

async function waitForPost(
  creativeId: string,
  clock: Clock,
  until: number,
  bounded: { accountId: string; timeoutMs: number },
): Promise<string | undefined> {
  while (clock.now() + CALL_MS <= until) {
    try {
      const creative = await metaApiClient.get<{ effective_object_story_id?: string }>(`/${creativeId}`, { fields: "effective_object_story_id" }, bounded);
      if (creative.effective_object_story_id) return creative.effective_object_story_id;
    } catch {
      // Not readable yet: keep waiting.
    }
    if (clock.now() + POST_POLL_MS + CALL_MS > until) return undefined;
    await clock.sleep(POST_POLL_MS);
  }
  return undefined;
}

// Runs with the Page token. Meta turning the edit down wrote nothing; any
// other failure may hide an edit that went through, and stays that way even
// if a later attempt is turned down: only the new text read back counts as
// edited, anything else as unknown.
async function editMessage(post: PostEdit, clock: Clock, until: number): Promise<{ state: "edited" | "not_edited" | "unknown"; error?: string }> {
  let ambiguous = false;
  let error: string | undefined;
  while (clock.now() + 2 * CALL_MS <= until) {
    try {
      await metaApiClient.postForm(`/${post.post_id}`, { message: post.message }, { timeoutMs: CALL_MS });
      return { state: "edited" };
    } catch (err) {
      error = errorMessage(err);
      if (!wasRefused(err)) {
        ambiguous = true;
        if (await hasNewText(post)) return { state: "edited" };
      } else if (!STILL_IN_USE.test(error)) {
        break;
      }
    }
    if (clock.now() + EDIT_RETRY_MS + 2 * CALL_MS > until) break;
    await clock.sleep(EDIT_RETRY_MS);
  }
  if (!ambiguous) return { state: "not_edited", error: error ?? "There was no time left to edit the post." };
  return { state: (await hasNewText(post)) ? "edited" : "unknown", error };
}

async function hasNewText(post: PostEdit): Promise<boolean> {
  try {
    const read = await metaApiClient.get<{ message?: string }>(`/${post.post_id}`, { fields: "message" }, { timeoutMs: CALL_MS });
    return (read.message ?? "").trim() === post.message.trim();
  } catch {
    return false;
  }
}
