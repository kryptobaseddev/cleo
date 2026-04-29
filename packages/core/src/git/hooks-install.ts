/**
 * Git hook installer (T1588).
 *
 * Copies CLEO's project-agnostic git hooks from the cleo template directory
 * into the target project's `.git/hooks/` (or `core.hooksPath` if set).
 *
 * Project-agnostic: the templates are POSIX `/bin/sh` and have no
 * node/pnpm dependencies, so they install cleanly into Rust, Python,
 * bare-repo, or any other environment cleo init runs against.
 *
 * Sentinel-based ownership: only files containing the
 * `# CLEO_MANAGED_HOOK v1` line in their first 5 lines are considered
 * CLEO-owned and will be overwritten without `force`. Any pre-existing,
 * non-CLEO hook is preserved unless `force: true` is passed.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sentinel line embedded in every CLEO-managed hook script. Used to
 * distinguish CLEO-owned hooks from user-customized hooks at upgrade
 * time, so a `cleo upgrade hooks_sync` (T1588) never clobbers user work.
 */
export const CLEO_HOOK_SENTINEL = '# CLEO_MANAGED_HOOK v1';

/**
 * The set of hooks CLEO ships and manages. Order matches the order
 * we iterate them; both names match the on-disk filenames in
 * `packages/cleo/templates/hooks/`.
 */
export const CLEO_HOOK_NAMES = ['commit-msg', 'pre-push'] as const;
export type CleoHookName = (typeof CLEO_HOOK_NAMES)[number];

/** Options for {@link installCleoHooks}. */
export interface InstallCleoHooksOptions {
  /**
   * Override the hook source directory. Defaults to
   * `<repoRoot>/packages/cleo/templates/hooks` (in-monorepo) or the
   * resolved package install location at runtime.
   */
  templatesDir?: string;
  /**
   * If true, overwrite existing hook files even when they are NOT
   * CLEO-managed (no sentinel). Used for emergency repair / explicit
   * `--force`. Defaults to false.
   */
  force?: boolean;
  /**
   * If true, do not actually write — return what WOULD happen.
   */
  dryRun?: boolean;
}

/** Result of {@link installCleoHooks}. */
export interface InstallCleoHooksResult {
  /** Absolute path to the hooks dir we wrote into. */
  hooksDir: string;
  /** Names of hooks that were installed (newly written or overwritten). */
  installed: CleoHookName[];
  /** Names of hooks skipped because a non-CLEO file already exists. */
  skipped: CleoHookName[];
  /** Reason for each skip, keyed by hook name. */
  skipReasons: Partial<Record<CleoHookName, string>>;
}

/**
 * Install CLEO's git hooks into a project.
 *
 * Resolves `core.hooksPath` first (so Husky / lefthook / nested
 * worktree configs are respected). Falls back to `<projectRoot>/.git/hooks`.
 *
 * For each managed hook:
 *  - If the destination file is missing → write it (mode 0o755).
 *  - If it exists AND has the CLEO sentinel → overwrite (refresh).
 *  - If it exists AND has NO sentinel → skip unless `force: true`.
 *
 * @param projectRoot Absolute path to the git project root.
 * @param opts        See {@link InstallCleoHooksOptions}.
 * @returns Summary of installed/skipped hooks.
 * @throws If `projectRoot` is not a git repository.
 */
