/**
 * Path glob matching shared by discovery filtering (FR-5) and per-page capture
 * overrides (FR-11), so a pattern means the same thing in both places.
 */

/**
 * Match a path against a glob supporting `*`, `**`, and `?`.
 *
 * A `/**` suffix also matches the prefix itself: `"/blog/**"` means "the blog
 * and everything under it", which is what a user writing that pattern expects.
 * `*` alone never crosses a path separator.
 */
export function matchGlob(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${regexPattern}$`).test(path);
}

/** True when the path matches any pattern in the list, or the list is empty. */
export function matchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => matchGlob(path, pattern));
}
