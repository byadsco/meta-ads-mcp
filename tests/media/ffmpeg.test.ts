import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFfmpeg,
  parseProbeOutput,
  VideoProbeError,
  type ExecFileFn,
} from "../../src/media/ffmpeg.js";

const PROBE_JSON = JSON.stringify({
  streams: [
    { codec_name: "h264", codec_type: "video", width: 1080, height: 1920, r_frame_rate: "30000/1001" },
    { codec_name: "aac", codec_type: "audio", r_frame_rate: "0/0" },
  ],
  format: { nb_streams: 2, format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "15.040000", size: "4200000" },
});

function fakeExec(stdout = "", exitError?: Error): { exec: ExecFileFn; calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> } {
  const calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = [];
  const exec: ExecFileFn = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], opts: opts as Record<string, unknown> });
    if (exitError) throw exitError;
    return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
  };
  return { exec, calls };
}

describe("parseProbeOutput", () => {
  it("extracts duration, dimensions, fps and audio presence", () => {
    const probe = parseProbeOutput(PROBE_JSON, 4200000);
    expect(probe).toEqual({
      duration_seconds: 15.04,
      width: 1080,
      height: 1920,
      fps: 29.97,
      has_audio: true,
      video_codec: "h264",
      bytes: 4200000,
      demuxer: "mov,mp4,m4a,3gp,3g2,mj2",
    });
  });

  it("rejects containers other than mp4/mov/webm", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", width: 10, height: 10, r_frame_rate: "1/1" }],
      format: { nb_streams: 1, format_name: "hls", duration: "1" },
    });
    expect(() => parseProbeOutput(json, 10)).toThrow(VideoProbeError);
    expect(() => parseProbeOutput(json, 10)).toThrow(/container/);
  });

  it("rejects files without exactly one video stream", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "audio", codec_name: "aac", r_frame_rate: "0/0" }],
      format: { nb_streams: 1, format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1" },
    });
    expect(() => parseProbeOutput(json, 10)).toThrow(/video stream/);
  });

  it("rejects oversized dimensions and too many streams", () => {
    const huge = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", width: 8000, height: 8000, r_frame_rate: "1/1" }],
      format: { nb_streams: 1, format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1" },
    });
    expect(() => parseProbeOutput(huge, 10)).toThrow(/dimensions/);

    const many = JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 10, height: 10, r_frame_rate: "1/1" },
        { codec_type: "audio" }, { codec_type: "audio" }, { codec_type: "audio" }, { codec_type: "audio" },
      ],
      format: { nb_streams: 5, format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1" },
    });
    expect(() => parseProbeOutput(many, 10)).toThrow(/streams/);
  });

  it("rejects durations above the configured maximum", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "h264", width: 10, height: 10, r_frame_rate: "1/1" }],
      format: { nb_streams: 1, format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "999" },
    });
    expect(() => parseProbeOutput(json, 10, { maxSeconds: 240 })).toThrow(/duration/);
  });
});

