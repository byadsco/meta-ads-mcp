import { describe, expect, it } from "vitest";
import { mountAuthRoutes } from "../../src/transport/auth-routes.js";

/**
 * The route handlers themselves need a live session and an outbound call, so
 * they are covered by their extracted units (validateGeminiKeyInput,
 * isSameOriginRequest, safeReturnTo) plus manual verification. What this suite
 * pins down is the wiring: a credential route that silently stops being
 * mounted would leave the connections page posting into a 404.
 */
function recordRoutes() {
  const posts: string[] = [];
  const gets: string[] = [];
  const app = {
    get: (path: string) => {
      gets.push(path);
    },
    post: (path: string) => {
      posts.push(path);
    },
    use: () => undefined,
  };
  mountAuthRoutes(app as never, { serverUrl: "https://mcp.example.com", getClient: async () => undefined });
  return { posts, gets };
}

describe("mountAuthRoutes", () => {
  it("mounts the Gemini key routes next to the Apify ones", () => {
    const { posts } = recordRoutes();
    expect(posts).toContain("/auth/register-gemini-key");
    expect(posts).toContain("/auth/delete-gemini-key");
    expect(posts).toContain("/auth/register-apify-token");
    expect(posts).toContain("/auth/delete-apify-token");
  });

  it("serves the connections page", () => {
    const { gets } = recordRoutes();
    expect(gets).toContain("/auth/connections");
  });

  it("registers every credential route as a POST, so none can be triggered by a link", () => {
    const { gets } = recordRoutes();
    for (const path of ["/auth/register-gemini-key", "/auth/delete-gemini-key", "/auth/register-apify-token", "/auth/delete-apify-token"]) {
      expect(gets).not.toContain(path);
    }
  });
});
