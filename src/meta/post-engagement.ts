import { metaApiClient } from "./client.js";
import { errorMessage } from "./creative-rebuild.js";

export interface Engagement {
  facebook?: { reactions: number; comments: number; shares: number };
  instagram?: { likes: number; comments: number };
  notes: string[];
}

interface PostCounts {
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

// Best effort: Meta only returns a Page post's counts with
// pages_read_user_content (or Page Public Content Access), and an Instagram
// media's counts with instagram_basic. A missing permission becomes a note.
export async function readEngagement(postId?: string, instagramMediaId?: string): Promise<Engagement> {
  const engagement: Engagement = { notes: [] };
  if (postId) {
    try {
      const post = await metaApiClient.get<PostCounts>(`/${postId}`, {
        fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
      });
      engagement.facebook = {
        reactions: post.reactions?.summary?.total_count ?? 0,
        comments: post.comments?.summary?.total_count ?? 0,
        shares: post.shares?.count ?? 0,
      };
    } catch (err) {
      engagement.notes.push(`Facebook counts unavailable: ${errorMessage(err).slice(0, 160)}`);
    }
  }
  if (instagramMediaId) {
    try {
      const media = await metaApiClient.get<{ like_count?: number; comments_count?: number }>(`/${instagramMediaId}`, {
        fields: "like_count,comments_count",
      });
      engagement.instagram = { likes: media.like_count ?? 0, comments: media.comments_count ?? 0 };
    } catch (err) {
      engagement.notes.push(`Instagram counts unavailable: ${errorMessage(err).slice(0, 160)}`);
    }
  }
  return engagement;
}
