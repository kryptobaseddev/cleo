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

// ─── T9718 — new-doc publish flow with frontmatter ───────────────────────────

/**
 * Input options for {@link publishDocsAsPr}.
 *
 * @task T9718 / T9644
 */
export interface PublishPrOptions {
  /**
   * The slug-or-id of the doc to publish. Resolution mirrors `cleo docs
   * fetch`: slug → attachment id → sha256.
   */
  readonly slugOrId: string;
  /** Optional PR title override. Default: `"docs(<type>): publish <slug>"`. */
  readonly title?: string;
  /** Optional PR body override. Default: a short auto-generated body. */
  readonly body?: string;
  /** Base branch for the PR. Default: `"main"`. */
  readonly base?: string;
  /** Project root override (mostly for tests). Defaults to `getProjectRoot()`. */
  readonly projectRoot?: string;
  /**
   * Optional slug override when `slugOrId` is itself a non-slug identifier
   * (e.g. attachment id or sha256). Validated against {@link validatePublishSlug}.
   */
  readonly slug?: string;
  /**
   * Optional type override. When the stored attachment carries no `type`
   * column the caller can pin one — bypassing the `docs/note/` default.
   */
  readonly type?: string;
  /** Test-only runner overrides for `git` and `gh`. */
  readonly runners?: PublishPrRunners;
}

/**
 * Success payload returned by {@link publishDocsAsPr}.
 *
 * @task T9718 / T9717
 */
export interface PublishPrSuccess {
  readonly action: 'new' | 'updated';
  readonly prUrl: string;
  readonly branch: string;
  readonly commitSha: string;
  /** The PR head sha BEFORE the update (only set when `action === 'updated'`). */
  readonly priorSha?: string;
  /** The published file path inside the worktree, project-root-relative. */
  readonly filePath: string;
  /** The slug under which the doc was published. */
  readonly slug: string;
  /** The doc type recorded in frontmatter (e.g. `spec`, `adr`, `note`). */
  readonly type: string;
  /** Lowercase hex sha256 of the stored blob bytes (pre-frontmatter). */
  readonly blobSha: string;
}

/** Result envelope returned by {@link publishDocsAsPr}. */
export type PublishPrResult =
  | { readonly success: true; readonly data: PublishPrSuccess }
  | { readonly success: false; readonly error: PublishPrError };

/**
 * Strip an existing leading `---\n…\n---\n` block from `text` so we never
 * double-stack frontmatter when the stored doc already carries one.
 * Idempotent on docs without frontmatter.
 *
 * @internal
 */
export function stripExistingFrontmatter(text: string): string {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text;
  const closer = text.indexOf('\n---', 3);
  if (closer < 0) return text;
  const after = text.indexOf('\n', closer + 4);
  if (after < 0) return text;
  return text.slice(after + 1);
}

/** Build the YAML frontmatter block prepended to published markdown. */
export function buildPublishFrontmatter(opts: {
  slug: string;
  type: string;
  blobSha: string;
  createdAt: string;
}): string {
  return [
    '---',
    `slug: ${opts.slug}`,
    `type: ${opts.type}`,
    `blobSha: ${opts.blobSha}`,
    `createdAt: ${opts.createdAt}`,
    '---',
    '',
  ].join('\n');
}

/** Default PR body emitted when the caller doesn't supply one. */
export function defaultPublishPrBody(opts: {
  slug: string;
  type: string;
  blobSha: string;
}): string {
  return [
    'Auto-published by `cleo docs publish-pr`.',
    '',
    `- **slug**: \`${opts.slug}\``,
    `- **type**: \`${opts.type}\``,
    `- **blobSha**: \`${opts.blobSha}\``,
    '',
    `Re-run \`cleo docs publish-pr ${opts.slug}\` to push the latest blob to this PR.`,
  ].join('\n');
}

/**
 * Parse the PR URL out of `gh pr create`'s stdout.
 *
 * `gh` prints the URL on its own line; we pick the first line that looks
 * like a github.com pull URL.
 *
 * @internal
 */
export function parseGhPrUrl(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^https?:\/\/github\.com\/.+\/pull\/\d+/.test(trimmed)) return trimmed;
  }
  const trimmed = stdout.trim();
  if (/^https?:\/\/github\.com\/.+\/pull\/\d+/.test(trimmed)) return trimmed;
  throw new Error(`could not parse PR url from gh output: ${stdout}`);
}

