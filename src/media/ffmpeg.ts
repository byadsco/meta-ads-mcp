import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const nodeExecFileAsync = promisify(nodeExecFile);

export type ExecFileFn = (
  file: string,
  args: string[],
  options: {
    timeout: number;
    killSignal: "SIGKILL";
    maxBuffer: number;
    encoding: "buffer";
    windowsHide: true;
    cwd?: string;
    env: { PATH?: string };
    signal?: AbortSignal;
  },
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

const ALLOWED_DEMUXERS = new Set(["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"]);
// Handed to -format_whitelist so ffprobe never instantiates a playlist/concat
// demuxer, even before the parsed output is validated.
const FORMAT_WHITELIST = [...ALLOWED_DEMUXERS].join(",");
const MAX_PIXELS = 3840 * 2160;
const MAX_STREAMS = 4;
const MAX_ALLOC_BYTES = 268435456;
const DEFAULT_MAX_SECONDS = 240;
const PROBE_TIMEOUT_MS = 20_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_RETRY_AFTER_MS = 5_000;
// How long the one probe started at boot may run. On a fresh node the first
// run of ffmpeg has taken over 10 s with CPU to spare, where a warm node
// answers in about a second; the likeliest reason is that Cloud Run streams
// image layers on demand and the first execution waits for the layer that
// holds ffmpeg, which is probable but not confirmed. The transport does not
// hold the port open for this long; it waits a bounded time and lets the
// probe finish in the background.
export const STARTUP_VERSION_PROBE_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 30_000;
const TRANSCODE_TIMEOUT_MS = 150_000;
const STDIO_MAX_BUFFER = 1024 * 1024;
const FRAME_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
// Output-side, so it binds the encoder. The -threads 1 in inputArgs sits
// before -i and only bounds decoding; libx264 and the MJPEG encoder otherwise
// size their own pools to the machine.
const ENCODER_THREADS = ["-threads", "1"];
const AUDIO_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

export class VideoProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoProbeError";
  }
}

export class FfmpegError extends Error {
  // True when the failure says nothing about the binary itself: killed on
  // timeout, or a spawn refused for want of a resource. Whoever is deciding
  // whether ffmpeg exists must not remember such an answer.
  readonly transient: boolean;

  constructor(message: string, transient = false) {
    super(message);
    this.name = "FfmpegError";
    this.transient = transient;
  }
}

export interface VideoProbe {
  duration_seconds: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  video_codec: string;
  bytes: number;
  demuxer: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface ProbeJson {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: string; nb_streams?: number };
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || !den) return 0;
  return Math.round((num / den) * 100) / 100;
}

export function parseProbeOutput(
  stdout: string,
  bytes: number,
  options: { maxSeconds?: number } = {},
): VideoProbe {
  let json: ProbeJson;
  try {
    json = JSON.parse(stdout) as ProbeJson;
  } catch {
    throw new VideoProbeError("ffprobe returned unparseable output");
  }
  const demuxer = json.format?.format_name ?? "";
  if (!ALLOWED_DEMUXERS.has(demuxer)) {
    throw new VideoProbeError(`Unsupported video container "${demuxer || "unknown"}" (expected mp4/mov or webm)`);
  }
  const streams = json.streams ?? [];
  if (streams.length > MAX_STREAMS || (json.format?.nb_streams ?? 0) > MAX_STREAMS) {
    throw new VideoProbeError(`Video has too many streams (${streams.length})`);
  }
  const videoStreams = streams.filter((s) => s.codec_type === "video");
  if (videoStreams.length !== 1) {
    throw new VideoProbeError(`Expected exactly one video stream, found ${videoStreams.length}`);
  }
  const video = videoStreams[0];
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new VideoProbeError(`Video dimensions ${width}x${height} are outside the supported range`);
  }
  const duration = Number.parseFloat(json.format?.duration ?? "");
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoProbeError("Video duration is missing or invalid");
  }
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  if (duration > maxSeconds) {
    throw new VideoProbeError(`Video duration ${duration.toFixed(1)}s exceeds the ${maxSeconds}s limit`);
  }
  return {
    duration_seconds: Math.round(duration * 1000) / 1000,
    width,
    height,
    fps: parseFps(video.r_frame_rate),
    has_audio: streams.some((s) => s.codec_type === "audio"),
    video_codec: video.codec_name ?? "unknown",
    bytes,
    demuxer,
  };
}

