/**
 * Environment fingerprint for the evidence tool cache (T12958, review of #1774).
 *
 * The tree hash identifies the SOURCE a run measured. Tools that read build
 * output or installed dependencies also depend on per-checkout state git does
 * not see: `node_modules`, gitignored `dist/` directories that workspace
 * packages resolve through, and `.env*` files. Two worktrees with identical
 * source but a stale `dist/` in one of them must not share a `test` result.
 *
 * The fingerprint is cheap and content-shaped, so two checkouts that were
 * installed and built from the same source compare EQUAL (sharing works) while
 * a missing install, a different install or a stale build compares different:
 *
 *   - the installed-lockfile snapshot the package manager keeps inside
 *     `node_modules` (`.pnpm/lock.yaml`, `.package-lock.json`,
 *     `.yarn-state.yml`, `.yarn-integrity`) — hashed by content, because
 *     pnpm's `.modules.yaml` carries a per-install timestamp;
 *   - for every workspace package (each tracked `package.json`), the
 *     relative path and SIZE of every file under its `dist/` — sizes rather
 *     than mtimes, which differ between two equally fresh builds;
 *   - the content of untracked `.env*` files at the execution root.
 *
 * Sizes are a heuristic: a rebuild from different source that produces
 * byte-for-byte equal sizes everywhere would collide. When the `dist/` walk
 * exceeds {@link MAX_DIST_FILES} the fingerprint falls back to the execution
 * root itself, which disables cross-worktree sharing rather than guessing.
 *
 * Only {@link ENV_SENSITIVE_TOOLS} pay for this; other tools get a constant.
 *
 * @task T12958
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Canonical tools whose result depends on installed deps or build output. */
export const ENV_SENSITIVE_TOOLS: ReadonlySet<string> = new Set(['test', 'build', 'typecheck']);

/** Fingerprint for tools that read only source. */
export const ENV_FINGERPRINT_NONE = 'none';

/** Most `dist/` files walked before falling back to the execution root. */
export const MAX_DIST_FILES = 100_000;

const INSTALL_SNAPSHOTS = [
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
  'node_modules/.yarn-integrity',
];

/** Directories of every tracked `package.json`, relative to `root`. */
function workspacePackageDirs(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'package.json', '**/package.json'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split('\0')
      .filter(Boolean)
      .map((f) => dirname(f))
      .sort();
  } catch {
    return ['.'];
  }
}

/**
 * Append `relpath:size` for every file under `dir` to `out`, without following
 * symlinks. Returns `false` once `out` exceeds {@link MAX_DIST_FILES}.
 */
function walkSizes(dir: string, rel: string, out: string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return true;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!walkSizes(abs, `${rel}/${name}`, out)) return false;
    } else {
      out.push(`${rel}/${name}:${st.isSymbolicLink() ? 'link' : st.size}`);
      if (out.length > MAX_DIST_FILES) return false;
    }
  }
  return true;
}

/**
 * Fingerprint the per-checkout environment a tool run depends on.
 *
 * @param root - The execution root.
 * @param canonical - Canonical tool name.
 * @returns 32 hex chars, or {@link ENV_FINGERPRINT_NONE} for tools outside
 *   {@link ENV_SENSITIVE_TOOLS}.
 *
 * @task T12958
 */
export function captureEnvFingerprint(root: string, canonical: string): string {
  if (!ENV_SENSITIVE_TOOLS.has(canonical)) return ENV_FINGERPRINT_NONE;
  const hash = createHash('sha256');

  const snapshot = INSTALL_SNAPSHOTS.find((p) => existsSync(join(root, p)));
  hash.update(`install:${snapshot ?? 'none'}\n`);
  if (snapshot) hash.update(readFileSync(join(root, snapshot)));

  const files: string[] = [];
  for (const pkg of workspacePackageDirs(root)) {
    if (!walkSizes(join(root, pkg, 'dist'), `${pkg}/dist`, files)) {
      // Too large to fingerprint cheaply: do not share across checkouts.
      let real = root;
      try {
        real = realpathSync(root);
      } catch {
        // keep the lexical root
      }
      return createHash('sha256').update(`root:${real}`).digest('hex').slice(0, 32);
    }
  }
  hash.update(files.join('\n'));

  let entries: string[] = [];
  try {
    entries = readdirSync(root)
      .filter((n) => n.startsWith('.env'))
      .sort();
  } catch {
    // unreadable root: no env files
  }
  for (const name of entries) {
    const st = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    hash.update(`\nenv:${name}\n`);
    hash.update(readFileSync(join(root, name)));
  }
  return hash.digest('hex').slice(0, 32);
}
