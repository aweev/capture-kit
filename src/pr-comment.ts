import type { Manifest } from './manifest.ts';

/**
 * PR comment publisher (FR-37).
 *
 * The GitHub Action boots the app (or targets a preview URL), captures, uploads
 * the run as an artifact, and posts/updates a *single* PR comment with
 * thumbnails. Idempotency comes from a hidden marker: an existing comment with
 * the marker is updated in place instead of posting a second one.
 *
 * Thumbnails render inline only when `previewUrl` (or an equivalent hosted
 * gallery URL) is supplied; otherwise the comment carries the summary table,
 * the Markdown snippet, and a pointer at the uploaded artifact.
 */

export const PR_COMMENT_MARKER = '<!-- capturekit: visual capture -->';

export type PrCommentOptions = {
  /** Public base URL where the gallery/assets are hosted (optional). */
  previewUrl?: string;
  /** Max asset rows before collapsing the rest. */
  maxRows?: number;
};

function assetUrl(assetPath: string, previewUrl?: string): string {
  if (!previewUrl) return assetPath;
  return `${previewUrl.replace(/\/+$/, '')}/${assetPath}`;
}

/** One self-contained comment body; deterministic for a given manifest. */
export function buildPrComment(manifest: Manifest, options: PrCommentOptions = {}): string {
  const { summary, assets, failures } = manifest;
  const maxRows = options.maxRows ?? 12;
  const shown = assets.slice(0, maxRows);
  const lines = [
    PR_COMMENT_MARKER,
    `## Visual capture — ${summary.succeeded}/${summary.planned} succeeded`,
    '',
    `Target: \`${manifest.target}\` · run \`${manifest.runId}\` · ${Math.round(manifest.durationMs / 100) / 10}s${manifest.gitRef ? ` · ${manifest.gitRef}` : ''}`,
    '',
  ];
  if (shown.length > 0) {
    lines.push('| Page | Viewport | Asset |');
    lines.push('| ---- | -------- | ----- |');
    for (const asset of shown) {
      const label = `${asset.page} · ${asset.viewport}${asset.scheme && asset.scheme !== 'light' ? ` · ${asset.scheme}` : ''}`;
      if (options.previewUrl && /\.(png|jpe?g|webp|gif)$/i.test(asset.path)) {
        lines.push(
          `| ${asset.page} | ${asset.viewport} | ![${label}](${assetUrl(asset.path, options.previewUrl)}) |`,
        );
      } else {
        lines.push(`| ${asset.page} | ${asset.viewport} | \`${asset.path}\` |`);
      }
    }
    lines.push('');
  }
  if (assets.length > shown.length) {
    lines.push(`<details><summary>…and ${assets.length - shown.length} more assets</summary>`);
    lines.push('');
    for (const asset of assets.slice(maxRows)) {
      lines.push(`- \`${asset.path}\``);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (failures.length > 0) {
    lines.push(`<details><summary>${failures.length} failed</summary>`);
    lines.push('');
    for (const failure of failures) {
      lines.push(`- **${failure.page}** (${failure.viewport}): ${failure.reason}`);
    }
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n') + '\n';
}

export type GitHubRef = { owner: string; repo: string; pr: number };

export function parseGitHubRef(value: string): GitHubRef {
  const match = /^([^/\s]+)\/([^/\s]+)#(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid GitHub ref ${JSON.stringify(value)}: expected "owner/repo#123".`);
  }
  return { owner: match[1] as string, repo: match[2] as string, pr: Number(match[3]) };
}

type FetchFn = typeof fetch;

/**
 * Create the marker comment, or update it when one already exists.
 * Returns whether a new comment was created.
 */
export async function postOrUpdateComment(
  ref: GitHubRef,
  body: string,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<{ created: boolean; id: number }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const listUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.pr}/comments?per_page=100`;
  const listed = await fetchFn(listUrl, { headers });
  if (!listed.ok) {
    throw new Error(`Could not list PR comments (HTTP ${listed.status}).`);
  }
  const comments = (await listed.json()) as { id: number; body?: string }[];
  const existing = comments.find((comment) => comment.body?.includes(PR_COMMENT_MARKER));

  if (existing) {
    const updated = await fetchFn(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/comments/${existing.id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ body }) },
    );
    if (!updated.ok) throw new Error(`Could not update PR comment (HTTP ${updated.status}).`);
    return { created: false, id: existing.id };
  }
  const created = await fetchFn(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.pr}/comments`,
    { method: 'POST', headers, body: JSON.stringify({ body }) },
  );
  if (!created.ok) throw new Error(`Could not post PR comment (HTTP ${created.status}).`);
  const payload = (await created.json()) as { id: number };
  return { created: true, id: payload.id };
}
