import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { normalizeAccountId } from "../utils/format.js";
import type { PostEdit } from "./ad-content.js";
import { metaApiClient } from "./client.js";
import {
  asRecord,
  carryOverFields,
  createReplacementCreative,
  deleteCreative,
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
// What a Meta call is assumed to take until a slower one is seen.
const MIN_CALL_MS = 2_000;
// A whole edit has to end inside the server's 300-second request limit: past
// it the request dies and nobody is told which ads are still paused. Before
// every step the edit checks that what it already did can still be put back
// by then, at the pace of the slowest Meta call so far.
export const POST_EDIT_BUDGET_MS = 240_000;
const MAX_SCANNED_ADS = 5000;
const TEMPORARY_NAME = "Temporary creative of a post edit (no ad uses it)";
const TOO_SLOW = "Meta answered too slowly for the edit to finish within one call: every ad touched was put back and the post was not edited.";

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
  // Paused for the edit and active again.
  resumed: boolean;
  // Meta's message: untrusted text.
  error?: string;
}

export interface PostEditOutcome {
  // The post has the new text, confirmed.
  edited: boolean;
  // Meta's answer to the edit was lost and the post did not read back with
  // the new text: it may have the new text or the old one.
  edit_unconfirmed?: boolean;
  stage?: "temporary_creative" | "pause" | "detach" | "time" | "wait" | "edit";
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

// The ads wait on a creative of their own post while the post is edited: the
// spec of the creative that created the post with the new text (a different
// spec, so Meta makes it a different post), or a plain link to the Page when
// only creatives reusing the post use it.
function temporarySpec(input: PostEditInput): Record<string, unknown> {
  for (const user of input.users) {
    const spec = asRecord(input.creatives[user.creative_id]?.object_story_spec);
    const linkData = asRecord(spec?.link_data);
    if (spec && linkData) {
      return { ...structuredClone(spec), link_data: { ...structuredClone(linkData), message: input.post.message } };
    }
  }
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

// Meta answered and turned the write down, so nothing was written. Anything
// else (a lost answer, a timeout, Meta's own "unknown error" or "service
// unavailable") may hide a write that went through.
function wasRefused(err: unknown): boolean {
  return err instanceof McpError && (err.code === ErrorCode.InvalidParams || err.code === ErrorCode.InvalidRequest);
}

/**
 * Edits the message of a post that ads use (route B). Meta refuses the edit
 * while any ad uses the post, so every ad on it pauses (the active ones) and
 * moves to a temporary creative, the post is edited with a Page token, and
 * each ad moves back: to its own creative when that creative reuses the post,
 * to a new creative reusing the post when its own created it. An ad paused
 * here is resumed in the same write that moves it back, so it is never active
 * on a creative that write did not just set. Any failure before the edit puts
 * every ad back as it was. An ad that cannot be moved back stays paused on
 * the temporary creative, and the outcome says so. `deadline` is when the
 * whole edit, putting things back included, has to be over.
 */
export async function editPost(
  input: PostEditInput,
  clock: Clock = realClock,
  deadline: number = clock.now() + POST_EDIT_BUDGET_MS,
): Promise<PostEditOutcome> {
  const { post } = input;
  const scope = { accountId: normalizeAccountId(input.account_id) };
  const ads = new Map<string, PostEditAd>(input.users.map((u) => [u.ad_id, {
    ad_id: u.ad_id,
    outcome: "unchanged",
    creative_id: u.creative_id,
    previous_creative_id: u.creative_id,
    instagram: "kept",
    resumed: false,
  }]));
  const result: PostEditOutcome = { edited: false, ads: [...ads.values()], temporary_deleted: false, new_creatives: [] };

  let slowest = MIN_CALL_MS;
  const timed = async <T>(call: () => Promise<T>): Promise<T> => {
    const start = clock.now();
    try {
      return await call();
    } finally {
      slowest = Math.max(slowest, clock.now() - start);
    }
  };
  // Returns Meta's message when the write failed.
  const update = async (adId: string, params: Record<string, string>): Promise<string | undefined> => {
    try {
      await timed(() => metaApiClient.postForm(`/${adId}`, params, scope));
      return undefined;
    } catch (err) {
      return errorMessage(err);
    }
  };
  const readAd = async (adId: string) => {
    try {
      return await timed(() => metaApiClient.get<{ status?: string; creative?: { id?: string } }>(`/${adId}`, { fields: "status,creative{id}" }));
    } catch {
      return undefined;
    }
  };

  let temporary: string;
  try {
    temporary = await timed(() => createReplacementCreative(input.account_id, { name: TEMPORARY_NAME, object_story_spec: JSON.stringify(temporarySpec(input)) }));
  } catch (err) {
    return { ...result, stage: "temporary_creative", error: errorMessage(err) };
  }
  result.temporary_creative_id = temporary;

  const paused = new Set<string>();
  const detachedAt = new Map<string, number>();
  // Own creative -> its new creative reusing the post, once the post is edited.
  const replacements = new Map<string, string>();
  // Whether one more step, then putting back `pending` ads, still ends in time.
  const overruns = (pending: number) => clock.now() + (pending + 1) * slowest + CREATIVE_CHANGE_GAP_MS > deadline;

  const putBack = async (targetOf: (user: PostUser) => string | undefined, outcome: PostEditAd["outcome"], noTarget: string) => {
    for (const user of input.users) {
      const ad = ads.get(user.ad_id)!;
      const since = detachedAt.get(user.ad_id);
      const resume = paused.has(user.ad_id);
      if (since === undefined) {
        if (!resume) continue;
        // Never moved off its creative: only the pause is undone, and only
        // while the ad is still on its own creative.
        if (ad.creative_id !== user.creative_id) {
          ad.error = `It stays paused: it is on creative ${ad.creative_id}, not its own, so this edit does not resume it.`;
          continue;
        }
        const error = await update(user.ad_id, { status: "ACTIVE" });
        if (error === undefined) ad.resumed = true;
        else ad.error = `It stays paused: it could not be resumed (${error}).`;
        continue;
      }
      const target = targetOf(user);
      if (!target) {
        Object.assign(ad, { outcome: "left_on_temporary", creative_id: temporary, instagram: "reset", error: noTarget });
        continue;
      }
      const wait = since + CREATIVE_CHANGE_GAP_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const params: Record<string, string> = { creative: JSON.stringify({ creative_id: target }) };
      if (resume) params.status = "ACTIVE";
      const error = await update(user.ad_id, params);
      if (error === undefined) {
        Object.assign(ad, { creative_id: target, outcome, resumed: resume });
        continue;
      }
      // The answer may be lost with the write applied.
      const now = await readAd(user.ad_id);
      if (now?.creative?.id === target) {
        Object.assign(ad, { creative_id: target, outcome, resumed: resume && now.status === "ACTIVE" });
        if (resume && now.status !== "ACTIVE") ad.error = `It is back on creative ${target} but stays paused: ${error}`;
        continue;
      }
      Object.assign(ad, { outcome: "left_on_temporary", creative_id: now?.creative?.id ?? temporary, instagram: "reset", resumed: false, error });
    }
  };

  const finish = async (): Promise<PostEditOutcome> => {
    result.temporary_deleted = await deleteCreative(temporary);
    return result;
  };

  const stopAndRestore = async (stage: NonNullable<PostEditOutcome["stage"]>, error: string): Promise<PostEditOutcome> => {
    result.stage = stage;
    result.error = error;
    await putBack((user) => user.creative_id, "restored", "It could not be moved back.");
    return finish();
  };

  for (const user of input.users.filter((u) => u.status === "ACTIVE")) {
    if (overruns(paused.size + 1)) return stopAndRestore("time", TOO_SLOW);
    const error = await update(user.ad_id, { status: "PAUSED" });
    if (error === undefined) {
      paused.add(user.ad_id);
      continue;
    }
    // A write can reach Meta with only its answer lost: unless the ad reads
    // back active it counts as paused, and its pause is undone like the rest.
    const now = await readAd(user.ad_id);
    const ad = ads.get(user.ad_id)!;
    if (now?.status !== "ACTIVE") paused.add(user.ad_id);
    if (now === undefined) ad.error = "Its pause could not be confirmed either way: it may be paused.";
    else if (now.creative?.id) ad.creative_id = now.creative.id;
    return stopAndRestore("pause", error);
  }

  for (const user of input.users) {
    if (overruns(new Set([...paused, ...detachedAt.keys(), user.ad_id]).size)) return stopAndRestore("time", TOO_SLOW);
    const error = await update(user.ad_id, { creative: JSON.stringify({ creative_id: temporary }) });
    if (error === undefined) {
      detachedAt.set(user.ad_id, clock.now());
      continue;
    }
    const now = await readAd(user.ad_id);
    if (now?.creative?.id === temporary) {
      detachedAt.set(user.ad_id, clock.now());
      continue;
    }
    const ad = ads.get(user.ad_id)!;
    ad.error = error;
    // Unreadable, it may be on the temporary creative: it is moved back like
    // the ones that did move.
    if (now === undefined) detachedAt.set(user.ad_id, clock.now());
    else if (now.creative?.id) ad.creative_id = now.creative.id;
    return stopAndRestore("detach", error);
  }

  // Once the post is edited every ad has to go back, through a new creative
  // for each own one: that has to fit before the deadline too.
  const ownCreatives = new Set(input.users.map((u) => u.creative_id).filter((id) => input.creatives[id]?.object_story_spec));
  const afterEdit = () => (ownCreatives.size + input.users.length + 1) * slowest + CREATIVE_CHANGE_GAP_MS;

  // The temporary creative has to free the post: a creative Meta matched to
  // the same post would keep it in use and the edit would never go through.
  const temporaryPost = await waitForPost(temporary, clock, Math.min(clock.now() + POST_WINDOW_MS, deadline - afterEdit()));
  if (temporaryPost === post.post_id) {
    return stopAndRestore("wait", "The temporary creative uses the same post, so the post stays in use and cannot be edited.");
  }
  const editDeadline = Math.min(clock.now() + EDIT_WINDOW_MS, deadline - afterEdit());
  if (editDeadline <= clock.now()) return stopAndRestore("time", TOO_SLOW);

  // Meta turning the edit down wrote nothing. Any other failure may hide an
  // edit that went through, so only the new text read back counts as edited
  // and anything else is unknown: the ads then go on as if it was edited,
  // because a creative reusing the post carries them either way, while the
  // creative that created the post is refused once the post was edited.
  let editError: string | undefined;
  let editState: "edited" | "not_edited" | "unknown";
  try {
    editState = await withPageToken(post.page_id, async () => {
      try {
        await editMessage(post, clock, editDeadline);
        return "edited" as const;
      } catch (err) {
        editError = errorMessage(err);
        if (wasRefused(err)) return "not_edited" as const;
        const now = await readMessage(post.post_id);
        return now !== undefined && now.trim() === post.message.trim() ? "edited" as const : "unknown" as const;
      }
    });
  } catch (err) {
    // No Page token, so nothing was sent.
    return stopAndRestore("edit", errorMessage(err));
  }
  if (editState === "not_edited") return stopAndRestore("edit", editError ?? "The post was not edited.");
  result.edited = editState === "edited";
  if (editState === "unknown") {
    result.edit_unconfirmed = true;
    result.error = editError;
  }

  const replacementErrors = new Map<string, string>();
  for (const creativeId of ownCreatives) {
    try {
      const id = await timed(() => createReplacementCreative(input.account_id, reusingCreativeBody(input.creatives[creativeId], post.post_id)));
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

async function readMessage(postId: string): Promise<string | undefined> {
  try {
    return (await metaApiClient.get<{ message?: string }>(`/${postId}`, { fields: "message" })).message ?? "";
  } catch {
    return undefined;
  }
}

async function waitForPost(creativeId: string, clock: Clock, until: number): Promise<string | undefined> {
  for (;;) {
    try {
      const creative = await metaApiClient.get<{ effective_object_story_id?: string }>(`/${creativeId}`, { fields: "effective_object_story_id" });
      if (creative.effective_object_story_id) return creative.effective_object_story_id;
    } catch {
      // Not readable yet: keep waiting.
    }
    if (clock.now() + POST_POLL_MS > until) return undefined;
    await clock.sleep(POST_POLL_MS);
  }
}

async function editMessage(post: PostEdit, clock: Clock, until: number): Promise<void> {
  for (;;) {
    try {
      await metaApiClient.postForm(`/${post.post_id}`, { message: post.message });
      return;
    } catch (err) {
      const stillInUse = /Failed to edit object/.test(errorMessage(err));
      if (!stillInUse || clock.now() + EDIT_RETRY_MS > until) throw err;
      await clock.sleep(EDIT_RETRY_MS);
    }
  }
}
