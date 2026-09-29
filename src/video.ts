import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import type { Job } from './jobs.ts';

/**
 * Video and motion (FR-19, FR-20, FR-22, FR-24).
 *
 * One video per viewport, sized to the viewport (FR-19): Playwright records
 * the capture session to WebM, then — after the context closes and the file
 * is final (FR-24) — ffmpeg trims dead time, transcodes to the configured
 * formats (MP4/WebM/GIF), and enforces the size budget with escalating
 * compression. Without an ffmpeg binary the raw WebM ships with a warning.
 */

const execFileAsync = promisify(execFile);

export const videoSchema = z
  .object({
    /** Record a scroll-through walkthrough per page x viewport (FR-20). */
    walkthrough: z.boolean().default(true),
    /** Output formats. MP4 default; GIF/WebM opt-in (FR-22). */
    formats: z.array(z.enum(['mp4', 'webm', 'gif'])).min(1).max(3).default(['mp4']),
    /** Per-clip budget; escalating compression applies past it (FR-22). */
    maxSizeMB: z.number().min(1).max(100).default(5),
    /** Walkthrough scroll duration in ms (FR-20 "configurable speed"). */
    durationMs: z.number().int().min(1000).max(60000).default(5000),
    /** Recording framerate. */
    fps: z.number().int().min(5).max(30).default(15),
  })
  .strict();

export type VideoConfig = z.infer<typeof videoSchema>;

export type VideoFile = {
  path: string;
  format: 'mp4' | 'webm' | 'gif';
  bytes: number;
};

/** Locate an ffmpeg binary: ffmpeg-static, FFMPEG_PATH, or system PATH. */
export async function findFfmpeg(): Promise<string | null> {
  try {
    const mod = (await import('ffmpeg-static').catch(() => null)) as { default?: string } | null;
    const bundled = typeof mod === 'string' ? mod : mod?.default;
    if (bundled) {
      await stat(bundled);
      return bundled;
    }
  } catch {
    /* fall through */
  }
  if (process.env.FFMPEG_PATH) {
    try {
      await stat(process.env.FFMPEG_PATH);
      return process.env.FFMPEG_PATH;
    } catch {
      /* fall through */
    }
  }
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(probe, ['ffmpeg']);
    return 'ffmpeg';
  } catch {
    return null;
  }
}

export type WalkthroughPage = {
  evaluate: (fn: (arg: { durationMs: number }) => Promise<void>, arg: { durationMs: number }) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
};

/**
 * Auto-generated scroll-through walkthrough (FR-20): smooth eased scroll from
 * top to bottom, then back to top so the page is left in a consistent state.
 * Runs while Playwright records, so the clip shows the real page journey.
 */
export async function walkthrough(
  page: WalkthroughPage,
  options: { durationMs?: number } = {},
): Promise<void> {
  const durationMs = options.durationMs ?? 5000;
  await page
    .evaluate(
      async ({ durationMs: total }) => {
        const doc = document.documentElement;
        const max = Math.max(0, doc.scrollHeight - window.innerHeight);
        if (max <= 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(total / 4, 1000)));
          return;
        }
        const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        const started = performance.now();
        await new Promise<void>((resolve) => {
          const frame = () => {
            const t = Math.min(1, (performance.now() - started) / total);
            window.scrollTo(0, Math.round(easeInOut(t) * max));
            if (t < 1) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        window.scrollTo(0, 0);
      },
      { durationMs },
    )
    .catch(() => undefined);
  await page.waitForTimeout(300).catch(() => undefined);
}

export type TranscodeOptions = {
  ffmpeg: string;
  /** Seconds to skip from the recording start (navigation/warmup dead time). */
  trimStartSec?: number;
  maxSizeMB?: number;
  fps?: number;
};

async function fileBytes(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpeg, args);
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0] ?? 'ffmpeg failed';
    throw new Error(`ffmpeg failed: ${msg.slice(0, 200)}`);
  }
}

function seekArgs(trimStartSec: number): string[] {
  // Output seeking (after -i): decodes up to the offset, so it stays accurate
  // on recordings with sparse seek indexes, where input seeking can jump to
  // EOF and yield a header-only file. Slightly slower; always correct.
  return trimStartSec > 0.05 ? ['-ss', trimStartSec.toFixed(2)] : [];
}

/** Scale filter keeping aspect, capping width for the budget ladder. */
function scaleFilter(maxWidth: number): string {
  return `scale=${maxWidth}:-2`;
}

/**
 * Transcode a raw WebM recording to MP4 (H.264), enforcing the size budget
 * with two rungs: clean CRF 23, then CRF 28 + 720p cap. Returns the output.
 */