/**
 * Resolve `slugOrId` to attachment bytes + metadata.
 *
 * Resolution order mirrors `docs.fetch`:
 *   1. Slug (kebab-case, not pure hex) → `findBySlug`
 *   2. Attachment id (`att_*` / UUID) → `getMetadata` + bytes
 *   3. Full sha256 (64 hex) → `get(sha)`
 *
 * @internal
 */
async function resolveDocBytes(
  slugOrId: string,
  projectRoot: string,
): Promise<{
  bytes: Buffer;
  slug: string | null;
  type: string | null;
} | null> {
  // Lazy import to keep the foundation tree-shake friendly.
  const { createAttachmentStore } = await import('../store/attachment-store.js');
  const store = createAttachmentStore();

  if (SLUG_PATTERN.test(slugOrId) && !/^[0-9a-f]+$/i.test(slugOrId)) {
    const bySlug = await store.findBySlug(slugOrId, projectRoot).catch(() => null);
    if (bySlug) {
      const fetched = await store.get(bySlug.metadata.sha256, projectRoot);
      if (fetched) {
        return { bytes: fetched.bytes, slug: bySlug.slug, type: bySlug.type };
      }
    }
  }

  if (/^(att_|[0-9a-f]{8}-)/i.test(slugOrId)) {
    const meta = await store.getMetadata(slugOrId, projectRoot).catch(() => null);
    if (meta) {
      const fetched = await store.get(meta.sha256, projectRoot);
      if (fetched) {
        const extras = await store.getExtras(meta.id, projectRoot).catch(() => null);
        return {
          bytes: fetched.bytes,
          slug: extras?.slug ?? null,
          type: extras?.type ?? null,
        };
      }
    }
  }

  if (/^[0-9a-f]{64}$/i.test(slugOrId)) {
    const fetched = await store.get(slugOrId, projectRoot);
    if (fetched) {
      const extras = await store.getExtras(fetched.metadata.id, projectRoot).catch(() => null);
      return {
        bytes: fetched.bytes,
        slug: extras?.slug ?? null,
        type: extras?.type ?? null,
      };
    }
  }

  return null;
}

/**
 * Publish the doc identified by `slugOrId` to a new PR.
 *
 * Flow (T9718):
 *   1. Resolve the doc → bytes + (optional) stored slug/type.
 *   2. Validate the resolved slug; pick the publish dir from the doc type.
 *   3. Pre-flight `gh auth status` so authentication failures surface
 *      before any side effects.
 *   4. Provision a temp worktree on `docs/<slug>`.
 *   5. Write `docs/<type>/<slug>.md` with YAML frontmatter, commit, push.
 *   6. Open the PR via `gh pr create`.
 *   7. Tear the worktree down in `finally`.
 *
 * This implementation only handles the "open new PR" path. Update-PR
 * detection (force-push existing branch + `gh pr edit`) lands in T9717.
 *
 * @task T9718 / T9644
 */