export interface FrameExtraction {
  timestamp_seconds: number;
  buffer: Buffer;
}

export interface ContactSheet {
  buffer: Buffer;
  timestamps_seconds: number[];
  columns: number;
  rows: number;
}

export interface CompactVideo {
  path: string;
  bytes: number;
  height: number;
}

export interface AudioTrack {
  buffer: Buffer;
  mimeType: "audio/aac";
}

interface JobOptions {
  outDir: string;
  durationSeconds: number;
  demuxer: string;
  signal?: AbortSignal;
}

export interface Ffmpeg {
  isAvailable(options?: { timeoutMs?: number }): Promise<boolean>;
  /** The settled answer without spawning anything; undefined until a probe was conclusive. */
  lastKnownAvailability(): boolean | undefined;
  probe(input: string, options?: { maxSeconds?: number; signal?: AbortSignal }): Promise<VideoProbe>;
  extractFrames(input: string, options: JobOptions & { count: number; maxWidth: number }): Promise<FrameExtraction[]>;
  contactSheet(input: string, options: JobOptions & { count: number; columns: number; tileWidth: number }): Promise<ContactSheet>;
  compact(input: string, options: JobOptions & { maxBytes: number; maxSeconds: number; height: number }): Promise<CompactVideo>;
  extractAudio(input: string, options: JobOptions): Promise<AudioTrack>;
}

export interface FfmpegConfig {
  execFile?: ExecFileFn;
  ffmpegPath?: string;
  ffprobePath?: string;
  now?: () => number;
}

/** Evenly spaced sample points, each at the middle of its interval. */
export function sampleTimestamps(durationSeconds: number, count: number): number[] {
  const n = Math.max(1, count);
  const step = durationSeconds / n;
  return Array.from({ length: n }, (_, i) => Math.round((step * i + step / 2) * 1000) / 1000);
}

function inputArgs(demuxer: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-nostats", "-y", "-xerror",
    "-max_alloc", String(MAX_ALLOC_BYTES), "-threads", "1", "-filter_threads", "1",
    "-max_streams", String(MAX_STREAMS), "-max_pixels", String(MAX_PIXELS),
    "-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST,
    "-analyzeduration", "5M", "-probesize", "10M",
    "-f", demuxer,
  ];
}

/**
 * Bounds BOTH output dimensions: scale=W:-2 alone lets a 64x4096 source become
 * a 1280x81920 frame. The box keeps aspect ratio and even dimensions.
 */
