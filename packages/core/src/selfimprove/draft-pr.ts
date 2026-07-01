/**
 * Draft-PR egress for the self-improvement loop (T11889 · T11889-C).
 *
 * On a detected regression the loop's ONLY outbound action is to open ONE DRAFT
 * PR against the cleocode repo (ADR-065 — PRs target `main` via the Merge Queue;
 * NEVER a direct push to `main`, NEVER an auto-merge, NEVER a publish). This module
 * is the egress primitive, modeled on `propose-patch.ts` (the closest "agent
 * proposes a fix PR" exemplar) with four self-dogfooding hardenings:
 *
 *   1. **`--draft` is ALWAYS appended** to `gh pr create` — the PR is never
 *      ready-for-merge; a human reviews and undrafts it.
 *   2. **Dry-run is the DEFAULT.** `openDraftPr` returns the planned `steps[]`
 *      WITHOUT invoking git/gh unless `execute: true` is passed. So the loop is
 *      side-effect-free at egress by default.
 *   3. **Branch `feat/T11889-selfimprove-<scenario>-<ts>`** — a feature branch
 *      (ADR-065); no main mutation path exists in this module.
 *   4. **Workspace isolation (T12007).** The patch is applied inside an
 *      *ephemeral transient worktree* cut fresh off `origin/main` — NEVER the
 *      invoking checkout — and ONLY the paths the patch names are staged
 *      (`git add -- <paths>`, never `git add -A`). This closes a P1 data-safety
 *      defect where the egress swept the orchestrator's entire dirty working
 *      tree (untracked owner scratch notes, uncommitted edits) into the public
 *      branch and deleted them locally. The invoking repo is never mutated.
 *
 * The live path wraps the git/gh shell-out in
 * {@link "../sentient/skill-provenance.js".withProvenance}`('pr-generator', …)`
 * (the established legal PR-cutting origin — the `SkillWriteOrigin` union is
 * closed) and returns the `gh`-emitted PR URL so the caller can record it back
 * into `selfimprove_dhq.pr_url` via the leased adapter.
 *
 * This module is import-time side-effect-free.
 *
 * @module @cleocode/core/selfimprove/draft-pr
 * @epic T11889
 * @task T11913
 * @task T12007
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { addTransientWorktree, removeTransientWorktree } from '@cleocode/worktree';
import { withProvenance } from '../sentient/skill-provenance.js';

/**
 * The required Claude Code trailer every self-improvement PR body ends with.
 * Matches the project PR-body convention.
 */
const PR_BODY_TRAILER =
  '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' as const;

/**
 * Pluggable command runner. Returns stdout as UTF-8 text or throws on non-zero
 * exit. Production default wraps `child_process.execFileSync` with piped stdio.
 *
 * The optional `cwd` is REQUIRED for workspace isolation (T12007): every git
 * mutation runs inside the ephemeral worktree, never `process.cwd()` (which
 * would be the invoking checkout). The default runner threads it into
 * `execFileSync`; test doubles capture it to assert the isolation boundary.
 */
export type CommandRunner = (file: string, args: readonly string[], cwd?: string) => string;

/** Default command runner — wraps `execFileSync` with stdout-piped semantics. */
const defaultRun: CommandRunner = (file, args, cwd) =>
  execFileSync(file, [...args], { cwd, stdio: 'pipe' }).toString('utf8');

/**
 * Provision arguments for the isolated worktree hook (T12007).
 *
 * @see {@link WorktreeProvisioner}
 */
export interface ProvisionWorktreeArgs {
  /** Absolute invoking project root the worktree is registered against. */
  readonly projectRoot: string;
  /** Absolute path where the ephemeral worktree directory is created (tmpdir). */
  readonly worktreePath: string;
  /** The feature branch created inside the worktree. */
  readonly branch: string;
  /** The base ref the worktree (and its branch) is cut from — `origin/main`. */
  readonly baseRef: string;
}

/**
 * Inject hook that provisions the ephemeral isolation worktree. Production
 * leaves it undefined and the module routes through `@cleocode/worktree`'s
 * `addTransientWorktree` (the sanctioned escape hatch for tmpdir worktrees —
 * keeps the raw `git worktree` shell-out out of `packages/core/` per the
 * T9984 lint gate). Tests inject a double to avoid a real git remote.
 */
export type WorktreeProvisioner = (args: ProvisionWorktreeArgs) => Promise<void> | void;