describe("createFfmpeg (unit, execFile injected)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-ads-ffmpeg-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("probe runs ffprobe with the protocol whitelist and json output", async () => {
    const { exec, calls } = fakeExec(PROBE_JSON);
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "/usr/bin/ffprobe", ffmpegPath: "/usr/bin/ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, Buffer.alloc(4200000));

    const probe = await ffmpeg.probe(input);

    expect(probe.duration_seconds).toBe(15.04);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("/usr/bin/ffprobe");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-of", "json", input]));
    expect(calls[0].opts.timeout).toBeGreaterThan(0);
    expect(calls[0].opts.killSignal).toBe("SIGKILL");
  });

  it("probe restricts demuxers, pixels and streams natively before any input is opened", async () => {
    const { exec, calls } = fakeExec(PROBE_JSON);
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");

    await ffmpeg.probe(input);

    const args = calls[0].args;
    const before = args.slice(0, args.indexOf(input));
    expect(before).toEqual(expect.arrayContaining(["-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm"]));
    expect(before).toEqual(expect.arrayContaining(["-analyzeduration", "5M", "-probesize", "10M"]));
    expect(before).toEqual(expect.arrayContaining(["-max_streams", "4", "-max_pixels", "8294400", "-max_alloc", "268435456", "-threads", "1"]));
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf(input));
  });

  it("frame and sheet filters bound both output dimensions", async () => {
    const { exec, calls } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    await fs.writeFile(path.join(dir, "frame_1.jpg"), "j");
    await fs.writeFile(path.join(dir, "sheet.jpg"), "s");

    await ffmpeg.extractFrames(input, { outDir: dir, count: 1, durationSeconds: 2, maxWidth: 640, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" });
    await ffmpeg.contactSheet(input, { outDir: dir, count: 1, columns: 1, durationSeconds: 2, tileWidth: 512, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" });

    for (const call of calls) {
      const vf = call.args[call.args.indexOf("-vf") + 1];
      // scale=w:h with force_original_aspect_ratio=decrease keeps the frame inside a bounded box.
      expect(vf).toMatch(/scale=\d+:\d+:force_original_aspect_ratio=decrease/);
      expect(call.args).toEqual(expect.arrayContaining(["-max_alloc"]));
    }
  });

  it("extractFrames seeks before -i, forces the probed demuxer and writes into the job dir", async () => {
    const { exec, calls } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    // The fake exec does not produce files; simulate ffmpeg's output so the reader has something to load.
    const outDir = path.join(dir, "frames");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "frame_1.jpg"), Buffer.from("jpg1"));
    await fs.writeFile(path.join(outDir, "frame_2.jpg"), Buffer.from("jpg2"));

    const frames = await ffmpeg.extractFrames(input, {
      outDir,
      count: 2,
      durationSeconds: 10,
      maxWidth: 640,
      demuxer: "mov,mp4,m4a,3gp,3g2,mj2",
    });

    expect(frames.map((f) => f.timestamp_seconds)).toEqual([2.5, 7.5]);
    expect(frames[0].buffer.toString()).toBe("jpg1");
    expect(calls).toHaveLength(2);
    const args = calls[0].args;
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toEqual(expect.arrayContaining(["-nostdin", "-protocol_whitelist", "file", "-f", "mov,mp4,m4a,3gp,3g2,mj2", "-frames:v", "1"]));
    expect(args[args.length - 1]).toBe(path.join(outDir, "frame_1.jpg"));
    expect(args.join(" ")).toContain("scale=640:640:force_original_aspect_ratio=decrease");
    expect(calls[0].opts.cwd).toBe(outDir);
    expect(calls[0].opts.env).toEqual({ PATH: process.env.PATH });
  });

  it("contactSheet tiles the frames into one jpeg and caps output size with -fs", async () => {
    const { exec, calls } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    await fs.writeFile(path.join(dir, "sheet.jpg"), Buffer.from("sheet"));

    const sheet = await ffmpeg.contactSheet(input, {
      outDir: dir,
      count: 6,
      columns: 3,
      durationSeconds: 12,
      tileWidth: 512,
      demuxer: "mov,mp4,m4a,3gp,3g2,mj2",
    });

    expect(sheet.buffer.toString()).toBe("sheet");
    expect(sheet.timestamps_seconds).toEqual([1, 3, 5, 7, 9, 11]);
    expect(sheet.columns).toBe(3);
    const joined = calls[0].args.join(" ");
    expect(joined).toContain("tile=3x2");
    expect(joined).toContain("scale=512:512:force_original_aspect_ratio=decrease");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-fs"]));
  });

  it("compact transcodes to h264/aac with faststart and a byte cap", async () => {
    const { exec, calls } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    await fs.writeFile(path.join(dir, "compact.mp4"), Buffer.alloc(100));

    const out = await ffmpeg.compact(input, {
      outDir: dir,
      maxBytes: 1000,
      durationSeconds: 30,
      maxSeconds: 60,
      height: 480,
      demuxer: "mov,mp4,m4a,3gp,3g2,mj2",
    });

    expect(out.bytes).toBe(100);
    expect(out.path).toBe(path.join(dir, "compact.mp4"));
    const args = calls[0].args;
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", "-t", "30"]));
    expect(args[args.indexOf("-fs") + 1]).toBe("1000");
    expect(args.join(" ")).toContain("scale=853:480:force_original_aspect_ratio=decrease:force_divisible_by=2");
  });

  it("compact fails clearly when even the smallest rendition exceeds maxBytes", async () => {
    const { exec } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    await fs.writeFile(path.join(dir, "compact.mp4"), Buffer.alloc(5000));

    await expect(
      ffmpeg.compact(input, { outDir: dir, maxBytes: 1000, durationSeconds: 30, maxSeconds: 60, height: 480, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" }),
    ).rejects.toThrow(/does not fit/);
  });

  it("extractAudio produces adts aac", async () => {
    const { exec, calls } = fakeExec();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");
    await fs.writeFile(path.join(dir, "audio.aac"), Buffer.from("aac"));

    const audio = await ffmpeg.extractAudio(input, { outDir: dir, durationSeconds: 5, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" });

    expect(audio.mimeType).toBe("audio/aac");
    expect(audio.buffer.toString()).toBe("aac");
    expect(calls[0].args).toEqual(expect.arrayContaining(["-vn", "-c:a", "aac", "-f", "adts"]));
  });

  it("wraps process failures without leaking full stderr into the message", async () => {
    const err = Object.assign(new Error("Command failed"), { stderr: Buffer.from("secret path /tmp/x\nmore") });
    const { exec } = fakeExec("", err);
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });

    await expect(ffmpeg.probe(path.join(dir, "missing.mp4"))).rejects.toThrow(/ffprobe failed/);
  });

  it("isAvailable caches the version probe", async () => {
    const { exec, calls } = fakeExec("ffmpeg version 8.1");
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });

    expect(await ffmpeg.isAvailable()).toBe(true);
    expect(await ffmpeg.isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("isAvailable is false when the binary cannot be spawned", async () => {
    const { exec } = fakeExec("", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "/nonexistent/ffmpeg" });
    expect(await ffmpeg.isAvailable()).toBe(false);
  });

  it("respects an AbortSignal by passing it to execFile", async () => {
    const { exec, calls } = fakeExec(PROBE_JSON);
    const controller = new AbortController();
    const ffmpeg = createFfmpeg({ execFile: exec, ffprobePath: "ffprobe", ffmpegPath: "ffmpeg" });
    const input = path.join(dir, "in.mp4");
    await fs.writeFile(input, "x");

    await ffmpeg.probe(input, { signal: controller.signal });
    expect(calls[0].opts.signal).toBe(controller.signal);
  });

  it("never consults the real process environment for binaries when paths are injected", () => {
    const spy = vi.spyOn(process, "env", "get");
    createFfmpeg({ execFile: fakeExec().exec, ffprobePath: "a", ffmpegPath: "b" });
    spy.mockRestore();
  });
});
