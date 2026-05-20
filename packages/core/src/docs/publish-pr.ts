/**
 * publish-pr — foundation for `cleo docs publish-pr`.
 *
 * This file ships the pieces of the publish-pr flow that have no
 * git/gh side-effects:
 *   - slug validation (mirror of the docs domain validator)
 *   - branch naming (`docs/<slug>`)
 *   - temp worktree path generation
 *   - structured error envelope shape (LAFS-compatible)
 *   - reusable subprocess runner indirection so later commits can swap in
 *     real `git`/`gh` calls or test stubs without touching the surface area
 *
 * Subsequent commits layer the publish flow on top:
 *   - T9718 — new-doc publish flow with YAML frontmatter
 *   - T9717 — atomic update of an existing PR's body via force-push + edit
 *   - T9719 — structured error envelopes (E_NO_GH_AUTH, E_DETACHED_HEAD, …)
 *
 * @task T9716 (T9644 / Epic T9630 / Saga T9625)
 */

import { type ExecFileOptions, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Slug validation (mirror dispatch/docs.ts SLUG_PATTERN) ──────────────────

/** Kebab-case slug pattern, identical to the docs domain validator. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Maximum slug length, identical to the docs domain validator. */
const SLUG_MAX_LEN = 80;

/**
 * Closed taxonomy of doc types — mirrors `DOCS_TYPE_VALUES` in
 * `packages/cleo/src/dispatch/domains/docs.ts`. Used to pick the publish
 * subdir under `docs/<type>/`.
 */
export const KNOWN_DOC_TYPES = new Set<string>([
  'spec',
  'adr',
  'research',
  'handoff',
  'note',
  'llm-readme',
]);

/**
 * Validate a slug string against {@link SLUG_PATTERN}.
 *
 * @returns `{ ok: true, slug }` on success; `{ ok: false, reason }` otherwise.
 */
export function validatePublishSlug(
  raw: unknown,
): { ok: true; slug: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'slug must be a non-empty string' };
  }
  if (raw.length > SLUG_MAX_LEN) {
    return { ok: false, reason: `slug exceeds ${SLUG_MAX_LEN} characters` };
  }
  if (!SLUG_PATTERN.test(raw)) {
    return {
      ok: false,
      reason:
        "slug must be lowercase kebab-case (matches /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) — got '" +
        raw +
        "'",
    };
  }
  return { ok: true, slug: raw };
}

/** Map a doc type to its publish subdir (defaults to `note` when unknown). */
export function publishDirForType(type: string | null | undefined): string {
  if (typeof type === 'string' && KNOWN_DOC_TYPES.has(type)) return `docs/${type}`;
  return 'docs/note';
}

/** Compute the canonical branch name for a slug. */
export function branchForSlug(slug: string): string {
  return `docs/${slug}`;
}

/**
 * Build the publish-pr temp-worktree directory under `os.tmpdir()`.
 *
 * Each invocation produces a unique path with a random 8-hex suffix so
 * concurrent publishes for the same slug never collide.
 */
export function tempWorktreeDirForSlug(slug: string): string {
  const rand = randomBytes(4).toString('hex');
  return join(tmpdir(), `cleo-publish-pr-${slug}-${rand}`);
}

// ─── Error helper ────────────────────────────────────────────────────────────

/**
 * Structured LAFS error returned by the publish-pr flow.
 *
 * Mirrors the `{success:false, error}` shape that `cliError` serialises so
 * the CLI surface can forward the envelope without translation.
 */
export interface PublishPrError {
  readonly codeName: string;
  readonly message: string;
  readonly fix?: string;
  readonly alternatives?: readonly string[];
  readonly details?: Record<string, unknown>;
}

