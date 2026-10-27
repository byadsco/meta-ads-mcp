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
  readCreativeIdAfterFailedRepoint,
  resolveInstagramUserId,
} from "./creative-rebuild.js";
import { withPageToken } from "./page-token.js";
import type { AdCreative } from "./types/index.js";

// Measured on v26.0: Meta refuses to edit a post while any ad uses it, and
// accepts the edit about 40-50 seconds after the last ad moves off it. It
// allows one creative change per ad every 30 seconds. The waits leave twice
// the measured time and keep a whole edit inside the server's 300-second
// request limit: past it, ads could be left paused with nobody told.
const CREATIVE_CHANGE_GAP_MS = 31_000;
const EDIT_RETRY_MS = 15_000;
const EDIT_WINDOW_MS = 105_000;
const POST_POLL_MS = 10_000;
const POST_WINDOW_MS = 40_000;
// Pausing and detaching taking longer than this means Meta is pacing writes
// too slowly to finish: everything is put back before the post is touched.
const PRE_EDIT_BUDGET_MS = 45_000;
const MAX_SCANNED_ADS = 5000;
const TEMPORARY_NAME = "Temporary creative of a post edit (no ad uses it)";

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
  // Meta's answer to the edit was lost and the post could not be read back:
  // it may have the new text or the old one.
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

