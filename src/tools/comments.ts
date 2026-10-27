import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { truncateResponse, validateMetaId } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, TOGGLE, DELETE, WRITE_WARNING } from "./_register.js";

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
  server.registerTool(
    "ads_get_ad_comments",
    {
      description:
        "List comments on an ad post. Uses the ad's effective_object_story_id to fetch comments. Important for compliance monitoring in regulated industries.",
      inputSchema: {
        ad_id: z.string().optional().describe("Ad ID — will resolve to the post automatically"),
        post_id: z.string().optional().describe("Post ID directly (effective_object_story_id)"),
        limit: z.number().min(1).max(100).default(50),
        filter: z
          .enum(["toplevel", "stream"])
          .default("toplevel")
          .describe("Filter: toplevel (only direct comments) or stream (all including replies)"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, post_id, limit, filter }) => {
      let objectId = post_id ? validateMetaId(post_id, "post") : undefined;

      if (!objectId && ad_id) {
        const adId = validateMetaId(ad_id, "ad");
        // The post ID lives on the ad's creative; the Ad node rejects
        // effective_object_story_id.
        const ad = await metaApiClient.get<{ creative?: { effective_object_story_id?: string } }>(
          `/${adId}`,
          { fields: "creative{effective_object_story_id}" },
        );
        const postId = ad.creative?.effective_object_story_id;
        objectId = postId ? validateMetaId(postId, "post") : undefined;
        if (!objectId) {
          return {
            content: [
              { type: "text", text: `Ad ${adId} has no associated post (effective_object_story_id not found).` },
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
  server.registerTool(
    "ads_hide_comment",
    {
      description: `${WRITE_WARNING}Hide or unhide a comment on an ad post. Hidden comments are only visible to the commenter and their friends.`,
      inputSchema: {
        comment_id: z.string().describe("Comment ID to hide/unhide"),
        is_hidden: z.boolean().default(true).describe("true to hide, false to unhide"),
      },
      annotations: { ...TOGGLE },
    },
    async ({ comment_id, is_hidden }) => {
      const id = validateMetaId(comment_id, "post");
      await metaApiClient.postForm<{ success: boolean }>(
        `/${id}`,
        { is_hidden },
      );

      return {
        content: [
          {
            type: "text",
            text: `Comment ${id} ${is_hidden ? "hidden" : "unhidden"} successfully.`,
          },
        ],
      };
    },
  );

  // ─── Reply to Comment ─────────────────────────────────────────
  server.registerTool(
    "ads_reply_comment",
    {
      description: `${WRITE_WARNING}Reply to a comment on an ad post. The reply will appear as a nested comment. Re-running creates duplicate replies — not idempotent.`,
      inputSchema: {
        comment_id: z.string().describe("Comment ID to reply to"),
        message: z.string().min(1).describe("Reply message text"),
      },
      annotations: { ...CREATE },
    },
    async ({ comment_id, message }) => {
      const id = validateMetaId(comment_id, "post");
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/comments`,
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
  server.registerTool(
    "ads_delete_comment",
    {
      description: `${WRITE_WARNING}Delete a comment on an ad post. This action cannot be undone.`,
      inputSchema: {
        comment_id: z.string().describe("Comment ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ comment_id }) => {
      const id = validateMetaId(comment_id, "post");
      await metaApiClient.delete<{ success: boolean }>(`/${id}`);

      return {
        content: [
          { type: "text", text: `Comment ${id} deleted successfully.` },
        ],
      };
    },
  );
}
