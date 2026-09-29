import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { chatCompletion, type ChatPart } from './ai-client.ts';
import type { AiConfig } from './ai-config.ts';
import type { ManifestAsset } from './manifest.ts';

/**
 * Alt text and captions (FR-41).
 *
 * A vision model describes up to `maxAltAssets` screenshots (smallest files
 * first, oversized images skipped) and the run records them in `alt.json` for
 * review. The gallery (M1) can pick this file up for `alt` attributes; nothing
 * else in the pipeline depends on it.
 */

export type AltEntry = { alt: string; caption: string };

const SYSTEM_PROMPT =
  'You describe website screenshots for alt text. Reply with a JSON object mapping each image index (as a string, e.g. "0") to {"alt": "...", "caption": "..."}. Alt: one sentence, plain, under 140 characters, no "screenshot of" preamble. Caption: one engaging line for a client gallery.';

function mimeFor(assetPath: string): string {
  const ext = path.extname(assetPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

export async function generateAltText(
  config: AiConfig,
  runDir: string,
  assets: ManifestAsset[],
  options: { fetchFn?: typeof fetch } = {},
): Promise<Record<string, AltEntry>> {
  const images = assets.filter((a) => /\.(png|jpe?g|webp|gif)$/i.test(a.path));
  images.sort((a, b) => a.bytes - b.bytes);
  const picked = images.slice(0, config.maxAltAssets);

  const parts: ChatPart[] = [{ type: 'text', text: 'Describe these page screenshots:' }];
  const indexToPath: string[] = [];
  for (const asset of picked) {
    let data: Buffer;
    try {
      data = await readFile(path.join(runDir, asset.path));
    } catch {
      continue;
    }
    if (data.length > config.maxImageBytes) continue;
    const index = indexToPath.length;
    indexToPath.push(asset.path);
    parts.push({ type: 'text', text: `Image ${index}: ${asset.page} on ${asset.viewport}` });
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeFor(asset.path)};base64,${data.toString('base64')}` },
    });
  }
  if (indexToPath.length === 0) return {};

  const raw = await chatCompletion(
    config,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ],
    { json: true, fetchFn: options.fetchFn },
  );
  let parsed: Record<string, AltEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, AltEntry>;
  } catch {
    throw new Error('AI returned non-JSON alt text; skipping.');
  }
  const result: Record<string, AltEntry> = {};
  for (const [index, entry] of Object.entries(parsed)) {
    const assetPath = indexToPath[Number(index)];
    if (!assetPath || typeof entry?.alt !== 'string') continue;
    result[assetPath] = {
      alt: entry.alt.slice(0, 300),
      caption: typeof entry.caption === 'string' ? entry.caption.slice(0, 300) : '',
    };
  }
  return result;
}
