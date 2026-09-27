/**
 * Shared entry-point check for `scripts/*.mjs` (T12488).
 *
 * The idiom `import.meta.url === \`file://${process.argv[1]}\`` is false
 * whenever the script path needs URL encoding: `import.meta.url`
 * percent-encodes a space (`Application%20Support`) while `argv[1]` does
 * not. `new URL(import.meta.url).pathname` has the same flaw. On macOS every
 * CLEO worktree lives under `~/Library/Application Support/`, so a gate using
 * either idiom skipped `main()` and exited 0 — a green that checked nothing.
 * Windows drive letters and backslashes break the string form the same way.
 *
 * Comparing filesystem paths (both realpath-resolved, so a symlinked
 * checkout also matches) is correct on every OS.
 *
 * @module scripts/lib/is-main
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve a path through symlinks, falling back to the plain resolved path
 * when the file cannot be stat'ed.
 *
 * @param {string} p - Path to resolve.
 * @returns {string} The canonical absolute path.
 */
function canonical(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * True when the module whose `import.meta.url` is given is the process entry
 * point (run as `node scripts/x.mjs`), false when it is imported.
 *
 * @param {string} metaUrl - The caller's `import.meta.url`.
 * @returns {boolean} Whether the caller is the entry script.
 */
export function isMain(metaUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return canonical(invoked) === canonical(fileURLToPath(metaUrl));
}
