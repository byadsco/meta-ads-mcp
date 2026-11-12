import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";

export const MAX_LOCAL_VIDEO_BYTES = 100 * 1024 * 1024;

export async function localVideoForm(
  filePath: string,
  metadata: Record<string, string | undefined>,
): Promise<FormData> {
  const configuredRoot = process.env.META_LOCAL_MEDIA_ROOT;
  if (!configuredRoot) throw new Error("Local video upload is not enabled on this server.");
  if (!isAbsolute(filePath)) throw new Error("local_video_path must be an absolute path.");
  const root = await realpath(configuredRoot);
  const resolved = await realpath(filePath);
  const rel = relative(root, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Video must be inside the configured media directory.");
  }
  const extension = extname(resolved).toLowerCase();
  const types: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm" };
  if (!types[extension]) throw new Error("Supported local video formats: MP4, MOV, M4V, WEBM.");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 12 || info.size > MAX_LOCAL_VIDEO_BYTES) {
      throw new Error("Local video must be a regular file between 12 bytes and 100 MiB.");
    }
    const header = Buffer.alloc(12);
    await handle.read(header, 0, header.length, 0);
    const iso = header.subarray(4, 8).toString("ascii") === "ftyp";
    const webm = header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if ((extension === ".webm" && !webm) || (extension !== ".webm" && !iso)) {
      throw new Error("File header does not match the expected video container.");
    }
    const data = await handle.readFile();
    if (data.length > MAX_LOCAL_VIDEO_BYTES) throw new Error("Video exceeds 100 MiB.");
    const form = new FormData();
    form.set("source", new Blob([new Uint8Array(data)], { type: types[extension] }), basename(resolved));
    for (const [key, value] of Object.entries(metadata)) if (value) form.set(key, value);
    return form;
  } finally {
    await handle.close();
  }
}
