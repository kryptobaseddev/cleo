/**
 * Draft-PR egress for the self-improvement loop (T11889 · T11889-C).
 *
 * On a detected regression the loop's ONLY outbound action is to open ONE DRAFT
 * PR against the cleocode repo (ADR-065 — PRs target `main` via the Merge Queue;
 * NEVER a direct push to `main`, NEVER an auto-merge, NEVER a publish). This module
 * is the egress primitive, modeled on `propose-patch.ts` (the closest "agent
 * proposes a fix PR" exemplar) with three self-dogfooding hardenings:
 *
 *   1. **`--draft` is ALWAYS appended** to `gh pr create` — the PR is never
 *      ready-for-merge; a human reviews and undrafts it.
 *   2. **Dry-run is the DEFAULT.** `openDraftPr` returns the planned `steps[]`
 *      WITHOUT invoking git/gh unless `execute: true` is passed. So the loop is
 *      side-effect-free at egress by default.
 *   3. **Branch `feat/T11889-selfimprove-<scenario>-<ts>`** — a feature branch
 *      (ADR-065); no main mutation path exists in this module.
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
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { cwd as processCwd } from 'node:process';
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
 */
export type CommandRunner = (file: string, args: readonly string[]) => string;

/** Default command runner — wraps `execFileSync` with stdout-piped semantics. */
const defaultRun: CommandRunner = (file, args) =>
  execFileSync(file, [...args], { stdio: 'pipe' }).toString('utf8');

/** Failure codes from {@link openDraftPr}. */
export type DraftPrErrorCode =
  /** Patch file does not exist on disk. */
  | 'E_NOT_FOUND'
  /** Patch file exists but is empty. */
  | 'E_PATCH_EMPTY'
  /** `gh` CLI missing / not authenticated. */
  | 'E_GH_UNAVAILABLE'
  /** Shell-out failure during the live PR cut. */
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
  /** Working directory for path resolution + git ops. Defaults to {@link process.cwd}. */
  readonly cwd?: string;
  /** Injectable command runner (tests capture the shell-out). Defaults to {@link execFileSync}. */
  readonly run?: CommandRunner;
  /** Injectable timestamp source for the branch suffix (tests pin it). Defaults to now. */
  readonly timestamp?: () => string;
}

/** Dry-run result — the planned steps, no side effects. */
export interface DraftPrDryRun {
  readonly kind: 'dry-run';
  readonly scenario: string;
  readonly branchName: string;
  /** The planned shell steps; the `gh pr create` step includes `--draft`. */
  readonly steps: readonly string[];
}

/** Live result — the opened draft PR. */
export interface DraftPrOk {
  readonly kind: 'ok';
  readonly scenario: string;
  readonly branchName: string;
  /** The draft PR URL emitted by `gh pr create --draft`. */
  readonly prUrl: string;
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
 * Compute the feature branch name for a scenario's draft PR (ADR-065 feature
 * branch — `feat/T11889-selfimprove-<scenario>-<ts>`). The timestamp is
 * colon/dot-sanitized so it is a valid git ref.
 *
 * @param scenario - The scenario name.
 * @param ts - The ISO timestamp string.
 * @returns The branch name.
 */
export function draftPrBranchName(scenario: string, ts: string): string {
  const safeScenario = scenario.replace(/[^a-z0-9-]/gi, '-');
  const safeTs = ts.replace(/[:.]/g, '-');
  return `feat/T11889-selfimprove-${safeScenario}-${safeTs}`;
}

/**
 * Open ONE DRAFT PR carrying a proposed self-improvement fix.
 *
 * DRY-RUN by default ({@link OpenDraftPrArgs.execute} falsey): returns the planned
 * `steps[]` (the `gh pr create` step ALWAYS carries `--draft`) WITHOUT touching
 * git/gh — so the loop is egress-side-effect-free unless `--execute` is threaded
 * through. The live path (`execute: true`) cuts the feature branch, applies the
 * diff, commits, pushes the FEATURE branch (NEVER `main`), and runs
 * `gh pr create --base main --head <branch> --draft`, returning the PR URL.
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
 * // live: cuts branch + opens draft PR
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
  const steps: readonly string[] = [
    `git checkout -b ${branchName}`,
    `git apply ${resolvedDiff}`,
    'git add -A',
    `git commit -m "fix(selfimprove): ${args.scenario} regression"`,
    `git push -u origin ${branchName}`,
    `gh pr create --base ${base} --head ${branchName} --draft --title "${args.title}" --body <stdin>`,
  ];

  if (!execute) {
    return { kind: 'dry-run', scenario: args.scenario, branchName, steps };
  }

  try {
    const prUrl = await withProvenance('pr-generator', () => {
      run('git', ['checkout', '-b', branchName]);
      run('git', ['apply', resolvedDiff]);
      run('git', ['add', '-A']);
      run('git', ['commit', '-m', `fix(selfimprove): ${args.scenario} regression`]);
      run('git', ['push', '-u', 'origin', branchName]);
      return run('gh', [
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
      ]).trim();
    });
    return { kind: 'ok', scenario: args.scenario, branchName, prUrl };
  } catch (err) {
    return {
      kind: 'error',
      code: 'E_DRAFT_PR_FAILED',
      message: `draft-pr failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
