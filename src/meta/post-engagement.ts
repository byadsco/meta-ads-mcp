import { isMetaId } from "../utils/format.js";
import { metaApiClient } from "./client.js";
import { errorMessage } from "./creative-rebuild.js";

export interface Engagement {
  facebook?: { reactions: number; comments: number; shares: number };
  instagram?: { likes: number; comments: number };
  unavailable: Array<"facebook" | "instagram">;
  // Meta's message for each unavailable side: untrusted text.
  notes: string[];
}

interface PostCounts {
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

// Counts are typed but not checked at runtime: anything other than a whole,
// non-negative number makes that side unavailable, so no text Meta sends in
// its place reaches a reply.
function countOf(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error("Meta reported a count that is not a number.");
}

// Best effort: Meta only returns a Page post's counts with
// pages_read_user_content (or Page Public Content Access), and an Instagram
// media's counts with instagram_basic. A missing permission becomes a note.
export async function readEngagement(postId?: string, instagramMediaId?: string): Promise<Engagement> {
  const engagement: Engagement = { unavailable: [], notes: [] };
  // The IDs come from Meta's own answers, and still never reach a path
  // unless they are IDs.
  if (postId && !isMetaId(postId)) {
    engagement.unavailable.push("facebook");
    engagement.notes.push("Facebook counts unavailable: Meta reported the post's ID in a malformed shape.");
  } else if (postId) {
    try {
      const post = await metaApiClient.get<PostCounts>(`/${postId}`, {
        fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
      });
      engagement.facebook = {
        reactions: countOf(post.reactions?.summary?.total_count),
        comments: countOf(post.comments?.summary?.total_count),
        shares: countOf(post.shares?.count),
      };
    } catch (err) {
      engagement.unavailable.push("facebook");
      engagement.notes.push(`Facebook counts unavailable: ${errorMessage(err).slice(0, 160)}`);
    }
  }
  if (instagramMediaId && !isMetaId(instagramMediaId)) {
    engagement.unavailable.push("instagram");
    engagement.notes.push("Instagram counts unavailable: Meta reported the media's ID in a malformed shape.");
  } else if (instagramMediaId) {
    try {
      const media = await metaApiClient.get<{ like_count?: number; comments_count?: number }>(`/${instagramMediaId}`, {
        fields: "like_count,comments_count",
      });
      engagement.instagram = { likes: countOf(media.like_count), comments: countOf(media.comments_count) };
    } catch (err) {
      engagement.unavailable.push("instagram");
      engagement.notes.push(`Instagram counts unavailable: ${errorMessage(err).slice(0, 160)}`);
    }
  }
  return engagement;
}