/** Construct a {@link PublishPrError} with all optional fields normalised. */
export function publishPrError(
  codeName: string,
  message: string,
  fix?: string,
  alternatives?: readonly string[],
  details?: Record<string, unknown>,
): PublishPrError {
  return {
    codeName,
    message,
    ...(fix !== undefined ? { fix } : {}),
    ...(alternatives !== undefined ? { alternatives } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/** Extract the stderr (or message) of a thrown execFile error. */
export function execMsg(e: unknown): string {
  if (e && typeof e === 'object') {
    const obj = e as { stderr?: unknown; message?: unknown };
    if (typeof obj.stderr === 'string' && obj.stderr.trim().length > 0) return obj.stderr.trim();
    if (typeof obj.message === 'string') return obj.message;
  }
  return String(e);
}

// ─── Subprocess helpers ──────────────────────────────────────────────────────

/**
 * Inject hooks let tests swap out `git` and `gh` invocations without forking
 * subprocesses. Real callers leave both undefined.
 */
export interface PublishPrRunners {
  readonly git?: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly gh?: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
}

/** Default subprocess runner — shells out via `execFile`. */
export async function defaultRun(
  bin: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecFileOptions = { cwd, env: process.env, maxBuffer: 8 * 1024 * 1024 };
  const { stdout, stderr } = await execFileAsync(bin, [...args], opts);
  return {
    stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf-8'),
    stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf-8'),
  };
}

/** Resolve a runner for `bin`, preferring the caller-supplied override. */
export function pickRunner(
  bin: 'git' | 'gh',
  runners: PublishPrRunners | undefined,
): (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }> {
  if (runners?.[bin]) return runners[bin];
  return (args, cwd) => defaultRun(bin, args, cwd);
}

// ─── Worktree lifecycle ──────────────────────────────────────────────────────

/**
 * Outcome of {@link provisionWorktree}.
 *
 * - `ok: true` — the worktree was created and is ready to commit into.
 *   `remoteHasBranch` indicates whether `origin/<branch>` already existed
 *   so the caller can decide between "open new PR" vs "update existing".
 * - `ok: false` — provisioning aborted; `error` carries a LAFS-compatible
 *   envelope (e.g. `E_BRANCH_COLLISION`, `E_WORKTREE_ADD_FAILED`).
 */
export type ProvisionResult =
  | { ok: true; remoteHasBranch: boolean }
  | { ok: false; error: PublishPrError };

/**
 * Provision a fresh temp worktree on branch `docs/<slug>`.
 *
 * Branch handling:
 *   - When `origin/<branch>` exists, the worktree tracks it.
 *   - Otherwise the branch is cut from `origin/<base>`.
 *   - A local-only `docs/<slug>` branch that doesn't match the remote
 *     aborts with `E_BRANCH_COLLISION` so we never force-push over an
 *     unrelated branch.
 *
 * The caller is responsible for {@link teardownPublishPrWorktree}-ing the
 * dir in a `finally` block — this function never auto-cleans on success.
 *
 * Named with the `publishPr` prefix to avoid clashing with the SDK-level
 * worktree dispatcher.
 */
export async function provisionPublishPrWorktree(opts: {
  projectRoot: string;
  worktreeDir: string;
  branch: string;
  base: string;
  runGit: (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}): Promise<ProvisionResult> {
  const { projectRoot, worktreeDir, branch, base, runGit } = opts;

  // Ensure we have an up-to-date view of origin so branch-existence checks
  // are accurate. `--prune` keeps stale branches from causing false hits.
  try {
    await runGit(['fetch', '--prune', 'origin'], projectRoot);
  } catch (e) {
    return {
      ok: false,
      error: publishPrError(
        'E_NETWORK',
        `git fetch origin failed: ${execMsg(e)}`,
        'Check network connectivity (git remote -v) and retry.',
        ['Run `git fetch origin` manually to confirm.'],
      ),
    };
  }

  // Probe remote branch existence.
  let remoteHasBranch = false;
  try {
    const { stdout } = await runGit(['ls-remote', '--heads', 'origin', branch], projectRoot);
    remoteHasBranch = stdout.trim().length > 0;
  } catch {
    remoteHasBranch = false;
  }

  // Probe local branch.
  let localHasBranch = false;
  try {
    await runGit(['rev-parse', '--verify', `refs/heads/${branch}`], projectRoot);
    localHasBranch = true;
  } catch {
    localHasBranch = false;
  }

  // Collision check: local-only branch that doesn't match origin's tip.
  if (localHasBranch && remoteHasBranch) {
    try {
      const localSha = (
        await runGit(['rev-parse', `refs/heads/${branch}`], projectRoot)
      ).stdout.trim();
      const remoteSha = (
        await runGit(['rev-parse', `refs/remotes/origin/${branch}`], projectRoot)
      ).stdout.trim();
      if (localSha !== remoteSha) {
        return {
          ok: false,
          error: publishPrError(
            'E_BRANCH_COLLISION',
            `local branch '${branch}' diverges from origin/${branch}`,
            `Reset or delete the local branch: git branch -D ${branch}`,
            [
              `git fetch origin ${branch}`,
              `git checkout ${branch} && git reset --hard origin/${branch}`,
            ],
            { localSha, remoteSha },
          ),
        };
      }
    } catch {
      // If the comparison fails we fall through; the worktree add below
      // will surface any real error.
    }
  } else if (localHasBranch && !remoteHasBranch) {
    // Local-only branch with no upstream — refuse rather than risk
    // overwriting unrelated work.
    return {
      ok: false,
      error: publishPrError(
        'E_BRANCH_COLLISION',
        `local branch '${branch}' exists but has no matching origin branch`,
        `Delete the local branch first: git branch -D ${branch}`,
        [
          'Pick a different slug so the branch name does not collide.',
          `git branch -m ${branch} ${branch}-archive`,
        ],
      ),
    };
  }

  // Provision the worktree on the appropriate ref.
  try {
    if (remoteHasBranch) {
      await runGit(['worktree', 'add', '-B', branch, worktreeDir, `origin/${branch}`], projectRoot);
    } else {
      await runGit(['worktree', 'add', '-B', branch, worktreeDir, `origin/${base}`], projectRoot);
    }
  } catch (e) {
    return {
      ok: false,
      error: publishPrError(
        'E_WORKTREE_ADD_FAILED',
        `git worktree add failed: ${execMsg(e)}`,
        'Ensure the repository is a valid git working tree and the base branch exists on origin.',
      ),
    };
  }

  return { ok: true, remoteHasBranch };
}

/**
 * Tear a publish-pr temp worktree down. Best-effort — failures are
 * swallowed so the surrounding `finally` never masks the underlying error.
 *
 * Named with the `publishPr` prefix to avoid clashing with the SDK-level
 * `teardownWorktree` exported by `sentient/worktree-dispatch.ts`.
 */
export async function teardownPublishPrWorktree(opts: {
  projectRoot: string;
  worktreeDir: string;
  runGit: (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}): Promise<void> {
  const { projectRoot, worktreeDir, runGit } = opts;
  try {
    await runGit(['worktree', 'remove', '--force', worktreeDir], projectRoot);
  } catch {
    // Worktree removal may fail if the dir was already cleaned up — fall
    // through to fs cleanup.
  }
  try {
    await rm(worktreeDir, { recursive: true, force: true });
  } catch {
    /* never fail teardown */
  }
}