/**
 * Inject hook that removes the ephemeral isolation worktree. Production leaves
 * it undefined and the module routes through `@cleocode/worktree`'s
 * `removeTransientWorktree`.
 */
export type WorktreeRemover = (projectRoot: string, worktreePath: string) => Promise<void> | void;

/** Failure codes from {@link openDraftPr}. */
export type DraftPrErrorCode =
  /** Patch file does not exist on disk. */
  | 'E_NOT_FOUND'
  /** Patch file exists but is empty (or names no files). */
  | 'E_PATCH_EMPTY'
  /** `gh` CLI missing / not authenticated. */
  | 'E_GH_UNAVAILABLE'
  /** Shell-out failure during the live PR cut (incl. worktree provisioning). */
  | 'E_DRAFT_PR_FAILED';

/** Args for {@link openDraftPr}. */
export interface OpenDraftPrArgs {
  /** The scenario name whose regression this PR addresses (branch slug). */
  readonly scenario: string;
  /** Path to a unified-diff file with the proposed fix. Resolved against {@link cwd}. */
  readonly diffPath: string;
  /** PR title. */
  readonly title: string;
  /** PR body markdown (the trailer is appended automatically). */
  readonly body: string;
  /**
   * When `true`, actually cut the branch + open the draft PR. DEFAULT `false`
   * (dry-run) — the loop is side-effect-free at egress unless `--execute` flows
   * through to here.
   *
   * @defaultValue false
   */
  readonly execute?: boolean;
  /**
   * The INVOKING checkout / project root. Used to (a) resolve {@link diffPath}
   * and (b) register the ephemeral worktree against — it is NEVER mutated
   * (T12007). Defaults to {@link process.cwd}.
   */
  readonly cwd?: string;
  /** Injectable command runner (tests capture the shell-out). Defaults to {@link execFileSync}. */
  readonly run?: CommandRunner;
  /** Injectable timestamp source for the branch suffix (tests pin it). Defaults to now. */
  readonly timestamp?: () => string;
  /**
   * Explicit path for the ephemeral isolation worktree (T12007). Defaults to a
   * unique `os.tmpdir()` directory. Overridable for deterministic tests.
   */
  readonly worktreeDir?: string;
  /** Injectable worktree provisioner (tests avoid a real remote). Defaults to `addTransientWorktree`. */
  readonly provisionWorktree?: WorktreeProvisioner;
  /** Injectable worktree remover. Defaults to `removeTransientWorktree`. */
  readonly removeWorktree?: WorktreeRemover;
}

/** Dry-run result — the planned steps, no side effects. */
export interface DraftPrDryRun {
  readonly kind: 'dry-run';
  readonly scenario: string;
  readonly branchName: string;
  /** The planned shell steps; the `gh pr create` step includes `--draft`. */
  readonly steps: readonly string[];
  /** The repo-relative paths the patch touches — the ONLY paths that will be staged. */
  readonly patchPaths: readonly string[];
}

/** Live result — the opened draft PR. */
export interface DraftPrOk {
  readonly kind: 'ok';
  readonly scenario: string;
  readonly branchName: string;
  /** The draft PR URL emitted by `gh pr create --draft`. */
  readonly prUrl: string;
  /** The repo-relative paths the patch touched (the PR's complete file set). */
  readonly patchPaths: readonly string[];
}

/** Failure result. */
export interface DraftPrFailure {
  readonly kind: 'error';
  readonly code: DraftPrErrorCode;
  readonly message: string;
}

/** Discriminated-union result of {@link openDraftPr}. */
export type DraftPrResult = DraftPrDryRun | DraftPrOk | DraftPrFailure;

/**
 * Sanitize a scenario name into a filesystem/ref-safe stem.
 *
 * @internal
 */
function safeStem(scenario: string): string {
  return scenario.replace(/[^a-z0-9-]/gi, '-');
}

/**
 * Compute the feature branch name for a scenario's draft PR (ADR-065 feature
 * branch — `feat/T11889-selfimprove-<scenario>-<ts>`). The timestamp is
 * colon/dot-sanitized so it is a valid git ref.
 *
 * @param scenario - The scenario name.
 * @param ts - The ISO timestamp string.
 * @returns The branch name.
 */
export function draftPrBranchName(scenario: string, ts: string): string {
  const safeScenario = safeStem(scenario);
  const safeTs = ts.replace(/[:.]/g, '-');
  return `feat/T11889-selfimprove-${safeScenario}-${safeTs}`;
}

