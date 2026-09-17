import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFfmpeg, VideoProbeError } from "../../src/media/ffmpeg.js";

const exec = promisify(execFile);

async function ffmpegOnPath(): Promise<boolean> {
  try {
    await exec("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const available = await ffmpegOnPath();
// CI installs ffmpeg explicitly; locally the suite is skipped rather than failed
// when the binary is absent, and FFMPEG_REQUIRED=1 turns that skip into a failure.
if (!available && process.env.FFMPEG_REQUIRED === "1") {
  throw new Error("ffmpeg is required (FFMPEG_REQUIRED=1) but not on PATH");
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);

describe.skipIf(!available)("ffmpeg integration (real binary, synthetic clip)", () => {
  let dir: string;
  let clip: string;
  const ffmpeg = createFfmpeg();

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-ads-ffmpeg-int-"));
    clip = path.join(dir, "clip.mp4");
    await exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("probes duration, dimensions and audio", async () => {
    const probe = await ffmpeg.probe(clip);
    expect(probe.duration_seconds).toBeGreaterThan(3.5);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.has_audio).toBe(true);
    expect(probe.video_codec).toBe("h264");
    expect(probe.demuxer).toBe("mov,mp4,m4a,3gp,3g2,mj2");
  });

  it("rejects a clip longer than maxSeconds", async () => {
    await expect(ffmpeg.probe(clip, { maxSeconds: 1 })).rejects.toBeInstanceOf(VideoProbeError);
  });

  it("rejects non-video input", async () => {
    const text = path.join(dir, "not-a-video.mp4");
    await fs.writeFile(text, "hello");
    await expect(ffmpeg.probe(text)).rejects.toThrow();
  });

  it("extracts evenly spaced JPEG frames", async () => {
    const probe = await ffmpeg.probe(clip);
    const outDir = path.join(dir, "frames");
    await fs.mkdir(outDir);
    const frames = await ffmpeg.extractFrames(clip, {
      outDir, count: 3, durationSeconds: probe.duration_seconds, maxWidth: 160, demuxer: probe.demuxer,
    });
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.buffer.subarray(0, 2)).toEqual(JPEG_SOI);
      expect(frame.buffer.length).toBeGreaterThan(500);
    }
  });

  it("builds a contact sheet", async () => {
    const probe = await ffmpeg.probe(clip);
    const outDir = path.join(dir, "sheet");
    await fs.mkdir(outDir);
    const sheet = await ffmpeg.contactSheet(clip, {
      outDir, count: 4, columns: 2, durationSeconds: probe.duration_seconds, tileWidth: 160, demuxer: probe.demuxer,
    });
    expect(sheet.buffer.subarray(0, 2)).toEqual(JPEG_SOI);
    expect(sheet.rows).toBe(2);
    expect(sheet.timestamps_seconds).toHaveLength(4);
  });

  it("transcodes a compact mp4 under the byte cap", async () => {
    const probe = await ffmpeg.probe(clip);
    const outDir = path.join(dir, "compact");
    await fs.mkdir(outDir);
    const out = await ffmpeg.compact(clip, {
      outDir, maxBytes: 2 * 1024 * 1024, durationSeconds: probe.duration_seconds, maxSeconds: 60, height: 240, demuxer: probe.demuxer,
    });
    expect(out.bytes).toBeGreaterThan(1000);
    expect(out.bytes).toBeLessThan(2 * 1024 * 1024);
    const reprobe = await ffmpeg.probe(out.path);
    expect(reprobe.height).toBe(240);
    expect(reprobe.has_audio).toBe(true);
  });

  it("extracts an aac audio track", async () => {
    const probe = await ffmpeg.probe(clip);
    const outDir = path.join(dir, "audio");
    await fs.mkdir(outDir);
    const audio = await ffmpeg.extractAudio(clip, { outDir, durationSeconds: probe.duration_seconds, demuxer: probe.demuxer });
    expect(audio.mimeType).toBe("audio/aac");
    // ADTS sync word 0xFFF
    expect(audio.buffer[0]).toBe(0xff);
    expect(audio.buffer[1] & 0xf0).toBe(0xf0);
  });
});
