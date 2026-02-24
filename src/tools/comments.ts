import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { truncateResponse } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";

interface AdComment {
  id: string;
  message?: string;
  from?: { id: string; name: string };
  created_time?: string;
  is_hidden?: boolean;
  like_count?: number;
  comment_count?: number;
}

const COMMENT_FIELDS = "id,message,from,created_time,is_hidden,like_count,comment_count";

export function registerCommentTools(server: McpServer): void {
  // ─── Get Ad Comments ──────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_comments",
    "List comments on an ad post. Uses the ad's effective_object_story_id to fetch comments. Important for compliance monitoring in regulated industries.",
    {
      ad_id: z.string().optional().describe("Ad ID — will resolve to the post automatically"),
      post_id: z.string().optional().describe("Post ID directly (effective_object_story_id)"),
      limit: z.number().min(1).max(100).default(50),
      filter: z
        .enum(["toplevel", "stream"])
        .default("toplevel")
        .describe("Filter: toplevel (only direct comments) or stream (all including replies)"),
    },
    async ({ ad_id, post_id, limit, filter }) => {
      let objectId = post_id;

      // If ad_id provided, resolve to effective_object_story_id
      if (!objectId && ad_id) {
        const ad = await metaApiClient.get<{ effective_object_story_id?: string }>(
          `/${ad_id}`,
          { fields: "effective_object_story_id" },
        );
        objectId = ad.effective_object_story_id;
        if (!objectId) {
          return {
            content: [
              { type: "text", text: `Ad ${ad_id} has no associated post (effective_object_story_id not found).` },
            ],
          };
        }
      }

      if (!objectId) {
        throw new Error("Either ad_id or post_id is required.");
      }

      const response = await metaApiClient.get<MetaApiResponse<AdComment>>(
        `/${objectId}/comments`,
        { fields: COMMENT_FIELDS, limit, filter },
      );
      const comments = response.data ?? [];

      if (comments.length === 0) {
        return {
          content: [{ type: "text", text: "No comments found on this ad." }],
        };
      }

      const text = comments
        .map(
          (c) =>
            `• [${c.is_hidden ? "HIDDEN" : "VISIBLE"}] ${c.from?.name ?? "Unknown"} (${c.created_time}): "${c.message ?? ""}" — Likes: ${c.like_count ?? 0}`,
        )
        .join("\n");

      const jsonStr = truncateResponse(JSON.stringify(comments, null, 2));

      return {
        content: [
          { type: "text", text: `Found ${comments.length} comment(s):\n\n${text}` },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );

  // ─── Hide Comment ─────────────────────────────────────────────
  server.tool(
    "meta_ads_hide_comment",
    "Hide or unhide a comment on an ad post. Hidden comments are only visible to the commenter and their friends.",
    {
      comment_id: z.string().describe("Comment ID to hide/unhide"),
      is_hidden: z.boolean().default(true).describe("true to hide, false to unhide"),
    },
    async ({ comment_id, is_hidden }) => {
      await metaApiClient.postForm<{ success: boolean }>(
        `/${comment_id}`,
        { is_hidden },
      );

      return {
        content: [
          {
            type: "text",
            text: `Comment ${comment_id} ${is_hidden ? "hidden" : "unhidden"} successfully.`,
          },
        ],
      };
    },
  );

  // ─── Reply to Comment ─────────────────────────────────────────
  server.tool(
    "meta_ads_reply_comment",
    "Reply to a comment on an ad post. The reply will appear as a nested comment.",
    {
      comment_id: z.string().describe("Comment ID to reply to"),
      message: z.string().min(1).describe("Reply message text"),
    },
    async ({ comment_id, message }) => {
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${comment_id}/comments`,
        { message },
      );

      return {
        content: [
          {
            type: "text",
            text: `Reply posted successfully!\nReply ID: ${result.id}\nMessage: "${message}"`,
          },
        ],
      };
    },
  );

  // ─── Delete Comment ───────────────────────────────────────────
  server.tool(
    "meta_ads_delete_comment",
    "Delete a comment on an ad post. This action cannot be undone.",
    {
      comment_id: z.string().describe("Comment ID to delete"),
    },
    async ({ comment_id }) => {
      await metaApiClient.delete<{ success: boolean }>(`/${comment_id}`);

      return {
        content: [
          { type: "text", text: `Comment ${comment_id} deleted successfully.` },
        ],
      };
    },
  );
}