/**
 * Extract the set of repo-relative paths a unified diff touches — the SSoT for
 * "which paths may be staged" (T12007).
 *
 * Parses the `diff --git a/<old> b/<new>` header (the authoritative per-file
 * boundary in a git-format diff), collecting BOTH the pre-image (`a/`) and
 * post-image (`b/`) paths so renames stage their old path too and deletions
 * stage the removed path. `/dev/null` sentinels (pure add / pure delete) are
 * skipped. Also parses bare `--- ` / `+++ ` headers as a fallback for
 * non-`diff --git` unified diffs. The result is de-duplicated and stable
 * ordered by first appearance.
 *
 * The egress stages ONLY these paths (`git add -- <paths>`), so the isolated
 * worktree can never sweep anything the patch did not name.
 *
 * @param diffText - The unified-diff text.
 * @returns The de-duplicated repo-relative paths the diff touches.
 */
export function parseUnifiedDiffPaths(diffText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string): void => {
    // Strip surrounding double-quotes git adds for paths with special chars,
    // then drop a leading `a/` or `b/` prefix and any trailing tab-timestamp.
    let p = raw.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
    p = p.replace(/\t.*$/, '');
    if (p === '/dev/null' || p.length === 0) return;
    const rel = p.replace(/^[ab]\//, '');
    if (rel.length === 0 || rel === '/dev/null' || seen.has(rel)) return;
    seen.add(rel);
    paths.push(rel);
  };

  for (const line of diffText.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    const gitHeader = /^diff --git (\S+) (\S+)\s*$/.exec(trimmed);
    if (gitHeader) {
      push(gitHeader[1]);
      push(gitHeader[2]);
      continue;
    }
    const minus = /^--- (.+)$/.exec(trimmed);
    if (minus) {
      push(minus[1]);
      continue;
    }
    const plus = /^\+\+\+ (.+)$/.exec(trimmed);
    if (plus) push(plus[1]);
  }
  return paths;
}

/**
 * Build a unique ephemeral worktree path under `os.tmpdir()` for a scenario.
 * The random suffix keeps concurrent self-improve runs from colliding.
 *
 * @internal
 */
function tempWorktreeDir(scenario: string): string {
  return join(tmpdir(), `cleo-selfimprove-${safeStem(scenario)}-${randomBytes(4).toString('hex')}`);
}

/**
 * Open ONE DRAFT PR carrying a proposed self-improvement fix.
 *
 * DRY-RUN by default ({@link OpenDraftPrArgs.execute} falsey): returns the planned
 * `steps[]` (the `gh pr create` step ALWAYS carries `--draft`) WITHOUT touching
 * git/gh — so the loop is egress-side-effect-free unless `--execute` is threaded
 * through.
 *
 * The live path (`execute: true`) never mutates the invoking checkout (T12007).
 * It cuts an EPHEMERAL transient worktree fresh off `origin/main`, applies the
 * diff there, stages ONLY the paths the patch names (`git add -- <paths>` — NEVER
 * `git add -A`), commits, pushes the FEATURE branch (NEVER `main`), runs
 * `gh pr create --base main --head <branch> --draft`, and tears the worktree
 * down in a `finally`. The orchestrator's untracked/uncommitted files are never
 * staged, pushed, or deleted.
 *
 * NEVER pushes `main`, NEVER auto-merges, NEVER publishes — the only egress is a
 * draft PR against a feature branch.
 *
 * @param args - See {@link OpenDraftPrArgs}.
 * @returns A {@link DraftPrResult} describing the outcome.
 *
 * @example
 * ```ts
 * // dry-run (default): no side effects, steps include `--draft`
 * const plan = await openDraftPr({ scenario: 'x', diffPath: 'fix.patch', title, body });
 * // live: cuts an isolated worktree + opens draft PR (invoking repo untouched)
 * const res = await openDraftPr({ scenario: 'x', diffPath: 'fix.patch', title, body, execute: true });
 * ```
 */
