import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVideoForm } from "../../src/utils/local-video.js";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

let root: string;
const bytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  sample-video")]);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meta-local-video-"));
  vi.stubEnv("META_LOCAL_MEDIA_ROOT", root);
  setupTestToken();
});
afterEach(async () => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("local Telegram video upload", () => {
  it("preserves MOV bytes and metadata in a multipart source", async () => {
    const file = join(root, "attachment.mov");
    await writeFile(file, bytes);
    const form = await localVideoForm(file, { title: "Telegram test" });
    const source = form.get("source") as File;
    expect(source.name).toBe("attachment.mov");
    expect(source.type).toBe("video/quicktime");
    expect(Buffer.from(await source.arrayBuffer())).toEqual(bytes);
    expect(form.get("title")).toBe("Telegram test");
  });
  it("rejects a symlink escaping the configured media directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "meta-outside-"));
    try {
      const secret = join(outside, "secret.mov");
      await writeFile(secret, bytes);
      const link = join(root, "link.mov");
      await symlink(secret, link);
      await expect(localVideoForm(link, {})).rejects.toThrow("inside the configured media");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it("rejects non-video content even if renamed .mov", async () => {
    const file = join(root, "bad.mov");
    await writeFile(file, "not a video, private text");
    await expect(localVideoForm(file, {})).rejects.toThrow("header");
  });
  it("is disabled without an explicit media directory", async () => {
    vi.stubEnv("META_LOCAL_MEDIA_ROOT", "");
    await expect(localVideoForm(join(root, "video.mov"), {})).rejects.toThrow("not enabled");
  });
  it("sends local bytes to the advideos endpoint and returns a video ID without activating ads", async () => {
    const file = join(root, "attachment.mov");
    await writeFile(file, bytes);
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ id: "55555" }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = server._registeredTools.find(t => t.name === "ads_upload_ad_video")!.handler;
    const result = await handler({ account_id: "123456", local_video_path: file, title: "test" }) as {content: {text: string}[]};
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toContain("/act_123456/advideos");
    expect(options.body).toBeInstanceOf(FormData);
    expect((options.body as FormData).get("source")).toBeInstanceOf(File);
    expect(JSON.parse(result.content[0].text)).toEqual({ video_id: "55555", source: "local_file", ad_activated: false });
  });
  it("rejects ambiguous sources before calling Meta", async () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const handler = server._registeredTools.find(t => t.name === "ads_upload_ad_video")!.handler;
    await expect(handler({account_id: "123456", local_video_path: join(root,"x.mov"), file_url:"https://example.com/x.mp4"})).rejects.toThrow("exactly one");
  });
});