function boundedScale(maxWidth: number, maxHeight: number): string {
  return `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

// Spawn errors that mean the binary is not usable at all, as opposed to
// EAGAIN, EMFILE or ENOMEM, which mean it could not be started just now.
const DEFINITIVE_SPAWN_ERRORS = new Set(["ENOENT", "EACCES", "ENOEXEC"]);

function describeFailure(tool: string, err: unknown): FfmpegError {
  const e = err as { code?: unknown; signal?: unknown; killed?: boolean; message?: string };
  if (e?.killed || e?.signal === "SIGKILL") return new FfmpegError(`${tool} timed out and was killed`, true);
  if (typeof e?.code === "string") return new FfmpegError(`${tool} failed (${e.code})`, !DEFINITIVE_SPAWN_ERRORS.has(e.code));
  const code = typeof e?.code === "number" ? ` (exit code ${e.code})` : "";
  // stderr can contain file paths; keep it out of user-facing text.
  return new FfmpegError(`${tool} failed${code}`);
}

export function createFfmpeg(config: FfmpegConfig = {}): Ffmpeg {
  const execFile = config.execFile ?? (nodeExecFileAsync as unknown as ExecFileFn);
  const ffmpegPath = config.ffmpegPath ?? "ffmpeg";
  const ffprobePath = config.ffprobePath ?? "ffprobe";
  const now = config.now ?? Date.now;
  let available: Promise<boolean> | undefined;
  let known: boolean | undefined;
  let retryNotBefore = 0;

  const run = async (
    bin: string,
    args: string[],
    opts: { timeout: number; cwd?: string; signal?: AbortSignal; tool: string },
  ): Promise<Buffer> => {
    try {
      const { stdout } = await execFile(bin, args, {
        timeout: opts.timeout,
        killSignal: "SIGKILL",
        maxBuffer: STDIO_MAX_BUFFER,
        encoding: "buffer",
        windowsHide: true,
        cwd: opts.cwd,
        env: { PATH: process.env.PATH },
        signal: opts.signal,
      });
      return stdout;
    } catch (err) {
      throw describeFailure(opts.tool, err);
    }
  };

  const readOutput = async (file: string): Promise<Buffer> => {
    try {
      return await fs.readFile(file);
    } catch {
      throw new FfmpegError("ffmpeg produced no output file");
    }
  };

  return {
    isAvailable(options = {}) {
      if (!available) {
        // A transient failure is forgotten so a later call asks again. Two
        // things have made the first probe on an instance slow: Cloud Run
        // throttles the CPU once the port is open and no request is in
        // flight, and, probably, it streams image layers on demand, so the
        // first run of ffmpeg on a fresh node waits for its layer.
        // Remembering either as "no ffmpeg" disabled every video tool on the
        // instance for as long as it lived. The cooldown keeps an instance
        // under pressure from spawning on every call: a refused spawn returns
        // at once, unlike a timeout, and would otherwise retry without pause.
        if (now() < retryNotBefore) return Promise.resolve(false);
        available = run(ffmpegPath, ["-version"], { timeout: options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS, tool: "ffmpeg" })
          .then(() => {
            known = true;
            return true;
          })
          .catch((err: unknown) => {
            if (err instanceof FfmpegError && err.transient) {
              available = undefined;
              retryNotBefore = now() + VERSION_PROBE_RETRY_AFTER_MS;
            } else {
              known = false;
            }
            return false;
          });
      }
      return available;
    },

    lastKnownAvailability() {
      return known;
    },

    async probe(input, options = {}) {
      const { size } = await fs.stat(input).catch(() => ({ size: 0 }));
      const stdout = await run(
        ffprobePath,
        [
          "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST,
          // Native caps applied while ffprobe discovers streams, before parseProbeOutput ever runs.
          "-max_streams", String(MAX_STREAMS), "-max_pixels", String(MAX_PIXELS),
          "-max_alloc", String(MAX_ALLOC_BYTES), "-threads", "1",
          "-analyzeduration", "5M", "-probesize", "10M",
          "-show_entries", "format=format_name,duration,size,nb_streams:stream=codec_type,codec_name,width,height,r_frame_rate",
          "-of", "json", input,
        ],
        { timeout: PROBE_TIMEOUT_MS, signal: options.signal, tool: "ffprobe" },
      );
      return parseProbeOutput(stdout.toString("utf8"), size, { maxSeconds: options.maxSeconds });
    },

    async extractFrames(input, options) {
      const timestamps = sampleTimestamps(options.durationSeconds, options.count);
      const frames: FrameExtraction[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const out = path.join(options.outDir, `frame_${i + 1}.jpg`);
        await run(
          ffmpegPath,
          [
            ...inputArgs(options.demuxer),
            "-ss", String(timestamps[i]), "-i", input,
            "-frames:v", "1", "-vf", boundedScale(options.maxWidth, options.maxWidth), "-q:v", "4",
            ...ENCODER_THREADS,
            "-fs", String(FRAME_OUTPUT_CAP_BYTES), "-f", "image2", out,
          ],
          { timeout: FRAME_TIMEOUT_MS, cwd: options.outDir, signal: options.signal, tool: "ffmpeg" },
        );
        frames.push({ timestamp_seconds: timestamps[i], buffer: await readOutput(out) });
      }
      return frames;
    },

    async contactSheet(input, options) {
      const timestamps = sampleTimestamps(options.durationSeconds, options.count);
      const columns = Math.max(1, options.columns);
      const rows = Math.ceil(timestamps.length / columns);
      const out = path.join(options.outDir, "sheet.jpg");
      const interval = options.durationSeconds / timestamps.length;
      await run(
        ffmpegPath,
        [
          ...inputArgs(options.demuxer),
          "-ss", String(timestamps[0]), "-i", input,
          "-vf", `fps=1/${interval},${boundedScale(options.tileWidth, options.tileWidth)},tile=${columns}x${rows}:padding=4:margin=4:color=black`,
          "-frames:v", "1", "-q:v", "4",
          ...ENCODER_THREADS,
          "-fs", String(FRAME_OUTPUT_CAP_BYTES * 2), "-f", "image2", out,
        ],
        { timeout: TRANSCODE_TIMEOUT_MS, cwd: options.outDir, signal: options.signal, tool: "ffmpeg" },
      );
      return { buffer: await readOutput(out), timestamps_seconds: timestamps, columns, rows };
    },

    async compact(input, options) {
      const clipSeconds = Math.min(options.durationSeconds, options.maxSeconds);
      const renditions: Array<{ height: number; crf: number }> = [
        { height: options.height, crf: 30 },
        { height: 360, crf: 34 },
      ];
      const out = path.join(options.outDir, "compact.mp4");
      for (const rendition of renditions) {
        await run(
          ffmpegPath,
          [
            ...inputArgs(options.demuxer),
            "-i", input, "-t", String(clipSeconds),
            "-vf", `${boundedScale(Math.round((rendition.height * 16) / 9), rendition.height)},fps=10`,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", String(rendition.crf), "-pix_fmt", "yuv420p",
            ...ENCODER_THREADS,
            "-c:a", "aac", "-b:a", "48k", "-ac", "1",
            "-movflags", "+faststart", "-fs", String(options.maxBytes), "-f", "mp4", out,
          ],
          { timeout: TRANSCODE_TIMEOUT_MS, cwd: options.outDir, signal: options.signal, tool: "ffmpeg" },
        );
        const { size } = await fs.stat(out).catch(() => ({ size: Number.POSITIVE_INFINITY }));
        // -fs truncates rather than fails, so a file right at the cap is a truncated one.
        if (size < options.maxBytes) {
          return { path: out, bytes: size, height: rendition.height };
        }
      }
      throw new FfmpegError(`Video does not fit in ${options.maxBytes} bytes even at 360p; use delivery=frames or a shorter clip`);
    },

    async extractAudio(input, options) {
      const out = path.join(options.outDir, "audio.aac");
      await run(
        ffmpegPath,
        [
          ...inputArgs(options.demuxer),
          "-i", input, "-t", String(options.durationSeconds),
          "-vn", "-sn", "-dn", "-ac", "1", "-ar", "24000", "-c:a", "aac", "-b:a", "48k",
          "-fs", String(AUDIO_OUTPUT_CAP_BYTES), "-f", "adts", out,
        ],
        { timeout: TRANSCODE_TIMEOUT_MS, cwd: options.outDir, signal: options.signal, tool: "ffmpeg" },
      );
      return { buffer: await readOutput(out), mimeType: "audio/aac" };
    },
  };
}

let defaultFfmpeg: Ffmpeg | undefined;

export function getFfmpeg(): Ffmpeg {
  if (!defaultFfmpeg) {
    defaultFfmpeg = createFfmpeg({
      ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
      ffprobePath: process.env.FFPROBE_PATH?.trim() || undefined,
    });
  }
  return defaultFfmpeg;
}

export function configureFfmpegForTests(instance: Ffmpeg | undefined): void {
  defaultFfmpeg = instance;
}