export async function publishDocsAsPr(opts: PublishPrOptions): Promise<PublishPrResult> {
  const { getProjectRoot } = await import('../paths.js');
  const { createHash } = await import('node:crypto');
  const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import('node:fs/promises');
  const { dirname: dirnameSync, resolve: resolveAbs } = await import('node:path');

  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const base = opts.base ?? 'main';
  const runGit = pickRunner('git', opts.runners);
  const runGh = pickRunner('gh', opts.runners);

  // 1. Resolve doc bytes + stored slug/type hints.
  const resolved = await resolveDocBytes(opts.slugOrId, projectRoot);
  if (!resolved) {
    return {
      success: false,
      error: publishPrError(
        'E_DOC_NOT_FOUND',
        `no attachment found for '${opts.slugOrId}'`,
        'Run `cleo docs list --project` to find a valid slug or attachment id.',
      ),
    };
  }

  // 2. Resolve the publish slug.
  const slugSource = opts.slug ?? resolved.slug ?? opts.slugOrId;
  const slugCheck = validatePublishSlug(slugSource);
  if (!slugCheck.ok) {
    return {
      success: false,
      error: publishPrError(
        'E_INVALID_SLUG',
        slugCheck.reason,
        'Pass --slug <kebab-case> when the attachment was not stored with a slug.',
      ),
    };
  }
  const slug = slugCheck.slug;

  // 3. Resolve the publish type/dir.
  const type =
    opts.type && KNOWN_DOC_TYPES.has(opts.type)
      ? opts.type
      : resolved.type && KNOWN_DOC_TYPES.has(resolved.type)
        ? resolved.type
        : 'note';
  const publishDir = publishDirForType(type);
  const branch = branchForSlug(slug);

  // 4. Pre-flight gh auth so we fail early before any side effects.
  try {
    await runGh(['auth', 'status'], projectRoot);
  } catch (e) {
    return {
      success: false,
      error: publishPrError(
        'E_NO_GH_AUTH',
        `gh CLI not authenticated: ${execMsg(e)}`,
        'Run `gh auth login` and retry.',
      ),
    };
  }

  const worktreeDir = tempWorktreeDirForSlug(slug);
  const relPath = `${publishDir}/${slug}.md`;

  const prov = await provisionPublishPrWorktree({
    projectRoot,
    worktreeDir,
    branch,
    base,
    runGit,
  });
  if (!prov.ok) {
    await teardownPublishPrWorktree({ projectRoot, worktreeDir, runGit }).catch(() => undefined);
    return { success: false, error: prov.error };
  }

  try {
    // 5. Compute frontmatter + content + write the file.
    const blobSha = createHash('sha256').update(resolved.bytes).digest('hex');
    const frontmatter = buildPublishFrontmatter({
      slug,
      type,
      blobSha,
      createdAt: new Date().toISOString(),
    });
    const rawContent = resolved.bytes.toString('utf-8');
    const body = stripExistingFrontmatter(rawContent);
    const fileContent = `${frontmatter}${body}`;

    const fileAbs = resolveAbs(worktreeDir, relPath);
    await mkdirAsync(dirnameSync(fileAbs), { recursive: true });
    await writeFileAsync(fileAbs, fileContent, 'utf-8');

    // 6. Stage + commit. Allow-empty so a re-publish of identical bytes
    //    still advances the PR head sha (idempotent publish, fresh commit).
    await runGit(['add', '--', relPath], worktreeDir);

    let treeDirty = true;
    try {
      await runGit(['diff', '--cached', '--quiet'], worktreeDir);
      // exit 0 means no diff
      treeDirty = false;
    } catch {
      treeDirty = true;
    }

    const commitMessage =
      `docs(${type}): publish ${slug}\n\n` +
      `slug: ${slug}\n` +
      `type: ${type}\n` +
      `blobSha: ${blobSha}`;
    if (treeDirty) {
      await runGit(['commit', '-m', commitMessage], worktreeDir);
    } else {
      await runGit(['commit', '--allow-empty', '-m', commitMessage], worktreeDir);
    }

    const commitSha = (await runGit(['rev-parse', 'HEAD'], worktreeDir)).stdout.trim();

    // 7. Push (plain push — update flow with `--force-with-lease` is T9717).
    try {
      await runGit(['push', '-u', 'origin', branch], worktreeDir);
    } catch (e) {
      return {
        success: false,
        error: publishPrError(
          'E_NETWORK',
          `git push origin ${branch} failed: ${execMsg(e)}`,
          'Check network connectivity and remote permissions, then retry.',
        ),
      };
    }

    // 8. Open the PR.
    const finalBody = opts.body ?? defaultPublishPrBody({ slug, type, blobSha });
    const finalTitle = opts.title ?? `docs(${type}): publish ${slug}`;

    let prUrl: string;
    try {
      const created = await runGh(
        [
          'pr',
          'create',
          '--base',
          base,
          '--head',
          branch,
          '--title',
          finalTitle,
          '--body',
          finalBody,
        ],
        worktreeDir,
      );
      prUrl = parseGhPrUrl(created.stdout);
    } catch (e) {
      return {
        success: false,
        error: publishPrError(
          'E_PR_CREATE_FAILED',
          `gh pr create failed: ${execMsg(e)}`,
          'Re-run with `gh pr create` manually for a more detailed error message.',
        ),
      };
    }

    return {
      success: true,
      data: {
        action: 'new',
        prUrl,
        branch,
        commitSha,
        filePath: relPath,
        slug,
        type,
        blobSha,
      },
    };
  } finally {
    await teardownPublishPrWorktree({ projectRoot, worktreeDir, runGit }).catch(() => undefined);
  }
}