export async function transcodeMp4(
  input: string,
  output: string,
  options: TranscodeOptions,
): Promise<VideoFile> {
  const { ffmpeg, trimStartSec = 0, maxSizeMB = 5, fps = 15 } = options;
  const base = ['-y', '-i', input, ...seekArgs(trimStartSec)];
  await runFfmpeg(ffmpeg, [
    ...base,
    '-an',
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '23',
    '-preset',
    'veryfast',
    '-movflags',
    '+faststart',
    output,
  ]);
  if ((await fileBytes(output)) > maxSizeMB * 1024 * 1024) {
    await runFfmpeg(ffmpeg, [
      ...base,
      '-an',
      '-r',
      String(fps),
      '-vf',
      scaleFilter(720),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '28',
      '-preset',
      'veryfast',
      '-movflags',
      '+faststart',
      output,
    ]);
  }
  return { path: output, format: 'mp4', bytes: await fileBytes(output) };
}

/**
 * Two-pass palette GIF (FR-22): palettegen then paletteuse, 480px wide at
 * 10fps, then a 320px fallback when the budget is exceeded.
 */
export async function transcodeGif(
  input: string,
  output: string,
  options: TranscodeOptions,
  workDir: string,
): Promise<VideoFile> {
  const { ffmpeg, trimStartSec = 0, maxSizeMB = 5 } = options;
  const palette = path.join(workDir, `${path.basename(output)}.palette.png`);
  const base = ['-y', '-i', input];
  // Filter-based trim: accurate on sparse-index recordings, and scoped to the
  // video input so the single-frame palette input is unaffected.
  const trim =
    trimStartSec > 0.05 ? `trim=start=${trimStartSec.toFixed(2)},setpts=PTS-STARTPTS,` : '';
  const makeGif = async (width: number, rate: number) => {
    await runFfmpeg(ffmpeg, [
      ...base,
      '-vf',
      `${trim}fps=${rate},${scaleFilter(width)}:flags=lanczos,palettegen`,
      palette,
    ]);
    await runFfmpeg(ffmpeg, [
      ...base,
      '-i',
      palette,
      '-lavfi',
      `${trim}fps=${rate},${scaleFilter(width)}:flags=lanczos[x];[x][1:v]paletteuse`,
      output,
    ]);
  };
  try {
    await makeGif(480, 10);
    if ((await fileBytes(output)) > maxSizeMB * 1024 * 1024) {
      await makeGif(320, 10);
    }
  } finally {
    await rm(palette, { force: true });
  }
  return { path: output, format: 'gif', bytes: await fileBytes(output) };
}

/**
 * Post-process one finalized recording into the configured formats.
 * Returns the produced files (run-relative paths resolved by the caller).
 */
export async function postProcessRecording(
  rawWebm: string,
  destDir: string,
  baseName: string,
  options: { formats: ('mp4' | 'webm' | 'gif')[]; maxSizeMB: number; fps: number; trimStartSec: number },
): Promise<VideoFile[]> {
  const ffmpeg = await findFfmpeg();
  await mkdir(destDir, { recursive: true });
  const produced: VideoFile[] = [];
  if (!ffmpeg) {
    // No transcoder: ship the raw WebM rather than no video at all.
    const dest = path.join(destDir, `${baseName}.webm`);
    await rename(rawWebm, dest).catch(() => undefined);
    produced.push({ path: dest, format: 'webm', bytes: await fileBytes(dest) });
    return produced;
  }
  if (options.formats.includes('mp4')) {
    produced.push(
      await transcodeMp4(path.resolve(rawWebm), path.join(destDir, `${baseName}.mp4`), {
        ffmpeg,
        trimStartSec: options.trimStartSec,
        maxSizeMB: options.maxSizeMB,
        fps: options.fps,
      }),
    );
  }
  if (options.formats.includes('gif')) {
    produced.push(
      await transcodeGif(path.resolve(rawWebm), path.join(destDir, `${baseName}.gif`), {
        ffmpeg,
        trimStartSec: options.trimStartSec,
        maxSizeMB: options.maxSizeMB,
      }, destDir),
    );
  }
  if (options.formats.includes('webm')) {
    const dest = path.join(destDir, `${baseName}.webm`);
    await rename(rawWebm, dest).catch(() => undefined);
    produced.push({ path: dest, format: 'webm', bytes: await fileBytes(dest) });
  } else {
    await rm(rawWebm, { force: true }).catch(() => undefined);
  }
  return produced;
}

/** Video file stem for a job: device, scheme, and flow suffixes when present. */
export function videoBaseName(job: Job): string {
  const schemeSuffix = job.scheme && job.scheme !== 'light' ? `-${job.scheme}` : '';
  const flowSuffix = job.flowName
    ? `-${job.flowName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'flow'}`
    : '';
  return `${job.device.name}${schemeSuffix}${flowSuffix}`;
}
