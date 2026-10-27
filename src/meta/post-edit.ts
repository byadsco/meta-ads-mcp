import { normalizeAccountId } from "../utils/format.js";
import type { PostEdit } from "./ad-content.js";
import { metaApiClient } from "./client.js";
import { wasRefused } from "./errors.js";
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
// Moving an ad gets longer: Meta's ad updates were seen taking over 10 s.
const MOVE_CALL_MS = 20_000;
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
  // "unconfirmed": moving it back failed and Meta's read cannot settle where
  // it is (it showed the copy after no clear answer, or the creative the ad
  // had before the edit); its reads can lag behind its writes.
  outcome: "updated" | "restored" | "unchanged" | "left_on_temporary" | "unconfirmed";
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
  // One per distinct copy the ads on the post needed.
  temporary_creatives: string[];
  // The ones Meta refused to delete afterwards.
  temporary_left: string[];
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

const COPY_FIELDS: Record<string, string[]> = {
  link_data: ["message", "name", "description"],
  video_data: ["message", "title", "link_description"],
};

// The spec of the creative that created the post: its link, image or video
// and button. Undefined for a promoted post, which no creative created.
function postSpec(input: Pick<PostEditInput, "users" | "creatives">): { spec: Record<string, unknown>; key: string } | undefined {
  for (const user of input.users) {
    const spec = asRecord(input.creatives[user.creative_id]?.object_story_spec);
    for (const key of Object.keys(COPY_FIELDS)) {
      if (spec && asRecord(spec[key])) return { spec, key };
    }
  }
  return undefined;
}

// Active ads keep running on their temporary creative while the post is
// edited, so it has to be a real copy of the ad. Only when no creative on the
// post created it (a promoted post) is there nothing to copy.
export function hasServableTemporary(input: Pick<PostEditInput, "users" | "creatives">): boolean {
  return postSpec(input) !== undefined;
}

