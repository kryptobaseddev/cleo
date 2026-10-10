/**
 * Git hook installer (T1588).
 *
 * Copies CLEO's project-agnostic git hooks from the
 * `@cleocode/core/templates/git-hooks/` directory (T9858 relocated from
 * `packages/cleo/templates/hooks/`) into the target project's
 * `.git/hooks/` (or `core.hooksPath` if set).
 *
 * Project-agnostic: the templates are POSIX `/bin/sh` and have no
 * node/pnpm dependencies, so they install cleanly into Rust, Python,
 * bare-repo, or any other environment cleo init runs against.
 *
 * Content-based ownership: only exact shipped templates or hash-verified installation receipts authorize
 * refresh. Foreign and customized files are always preserved.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEO_GIT_HOOK_NAMES,
  type GitHookChange,
  type GitHookInstallReceipt,
  GitHookInstallReceiptSchema,
  GitHookLegacyHashesSchema,
} from '@cleocode/contracts/git-hooks.js';
import { atomicWrite } from '../store/atomic.js';
import { withFileLock } from '../store/file-utils.js';

/**
 * Diagnostic marker embedded in shipped hooks. A marker alone never grants
 * refresh authority; installation validates content hashes.
 */
export const CLEO_HOOK_SENTINEL = '# CLEO_MANAGED_HOOK v1';

/**
 * The set of hooks CLEO ships and manages. Order matches the order
 * we iterate them; all names match the on-disk filenames in
 * `packages/core/templates/git-hooks/` (T9858 relocated cleo→core).
 */
export const CLEO_HOOK_NAMES = CLEO_GIT_HOOK_NAMES;
/** Name of a shipped Git hook. */
export type CleoHookName = (typeof CLEO_HOOK_NAMES)[number];

/** Options for {@link installCleoHooks}. */
export interface InstallCleoHooksOptions {
  /**
   * Override the hook source directory. Defaults to
   * `<repoRoot>/packages/core/templates/git-hooks` (in-monorepo) or the
   * resolved `@cleocode/core` install location at runtime. T9858 relocated
   * the hook templates packages/cleo → packages/core.
   */
  templatesDir?: string;
  /**
   * Deprecated compatibility flag. It never bypasses ownership validation.
   */
  force?: boolean;
  /**
   * If true, do not actually write — return what WOULD happen.
   */
  dryRun?: boolean;
  /** Restore a prior installation only while its current hashes match. */
  rollbackReceipt?: GitHookInstallReceipt;
}

/** Result of {@link installCleoHooks}. */
export interface InstallCleoHooksResult {
  /** Absolute path to the hooks dir we wrote into. */
  hooksDir: string;
  /** Recovery receipt for this installation; absent on previews. */
  receipt?: GitHookInstallReceipt;
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
 * worktree configs are respected). Git resolves the common directory for linked worktrees.
 *
 * For each managed hook:
 *  - If the destination file is missing → write it (mode 0o755).
 *  - If its hash matches a shipped template or receipt → refresh.
 *  - Otherwise preserve it, including files with customized CLEO markers.
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

  // Validate the entire shipped set before replacing any destination.
  for (const name of CLEO_HOOK_NAMES) {
    const source = path.join(templatesDir, name);
    if (!fs.existsSync(source)) throw new Error(`installCleoHooks: missing template ${source}`);
  }

  const perform = async (): Promise<InstallCleoHooksResult> => {
    const installed: CleoHookName[] = [];
    const skipped: CleoHookName[] = [];
    const skipReasons: Partial<Record<CleoHookName, string>> = {};
    const changes: GitHookChange[] = [];
    const ledgerPath = path.join(hooksDir, '.cleo-install-receipt.json');
    const ledger = readReceipt(ledgerPath);
    if (opts.rollbackReceipt) {
      const receipt = GitHookInstallReceiptSchema.parse(opts.rollbackReceipt);
      if (receipt.hooksDir !== hooksDir) throw new Error('Git hook rollback directory mismatch');
      for (const change of receipt.changes) {
        const dst = path.join(hooksDir, change.name);
        if (
          !fs.existsSync(dst) ||
          fs.lstatSync(dst).isSymbolicLink() ||
          hash(fs.readFileSync(dst, 'utf8')) !== change.afterHash
        ) {
          skipped.push(change.name);
          skipReasons[change.name] = 'rollback conflict: hook changed since installation';
          continue;
        }
        if (!opts.dryRun) {
          if (change.before === null) fs.unlinkSync(dst);
          else await atomicWrite(dst, change.before, { mode: change.beforeMode ?? 0o755 });
        }
        installed.push(change.name);
      }
      if (!opts.dryRun && ledger) {
        const restored = receipt.changes.filter((change) => installed.includes(change.name));
        const untouched = ledger.changes.filter((change) => !installed.includes(change.name));
        const images = restored.flatMap((change) =>
          change.before === null ? [] : [{ ...change, afterHash: hash(change.before) }],
        );
        await atomicWrite(
          ledgerPath,
          JSON.stringify({ ...ledger, changes: [...untouched, ...images] }) + '\n',
          { mode: 0o600 },
        );
      }
      return { hooksDir, installed, skipped, skipReasons };
    }
    for (const name of CLEO_HOOK_NAMES) {
      const src = path.join(templatesDir, name);
      const dst = path.join(hooksDir, name);
      const body = fs.readFileSync(src, 'utf8');
      const entry = fs.lstatSync(dst, { throwIfNoEntry: false });
      if (entry && !entry.isFile()) {
        skipped.push(name);
        skipReasons[name] = 'existing non-CLEO symbolic or non-file hook preserved';
        continue;
      }
      const exists = entry !== undefined;
      const before = exists ? fs.readFileSync(dst, 'utf8') : null;
      const recorded = ledger?.changes.find((change) => change.name === name);
      const safe =
        !exists ||
        (!fs.lstatSync(dst).isSymbolicLink() &&
          (before === body ||
            (before !== null && legacyHashes(name).includes(hash(before))) ||
            (before !== null && recorded?.afterHash === hash(before))));
      if (!safe) {
        skipped.push(name);
        skipReasons[name] =
          `existing non-CLEO or customized hook preserved; integration: sh '${src.replace(/'/g, "'\\''")}' "$@"`;
        continue;
      }
      const change = {
        name,
        before,
        beforeMode: exists ? fs.statSync(dst).mode & 0o777 : null,
        afterHash: hash(body),
      };
      changes.push(change);
      if (!opts.dryRun) await atomicWrite(dst, body, { mode: 0o755 });
      installed.push(name);
    }
    const receipt: GitHookInstallReceipt = { schemaVersion: 1, hooksDir, changes };
    if (!opts.dryRun) {
      // Keep ownership for preserved entries, without claiming foreign files.
      const retained =
        ledger?.changes.filter((change) => !changes.some((next) => next.name === change.name)) ??
        [];
      await atomicWrite(
        ledgerPath,
        JSON.stringify({ ...receipt, changes: [...retained, ...changes] }) + '\n',
        { mode: 0o600 },
      );
    }
    return { hooksDir, installed, skipped, skipReasons, ...(opts.dryRun ? {} : { receipt }) };
  };
  return opts.dryRun ? perform() : withFileLock(path.join(hooksDir, '.cleo-install'), perform);
}