export async function openDraftPr(args: OpenDraftPrArgs): Promise<DraftPrResult> {
  const cwd = args.cwd ?? processCwd();
  const run = args.run ?? defaultRun;
  const execute = args.execute === true;
  const isoNow = (args.timestamp ?? (() => new Date().toISOString()))();
  const base = 'main';
  const body = `${args.body}${PR_BODY_TRAILER}`;

  const resolvedDiff = resolvePath(cwd, args.diffPath);
  if (!existsSync(resolvedDiff)) {
    return {
      kind: 'error',
      code: 'E_NOT_FOUND',
      message: `Patch file not found at '${resolvedDiff}'`,
    };
  }
  const diffBytes = readFileSync(resolvedDiff, 'utf8');
  if (diffBytes.length === 0) {
    return {
      kind: 'error',
      code: 'E_PATCH_EMPTY',
      message: `Patch file '${resolvedDiff}' is empty`,
    };
  }

  // The authoritative "what may be staged" set. A patch that names no files is
  // treated as empty — staging nothing would produce an empty PR.
  const patchPaths = parseUnifiedDiffPaths(diffBytes);
  if (patchPaths.length === 0) {
    return {
      kind: 'error',
      code: 'E_PATCH_EMPTY',
      message: `Patch file '${resolvedDiff}' names no files (no unified-diff headers)`,
    };
  }

  if (execute) {
    try {
      run('gh', ['--version']);
    } catch {
      return {
        kind: 'error',
        code: 'E_GH_UNAVAILABLE',
        message: 'gh CLI not found or not authenticated — install gh and run `gh auth login`',
      };
    }
  }

  const branchName = draftPrBranchName(args.scenario, isoNow);
  const worktreePath = args.worktreeDir ?? tempWorktreeDir(args.scenario);

  // Planned steps reflect the ISOLATED flow: every git mutation runs inside the
  // ephemeral worktree (`<worktree>`), and staging is scoped to the patch paths.
  const steps: readonly string[] = [
    `git fetch origin ${base}`,
    `# provision ephemeral worktree at ${worktreePath} off origin/${base} (via @cleocode/worktree)`,
    `git -C <worktree> apply ${resolvedDiff}`,
    `git -C <worktree> add -- ${patchPaths.join(' ')}`,
    `git -C <worktree> commit -m "fix(selfimprove): ${args.scenario} regression"`,
    `git -C <worktree> push -u origin ${branchName}`,
    `gh pr create --base ${base} --head ${branchName} --draft --title "${args.title}" --body <stdin>`,
    '# remove ephemeral worktree (finally)',
  ];

  if (!execute) {
    return { kind: 'dry-run', scenario: args.scenario, branchName, steps, patchPaths };
  }

  const provision: WorktreeProvisioner =
    args.provisionWorktree ??
    ((o) =>
      addTransientWorktree({
        projectRoot: o.projectRoot,
        worktreePath: o.worktreePath,
        branch: o.branch,
        baseRef: o.baseRef,
        resetBranch: true,
      }));
  const teardown: WorktreeRemover =
    args.removeWorktree ?? ((projectRoot, p) => removeTransientWorktree(projectRoot, p));

  try {
    // Freshen origin/<base> so the isolated worktree branches off the true tip.
    run('git', ['fetch', 'origin', base], cwd);

    // Provision the ephemeral worktree OFF origin/<base> — NEVER the invoking
    // tree. All subsequent git mutations target `worktreePath`.
    await provision({
      projectRoot: cwd,
      worktreePath,
      branch: branchName,
      baseRef: `origin/${base}`,
    });

    const prUrl = await withProvenance('pr-generator', async () => {
      // Apply the patch INSIDE the isolated worktree (its working tree only).
      run('git', ['apply', resolvedDiff], worktreePath);
      // Stage ONLY the paths the patch names — never `git add -A`, never the
      // invoking checkout. This is the crux of the T12007 fix.
      run('git', ['add', '--', ...patchPaths], worktreePath);
      run('git', ['commit', '-m', `fix(selfimprove): ${args.scenario} regression`], worktreePath);
      run('git', ['push', '-u', 'origin', branchName], worktreePath);
      return run(
        'gh',
        [
          'pr',
          'create',
          '--base',
          base,
          '--head',
          branchName,
          '--draft',
          '--title',
          args.title,
          '--body',
          body,
        ],
        worktreePath,
      ).trim();
    });
    return { kind: 'ok', scenario: args.scenario, branchName, prUrl, patchPaths };
  } catch (err) {
    return {
      kind: 'error',
      code: 'E_DRAFT_PR_FAILED',
      message: `draft-pr failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Best-effort teardown — the invoking checkout is never touched, only the
    // ephemeral worktree registration + its tmpdir directory.
    try {
      await teardown(cwd, worktreePath);
    } catch {
      /* best-effort */
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