export async function installCleoHooks(
  projectRoot: string,
  opts: InstallCleoHooksOptions = {},
): Promise<InstallCleoHooksResult> {
  const absRoot = path.resolve(projectRoot);
  const gitDir = resolveGitDir(absRoot);
  if (!gitDir) {
    throw new Error(
      `installCleoHooks: ${absRoot} is not inside a git repository (no .git/ found).`,
    );
  }

  const hooksDir = resolveHooksDir(absRoot, gitDir);
  if (!opts.dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  if (!fs.existsSync(templatesDir)) {
    throw new Error(`installCleoHooks: hook templates dir not found: ${templatesDir}`);
  }

  const installed: CleoHookName[] = [];
  const skipped: CleoHookName[] = [];
  const skipReasons: Partial<Record<CleoHookName, string>> = {};

  for (const name of CLEO_HOOK_NAMES) {
    const src = path.join(templatesDir, name);
    const dst = path.join(hooksDir, name);

    if (!fs.existsSync(src)) {
      throw new Error(`installCleoHooks: missing template ${src}`);
    }

    if (fs.existsSync(dst) && !opts.force) {
      const isManaged = isCleoManagedHook(dst);
      if (!isManaged) {
        skipped.push(name);
        skipReasons[name] = 'existing non-CLEO hook (no sentinel) — pass force:true to overwrite';
        continue;
      }
    }

    if (!opts.dryRun) {
      const body = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(dst, body, { mode: 0o755 });
      // Some filesystems (Windows under WSL) don't honor the mode in
      // writeFileSync — chmod explicitly.
      try {
        fs.chmodSync(dst, 0o755);
      } catch {
        // Best-effort; on non-POSIX filesystems chmod is a no-op.
      }
    }
    installed.push(name);
  }

  return { hooksDir, installed, skipped, skipReasons };
}

/**
 * Returns true when `filePath` is a CLEO-managed hook (the first 5 lines
 * contain {@link CLEO_HOOK_SENTINEL}). Returns false on read error.
 */
export function isCleoManagedHook(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    const firstFive = head.split('\n', 6).slice(0, 5).join('\n');
    return firstFive.includes(CLEO_HOOK_SENTINEL);
  } catch {
    return false;
  }
}

/**
 * Resolve the `.git` directory for a project. Returns `null` when the
 * path is not inside a git repository.
 *
 * Handles both `.git/` (regular repo) and `.git` as a file (worktree
 * pointing at `gitdir: ...`).
 */
export function resolveGitDir(projectRoot: string): string | null {
  const dotGit = path.join(projectRoot, '.git');
  if (!fs.existsSync(dotGit)) {
    return null;
  }
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) {
    return dotGit;
  }
  if (stat.isFile()) {
    // Worktree-style `.git` file: `gitdir: <abs-or-rel-path>`.
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const target = m[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
  }
  return null;
}

/**
 * Resolve the hooks directory the project actually uses.
 *
 * If `core.hooksPath` is set (Husky / lefthook / custom), respect it.
 * Otherwise fall back to `<gitDir>/hooks`.
 */
export function resolveHooksDir(projectRoot: string, gitDir: string): string {
  // 1. Try `git config core.hooksPath`.
  try {
    const out = execFileSync('git', ['-C', projectRoot, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
    }
  } catch {
    // git config exits 1 when key is unset — fall through.
  }
  return path.join(gitDir, 'hooks');
}

/**
 * Default templates dir resolution.
 *
 * Tries (in order):
 *  1. Sibling to compiled JS:   `<this dir>/../../templates/hooks`
 *     (works once @cleocode/cleo is installed and shipped with templates).
 *  2. Monorepo source layout:   `<repoRoot>/packages/cleo/templates/hooks`
 *     (used during local dev / tests against repo source).
 *
 * Tests should pass `templatesDir` explicitly to bypass resolution.
 */
export function defaultTemplatesDir(): string {
  // Walk up from this file looking for `packages/cleo/templates/hooks`.
  // Works in both ts source (during vitest) and compiled dist.
  const here = fileURLToDirname();
  const candidates: string[] = [];
  let cursor = here;
  // Up to 8 parents — covers nested test runs and dist.
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(cursor, 'templates', 'hooks'));
    candidates.push(path.join(cursor, 'packages', 'cleo', 'templates', 'hooks'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Final fallback — return the most-likely path so the caller gets a
  // useful error message in `installCleoHooks`.
  return path.join(here, '..', '..', 'templates', 'hooks');
}

/** Return the directory containing the calling module, ESM-safe. */
function fileURLToDirname(): string {
  // import.meta.url isn't available in CJS; vitest runs ESM in this repo
  // (see packages/core/package.json "type": "module").
  const url = import.meta.url;
  const filePath = url.startsWith('file://') ? new URL(url).pathname : url;
  return path.dirname(filePath);
}