function hash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function readReceipt(filePath: string): GitHookInstallReceipt | undefined {
  const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile()) throw new Error('Git hook receipt is not a regular file');
  const parsed = GitHookInstallReceiptSchema.safeParse(
    JSON.parse(fs.readFileSync(filePath, 'utf8')),
  );
  if (!parsed.success || parsed.data.hooksDir !== path.dirname(filePath)) {
    throw new Error('Git hook receipt is invalid or belongs to another directory');
  }
  return parsed.data;
}

function legacyHashes(name: CleoHookName): string[] {
  const file = path.join(defaultTemplatesDir(), 'legacy-hashes.json');
  if (!fs.existsSync(file)) return [];
  const parsed = GitHookLegacyHashesSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? (parsed.data[name] ?? []) : [];
}

/**
 * Detect the CLEO marker for diagnostics, without establishing ownership.
 * Returns false on read error; installers must validate the content hash.
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
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the hooks directory the project actually uses.
 *
 * If `core.hooksPath` is set (Husky / lefthook / custom), respect it.
 * Git resolves its common directory for linked worktrees.
 */
export function resolveHooksDir(projectRoot: string, gitDir: string): string {
  // Git resolves both the common worktree directory and core.hooksPath.
  const resolved = execFileSync(
    'git',
    ['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim();
  void gitDir; // Retained for source compatibility with existing consumers.
  return resolved;
}

/**
 * Default templates dir resolution.
 *
 * Tries (in order):
 *  1. Sibling to compiled JS:   `<this dir>/../../templates/git-hooks`
 *     (works once @cleocode/core is installed and shipped with templates).
 *  2. Monorepo source layout:   `<repoRoot>/packages/core/templates/git-hooks`
 *     (used during local dev / tests against repo source).
 *
 * T9858 relocated the hook templates packages/cleo → packages/core, so the
 * canonical layout is now `packages/core/templates/git-hooks/`. We retain
 * fallback probes for the legacy `packages/cleo/templates/hooks/` path so
 * old global installs continue to function during the v2026.5.x upgrade
 * window.
 *
 * Tests should pass `templatesDir` explicitly to bypass resolution.
 */
export function defaultTemplatesDir(): string {
  // Walk up from this file looking for the canonical layout first, then
  // the legacy layout as a fallback. Works in both ts source (during
  // vitest) and compiled dist.
  const here = fileURLToDirname();
  const candidates: string[] = [];
  let cursor = here;
  // Up to 8 parents — covers nested test runs and dist.
  for (let i = 0; i < 8; i += 1) {
    // Canonical layout (T9858+).
    candidates.push(path.join(cursor, 'templates', 'git-hooks'));
    candidates.push(path.join(cursor, 'packages', 'core', 'templates', 'git-hooks'));
    // Legacy layout (pre-T9858) — kept for old global installs.
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
  return path.join(here, '..', '..', 'templates', 'git-hooks');
}

/** Return the directory containing the calling module, ESM-safe. */
function fileURLToDirname(): string {
  // import.meta.url isn't available in CJS; vitest runs ESM in this repo
  // (see packages/core/package.json "type": "module").
  const filePath = fileURLToPath(import.meta.url);
  return path.dirname(filePath);
}