const realClock: Clock = {
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

/**
 * Edits the message of a post that ads use (route B). Meta refuses the edit
 * while any ad uses the post, so every ad on it pauses (the active ones) and
 * moves to a temporary creative, the post is edited with a Page token, and
 * each ad moves back: to its own creative when that creative reuses the post,
 * to a new creative reusing the post when its own created it. Ads paused here
 * are resumed once they are back. Any failure before the edit puts every ad
 * back as it was. An ad that cannot be moved back stays paused on the
 * temporary creative, and the outcome says so.
 */
export async function editPost(input: PostEditInput, clock: Clock = realClock): Promise<PostEditOutcome> {
  const { post } = input;
  const startedAt = clock.now();
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

  let temporary: string;
  try {
    temporary = await createReplacementCreative(input.account_id, { name: TEMPORARY_NAME, object_story_spec: JSON.stringify(temporarySpec(input)) });
  } catch (err) {
    return { ...result, stage: "temporary_creative", error: errorMessage(err) };
  }
  result.temporary_creative_id = temporary;

  const paused: string[] = [];
  const detachedAt = new Map<string, number>();
  // Own creative -> its new creative reusing the post, once the post is edited.
  const replacements = new Map<string, string>();

  const pointAt = async (adId: string, creativeId: string): Promise<{ ok: true } | { ok: false; error: string; now?: string }> => {
    try {
      await metaApiClient.postForm(`/${adId}`, { creative: JSON.stringify({ creative_id: creativeId }) }, scope);
      return { ok: true };
    } catch (err) {
      const now = await readCreativeIdAfterFailedRepoint(adId);
      return now === creativeId ? { ok: true } : { ok: false, error: errorMessage(err), now };
    }
  };

  // Moves every detached ad to its target, at least 30 s after it left.
  const moveBack = async (targetOf: (user: PostUser) => string | undefined, outcome: PostEditAd["outcome"], failure: string) => {
    for (const user of input.users) {
      const since = detachedAt.get(user.ad_id);
      if (since === undefined) continue;
      const ad = ads.get(user.ad_id)!;
      const target = targetOf(user);
      if (!target) {
        Object.assign(ad, { outcome: "left_on_temporary", creative_id: temporary, instagram: "reset", error: failure });
        continue;
      }
      const wait = since + CREATIVE_CHANGE_GAP_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const moved = await pointAt(user.ad_id, target);
      if (moved.ok) {
        ad.creative_id = target;
        ad.outcome = outcome;
      } else {
        Object.assign(ad, { outcome: "left_on_temporary", creative_id: moved.now ?? temporary, instagram: "reset", error: moved.error });
      }
    }
  };

  // An ad is resumed only once it is read back on a creative this edit meant
  // for it: its own, or the one replacing it. Anything else (the temporary
  // creative, another edit's, an unreadable state) would show the wrong ad.
  const wrapUp = async (): Promise<PostEditOutcome> => {
    const planned = new Set([...input.users.map((u) => u.creative_id), ...replacements.values()]);
    for (const adId of paused) {
      const ad = ads.get(adId)!;
      if (ad.outcome === "left_on_temporary") continue;
      const now = await readCreativeIdAfterFailedRepoint(adId);
      if (now === undefined || now !== ad.creative_id || !planned.has(now)) {
        ad.error = now === undefined
          ? "It stays paused: its creative could not be read to confirm it is safe to resume."
          : `It stays paused: it uses creative ${now}, which this edit did not put it on.`;
        continue;
      }
      try {
        await metaApiClient.postForm(`/${adId}`, { status: "ACTIVE" }, scope);
        ad.resumed = true;
      } catch (err) {
        ad.error = `It stays paused: it could not be resumed (${errorMessage(err)}).`;
      }
    }
    result.temporary_deleted = await deleteCreative(temporary);
    return result;
  };

  const stopAndRestore = async (stage: NonNullable<PostEditOutcome["stage"]>, error: string): Promise<PostEditOutcome> => {
    result.stage = stage;
    result.error = error;
    await moveBack((user) => user.creative_id, "restored", "It could not be moved back.");
    return wrapUp();
  };

  for (const user of input.users.filter((u) => u.status === "ACTIVE")) {
    try {
      await metaApiClient.postForm(`/${user.ad_id}`, { status: "PAUSED" }, scope);
      paused.push(user.ad_id);
    } catch (err) {
      // A write can reach Meta with only its response lost: unless the ad is
      // read back still active, it is treated as paused and resumed like the
      // others (resuming an active ad changes nothing).
      const status = await readStatus(user.ad_id);
      if (status !== "ACTIVE") paused.push(user.ad_id);
      if (status === undefined) ads.get(user.ad_id)!.error = "Its pause could not be confirmed either way: it may be paused.";
      return stopAndRestore("pause", errorMessage(err));
    }
  }

  for (const user of input.users) {
    const moved = await pointAt(user.ad_id, temporary);
    if (!moved.ok) {
      const ad = ads.get(user.ad_id)!;
      ad.error = moved.error;
      // Unreadable, it may be on the temporary creative: it is pointed back
      // at its own like the ones that did move.
      if (moved.now === undefined) detachedAt.set(user.ad_id, clock.now());
      else ad.creative_id = moved.now;
      return stopAndRestore("detach", moved.error);
    }
    detachedAt.set(user.ad_id, clock.now());
  }
  if (clock.now() - startedAt > PRE_EDIT_BUDGET_MS) {
    return stopAndRestore("time", "Meta took too long to take the ads off the post for the edit to finish within one call; every ad was put back and the post was not touched.");
  }

  // The temporary creative has to free the post: a creative Meta matched to
  // the same post would keep it in use and the edit would never go through.
  const temporaryPost = await waitForPost(temporary, clock);
  if (temporaryPost === post.post_id) {
    return stopAndRestore("wait", "The temporary creative uses the same post, so the post stays in use and cannot be edited.");
  }

  // A failed answer does not mean nothing was written: the post's text is
  // read back before deciding. When it cannot be read, the ads go on as if it
  // was edited, because a creative reusing the post carries them either way,
  // while the creative that created the post is refused once it was edited.
  let editError: string | undefined;
  let editState: "edited" | "not_edited" | "unknown";
  try {
    editState = await withPageToken(post.page_id, async () => {
      try {
        await editMessage(post, clock);
        return "edited" as const;
      } catch (err) {
        editError = errorMessage(err);
        const now = await readMessage(post.post_id);
        if (now === undefined) return "unknown" as const;
        return now.trim() === post.message.trim() ? "edited" as const : "not_edited" as const;
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
  for (const creativeId of new Set(input.users.map((u) => u.creative_id))) {
    const own = input.creatives[creativeId];
    if (!own?.object_story_spec) continue;
    try {
      const id = await createReplacementCreative(input.account_id, reusingCreativeBody(own, post.post_id));
      replacements.set(creativeId, id);
      result.new_creatives.push(id);
    } catch (err) {
      replacementErrors.set(creativeId, `Its new creative reusing the post could not be created: ${errorMessage(err)}`);
    }
  }
  for (const user of input.users) {
    if (replacements.has(user.creative_id)) ads.get(user.ad_id)!.instagram = "reset";
  }
  await moveBack(
    (user) => (input.creatives[user.creative_id]?.object_story_spec ? replacements.get(user.creative_id) : user.creative_id),
    "updated",
    "Its new creative reusing the post could not be created.",
  );
  for (const user of input.users) {
    const error = replacementErrors.get(user.creative_id);
    const ad = ads.get(user.ad_id)!;
    if (error && ad.outcome === "left_on_temporary") ad.error = error;
  }
  return wrapUp();
}

async function readMessage(postId: string): Promise<string | undefined> {
  try {
    return (await metaApiClient.get<{ message?: string }>(`/${postId}`, { fields: "message" })).message ?? "";
  } catch {
    return undefined;
  }
}

async function readStatus(adId: string): Promise<string | undefined> {
  try {
    return (await metaApiClient.get<{ status?: string }>(`/${adId}`, { fields: "status" })).status;
  } catch {
    return undefined;
  }
}

async function waitForPost(creativeId: string, clock: Clock): Promise<string | undefined> {
  const deadline = clock.now() + POST_WINDOW_MS;
  for (;;) {
    try {
      const creative = await metaApiClient.get<{ effective_object_story_id?: string }>(`/${creativeId}`, { fields: "effective_object_story_id" });
      if (creative.effective_object_story_id) return creative.effective_object_story_id;
    } catch {
      // Not readable yet: keep waiting.
    }
    if (clock.now() + POST_POLL_MS > deadline) return undefined;
    await clock.sleep(POST_POLL_MS);
  }
}

async function editMessage(post: PostEdit, clock: Clock): Promise<void> {
  const deadline = clock.now() + EDIT_WINDOW_MS;
  for (;;) {
    try {
      await metaApiClient.postForm(`/${post.post_id}`, { message: post.message });
      return;
    } catch (err) {
      const stillInUse = /Failed to edit object/.test(errorMessage(err));
      if (!stillInUse || clock.now() + EDIT_RETRY_MS > deadline) throw err;
      await clock.sleep(EDIT_RETRY_MS);
    }
  }
}