// A copy of what an ad shows while its post is edited, on a post of its own:
// the post's link, media and button with the new text (or the ad's own text
// options, which it keeps), and every setting of the ad's own creative that
// the rebuild carries (destination override, tracking, Advantage+ settings,
// per-platform media, labels, Instagram identity). Without a spec to copy,
// a plain link to the Page, used only when no ad on the post is active.
function temporaryBody(creative: AdCreative, input: PostEditInput): Record<string, string> {
  const base = postSpec(input);
  let spec: Record<string, unknown>;
  const body: Record<string, string> = { name: TEMPORARY_NAME };
  if (base) {
    spec = structuredClone(base.spec);
    // The Instagram identity is the copied ad's own, set below, never the
    // one of the creative that made the post.
    delete spec.instagram_user_id;
    const data = asRecord(spec[base.key])!;
    if (hasFeedContent(creative)) {
      for (const field of COPY_FIELDS[base.key]) delete data[field];
      body.asset_feed_spec = JSON.stringify(creative.asset_feed_spec);
    } else {
      data.message = input.post.message;
    }
  } else {
    spec = {
      page_id: input.post.page_id,
      link_data: { link: `https://www.facebook.com/${input.post.page_id}`, message: input.post.message },
    };
  }
  const instagramUserId = resolveInstagramUserId(creative);
  if (instagramUserId) spec.instagram_user_id = instagramUserId;
  body.object_story_spec = JSON.stringify(spec);
  Object.assign(body, carryOverFields(creative).body);
  if (creative.url_tags) body.url_tags = creative.url_tags;
  return body;
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
  const boundedMove = { accountId, timeoutMs: MOVE_CALL_MS };
  const ads = new Map<string, PostEditAd>(input.users.map((u) => [u.ad_id, {
    ad_id: u.ad_id,
    outcome: "unchanged",
    creative_id: u.creative_id,
    previous_creative_id: u.creative_id,
    instagram: "kept",
  }]));
  const result: PostEditOutcome = { edited: false, ads: [...ads.values()], temporary_creatives: [], temporary_left: [], new_creatives: [] };

  // Meta's message when the write failed, and whether Meta turned it down
  // (nothing written) rather than leaving it unknown.
  const pointAt = async (adId: string, creativeId: string): Promise<{ error?: string; refused?: boolean }> => {
    try {
      await metaApiClient.postForm(`/${adId}`, { creative: JSON.stringify({ creative_id: creativeId }) }, boundedMove);
      return {};
    } catch (err) {
      return { error: errorMessage(err), refused: wasRefused(err) };
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
  const deleteTemporaries = async () => {
    for (const id of result.temporary_creatives) {
      try {
        await metaApiClient.delete(`/${id}`, undefined, bounded);
      } catch {
        result.temporary_left.push(id);
      }
    }
  };

  // One temporary copy per distinct ad configuration on the post; creatives
  // whose copies would be the same share one.
  const copies = new Map<string, Record<string, string>>();
  const copyOf = new Map<string, string>();
  for (const creativeId of new Set(input.users.map((u) => u.creative_id))) {
    const body = temporaryBody(input.creatives[creativeId] ?? ({ id: creativeId, name: "" } as AdCreative), input);
    const key = JSON.stringify(body);
    copies.set(key, body);
    copyOf.set(creativeId, key);
  }
  // Moving `count` ads back at worst, once the 30-second gap since they moved
  // off is over: a move and a read back for each, then deleting every
  // temporary creative.
  const moveBackWork = (count: number) => count * (MOVE_CALL_MS + CALL_MS) + copies.size * CALL_MS;
  const putBackCost = (count: number) => CREATIVE_CHANGE_GAP_MS + moveBackWork(count);

  if (clock.now() + copies.size * CALL_MS + putBackCost(0) > deadline) return { ...result, stage: "time", error: TOO_SLOW };
  const temporaryOfCopy = new Map<string, string>();
  for (const [key, body] of copies) {
    try {
      const id = await createCreative(body);
      temporaryOfCopy.set(key, id);
      result.temporary_creatives.push(id);
    } catch (err) {
      await deleteTemporaries();
      return { ...result, stage: "temporary_creative", error: errorMessage(err) };
    }
  }
  const temporaryOf = (user: PostUser) => temporaryOfCopy.get(copyOf.get(user.creative_id)!)!;

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
        Object.assign(ad, { outcome: "left_on_temporary", creative_id: temporaryOf(user), instagram: "reset", error: noTarget });
        continue;
      }
      const wait = since + CREATIVE_CHANGE_GAP_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const { error, refused } = await pointAt(user.ad_id, target);
      if (error === undefined) {
        Object.assign(ad, { creative_id: target, outcome });
        continue;
      }
      // The answer may be lost with the write applied. Meta's reads lag
      // behind its writes, so a read showing the creative the ad had before
      // the edit may predate the move off: only a creative it never had
      // proves the move back.
      const now = await creativeOf(user.ad_id);
      if (now === target && target !== user.creative_id) {
        Object.assign(ad, { creative_id: target, outcome });
        continue;
      }
      if (now === target) {
        Object.assign(ad, {
          outcome: "unconfirmed",
          creative_id: temporaryOf(user),
          instagram: "reset",
          error: `Moving it back to creative ${target} failed (${error}). It reads as on ${target}, which it was on before the edit, but Meta's reads can lag behind its writes, so it may still be on creative ${temporaryOf(user)}.`,
        });
        continue;
      }
      if (refused) {
        Object.assign(ad, {
          outcome: "left_on_temporary",
          creative_id: now ?? temporaryOf(user),
          instagram: "reset",
          error: now === undefined ? `${error} Its creative could not be read back.` : error,
        });
        continue;
      }
      Object.assign(ad, {
        outcome: "unconfirmed",
        creative_id: now ?? temporaryOf(user),
        instagram: "reset",
        error: `Meta gave no clear answer to moving it back to creative ${target} (${error}), and its creative read back as ${now ?? "unreadable"}; Meta's reads can lag behind its writes, so it may already be back.`,
      });
    }
  };

  const finish = async (): Promise<PostEditOutcome> => {
    await deleteTemporaries();
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
    if (clock.now() + MOVE_CALL_MS + CALL_MS + putBackCost(detachedAt.size + 1) > deadline) return stopAndRestore("time", TOO_SLOW);
    const temporary = temporaryOf(user);
    const { error, refused } = await pointAt(user.ad_id, temporary);
    const now = error === undefined ? temporary : await creativeOf(user.ad_id);
    if (now === temporary) {
      detachedAt.set(user.ad_id, clock.now());
      continue;
    }
    const ad = ads.get(user.ad_id)!;
    ad.error = error;
    // Without a clear refusal the move may still land (Meta's reads lag
    // behind its writes): unless the ad reads back on a creative of someone
    // else's, it is moved back to its own like the ones that did move.
    if (!refused && (now === undefined || now === user.creative_id)) detachedAt.set(user.ad_id, clock.now());
    else if (now !== undefined) ad.creative_id = now;
    return stopAndRestore("detach", error ?? "It could not be moved off the post.");
  }

  // Once the post is edited every ad has to go back, through a new creative
  // for each own one: that, and one last read of the post, have to fit. The
  // 30-second gap is not counted again: the check before the last move off
  // left room for it after that move, and moving back starts at the later of
  // the two.
  const ownCreatives = new Set(input.users.map((u) => u.creative_id).filter((id) => input.creatives[id]?.object_story_spec));
  const editUntil = Math.min(clock.now() + EDIT_WINDOW_MS, deadline - ownCreatives.size * CALL_MS - moveBackWork(input.users.length) - CALL_MS);

  // Every temporary creative has to free the post: one Meta matched to the
  // same post would keep it in use and the edit would never go through.
  const waitUntil = Math.min(clock.now() + POST_WINDOW_MS, editUntil - 3 * CALL_MS);
  for (const id of result.temporary_creatives) {
    if (await waitForPost(id, clock, waitUntil, bounded) === post.post_id) {
      return stopAndRestore("wait", "A temporary creative uses the same post, so the post stays in use and cannot be edited.");
    }
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
    // Exactly the approved text: a change of spacing alone is a change too.
    // If Meta stored it trimmed, the edit is reported unconfirmed.
    return read.message === post.message;
  } catch {
    return false;
  }
}
