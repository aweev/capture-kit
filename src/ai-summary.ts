import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chatCompletion } from './ai-client.ts';
import type { AiConfig } from './ai-config.ts';
import type { Manifest } from './manifest.ts';

/**
 * Client summary (FR-43).
 *
 * "What changed" blurb from the git diff plus the capture manifest. The model
 * writes `client-summary.md`; without a key (or with AI disabled) the caller
 * skips this step — the tool functions fully without it.
 */

const execFileAsync = promisify(execFile);

async function gitDiffStat(cwd: string, maxChars = 4000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], { cwd });
    return stdout.slice(0, maxChars) || '(no uncommitted changes)';
  } catch {
    return '(git unavailable)';
  }
}

async function gitLogShort(cwd: string, maxChars = 1500): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', '-8'], { cwd });
    return stdout.slice(0, maxChars) || '(no history)';
  } catch {
    return '(git unavailable)';
  }
}

export async function generateClientSummary(
  config: AiConfig,
  manifest: Manifest,
  options: { cwd?: string; fetchFn?: typeof fetch } = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const [diffStat, log] = await Promise.all([gitDiffStat(cwd), gitLogShort(cwd)]);
  const assetLines = manifest.assets
    .map((a) => `- ${a.page} (${a.viewport}${a.scheme && a.scheme !== 'light' ? `, ${a.scheme}` : ''})`)
    .slice(0, 60)
    .join('\n');
  const failedLines =
    manifest.failures.length > 0
      ? `\nFailed captures (do not promise these as done):\n${manifest.failures.map((f) => `- ${f.page} (${f.viewport}): ${f.reason}`).join('\n')}`
      : '';
  return chatCompletion(
    config,
    [
      {
        role: 'system',
        content:
          'You write short client update notes for a web agency. Plain Markdown, no hype, no emojis. Structure: a 2-sentence overview, then "What changed" bullets (user-visible only — never mention tooling, commits, or file names), then "Open items" only if failures are listed. Under 200 words.',
      },
      {
        role: 'user',
        content: `Recent commits:\n${log}\n\nChanged files:\n${diffStat}\n\nCaptured pages:\n${assetLines}${failedLines}`,
      },
    ],
    { maxTokens: 600, fetchFn: options.fetchFn },
  );
}
