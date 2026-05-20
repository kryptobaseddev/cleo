/**
 * `proposeCanonicalPatch()` — open a PR against the cleocode repo carrying a
 * canonical-skill patch.
 *
 * Sphere A canonical skills are owner-CI-only: the write-guard at
 * {@link upsertSkillRow} refuses any mutation unless the active
 * provenance frame is `'pr-generator'`. This helper IS that legal bypass —
 * extracted from the cleo CLI (`cleo skills propose-patch`) so that:
 *
 *   1. The CLI handler shrinks to flag parsing + result rendering.
 *   2. The git/gh shell-out orchestration can be unit-tested in isolation
 *      against an injectable command runner.
 *   3. Other surfaces (e.g. a future daemon or HTTP webhook) can reuse the
 *      same logic without duplicating the shell-out plumbing.
 *
 * ## Flow
 *
 *   1. Validates the supplied diff path is non-empty.
 *   2. Verifies `gh` CLI availability (unless `dryRun=true`).
 *   3. Computes a timestamped branch name `propose-patch/skill-<name>-<ts>`.
 *   4. For dry-run: returns the rendered shell-step list without invoking.
 *   5. For live: cuts the branch, applies the diff, commits, pushes, and
 *      opens the PR — all inside `withProvenance('pr-generator', ...)` so
 *      any incidental `upsertSkillRow` calls from the apply step are
 *      permitted by the T9708 write-guard.
 *
 * The actual rendering of the CLI envelope is the caller's responsibility —
 * this function returns a discriminated-union result describing what
 * happened (or what failed) so the caller can build a LAFS envelope or any
 * other transport-specific surface.
 *
 * @task T9749
 * @epic T9740
 * @saga SG-CLEO-SKILLS
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { withProvenance } from '../sentient/skill-provenance.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Failure codes returned in {@link ProposeCanonicalPatchFailure}.
 *
 * - `E_NOT_FOUND`             — diff file does not exist on disk.
 * - `E_PATCH_EMPTY`           — diff file exists but contains zero bytes.
 * - `E_GH_UNAVAILABLE`        — `gh` CLI missing / not authenticated.
 * - `E_PROPOSE_PATCH_FAILED`  — generic shell-out failure during the PR cut.
 */
export type ProposeCanonicalPatchErrorCode =
  | 'E_NOT_FOUND'
  | 'E_PATCH_EMPTY'
  | 'E_GH_UNAVAILABLE'
  | 'E_PROPOSE_PATCH_FAILED';

/**
 * Args accepted by {@link proposeCanonicalPatch}.
 */
export interface ProposeCanonicalPatchArgs {
  /** Skill identifier (e.g. `ct-orchestrator`). */
  readonly skillName: string;
  /** Path to a unified-diff file. Resolved relative to {@link cwd}. */
  readonly diffPath: string;
  /** Optional PR title. Defaults to `skill(<name>): proposed patch`. */
  readonly title?: string;
  /** Optional PR body markdown. Defaults to an auto-generated stub. */
  readonly body?: string;
  /** Base branch. Defaults to `main`. */
  readonly base?: string;
  /** When `true`, returns the planned steps without invoking git/gh. */
  readonly dryRun?: boolean;
  /**
   * Working directory used to resolve the diff path. Defaults to
   * {@link process.cwd}. Tests inject a tmp dir via this hook.
   */
  readonly cwd?: string;
  /**
   * Injectable command runner — pure helper so tests can capture the
   * shell-out without spawning processes. Defaults to {@link execFileSync}.
   *
   * The runner receives the file (e.g. `git`, `gh`) and arg list. It MUST
   * return stdout as UTF-8 text or throw on non-zero exit.
   */
  readonly run?: CommandRunner;
}

/**
 * Pluggable command runner. Returns stdout as UTF-8 text or throws.
 * Production default wraps `child_process.execFileSync`.
 */
export type CommandRunner = (file: string, args: readonly string[]) => string;

/**
 * Success envelope from {@link proposeCanonicalPatch} in dry-run mode.
 */
export interface ProposeCanonicalPatchDryRun {
  readonly kind: 'dry-run';
  readonly skillName: string;
  readonly diffPath: string;
  readonly branchName: string;
  readonly base: string;
  readonly steps: readonly string[];
}

/**
 * Success envelope from {@link proposeCanonicalPatch} in live mode.
 */
export interface ProposeCanonicalPatchOk {
  readonly kind: 'ok';
  readonly skillName: string;
  readonly branchName: string;
  readonly base: string;
  /** PR URL emitted by `gh pr create`. */
  readonly prUrl: string;
}

/**
 * Failure envelope from {@link proposeCanonicalPatch}.
 */
export interface ProposeCanonicalPatchFailure {
  readonly kind: 'error';
  readonly code: ProposeCanonicalPatchErrorCode;
  readonly message: string;
}

/**
 * Discriminated-union result returned by {@link proposeCanonicalPatch}.
 */
export type ProposeCanonicalPatchResult =
  | ProposeCanonicalPatchDryRun
  | ProposeCanonicalPatchOk
  | ProposeCanonicalPatchFailure;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default body builder — mirrors the historical CLI default. */
function defaultBody(skillName: string, diffPath: string): string {
  return [
    `Auto-improve patch for canonical skill **${skillName}**.`,
    '',
    `Diff source: \`${diffPath}\``,
    '',
    'This PR was opened via `cleo skill propose-patch` (T9714).',
    'Sphere A canonical skills are owner-CI-only — the local',
    'sentient daemon CANNOT mutate them in place; this PR is the',
    'audited path for incorporating a council-approved patch.',
  ].join('\n');
}

/** Default command runner — wraps execFileSync with stdout-piped semantics. */
const defaultRun: CommandRunner = (file, args) =>
  execFileSync(file, [...args], { stdio: 'pipe' }).toString('utf8');

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Open a PR carrying a canonical-skill patch.
 *
 * See module-level docs for the full flow and provenance rationale.
 *
 * @param args - See {@link ProposeCanonicalPatchArgs}.
 * @returns A {@link ProposeCanonicalPatchResult} describing the outcome.
 *
 * @task T9749
 */
export async function proposeCanonicalPatch(
  args: ProposeCanonicalPatchArgs,
): Promise<ProposeCanonicalPatchResult> {
  const cwd = args.cwd ?? processCwd();
  const run = args.run ?? defaultRun;
  const skillName = args.skillName;
  const diffPath = args.diffPath;
  const title =
    typeof args.title === 'string' && args.title.length > 0
      ? args.title
      : `skill(${skillName}): proposed patch`;
  const body =
    typeof args.body === 'string' && args.body.length > 0
      ? args.body
      : defaultBody(skillName, diffPath);
  const base = typeof args.base === 'string' && args.base.length > 0 ? args.base : 'main';
  const dryRun = args.dryRun === true;

  const resolvedDiff = resolvePath(cwd, diffPath);
  if (!existsSync(resolvedDiff)) {
    return {
      kind: 'error',
      code: 'E_NOT_FOUND',
      message: `Diff file not found at '${resolvedDiff}'`,
    };
  }
  const diffBytes = readFileSync(resolvedDiff, 'utf8');
  if (diffBytes.length === 0) {
    return {
      kind: 'error',
      code: 'E_PATCH_EMPTY',
      message: `Diff file '${resolvedDiff}' is empty`,
    };
  }

  if (!dryRun) {
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `propose-patch/skill-${skillName}-${timestamp}`;
  const steps: readonly string[] = [
    `git checkout -b ${branchName}`,
    `git apply ${resolvedDiff}`,
    `git add -A`,
    `git commit -m "skill(${skillName}): propose patch"`,
    `git push -u origin ${branchName}`,
    `gh pr create --base ${base} --head ${branchName} --title "${title}" --body <stdin>`,
  ];

  if (dryRun) {
    return {
      kind: 'dry-run',
      skillName,
      diffPath: resolvedDiff,
      branchName,
      base,
      steps,
    };
  }

  try {
    const prUrl = await withProvenance('pr-generator', () => {
      run('git', ['checkout', '-b', branchName]);
      run('git', ['apply', resolvedDiff]);
      run('git', ['add', '-A']);
      run('git', ['commit', '-m', `skill(${skillName}): propose patch`]);
      run('git', ['push', '-u', 'origin', branchName]);
      const url = run('gh', [
        'pr',
        'create',
        '--base',
        base,
        '--head',
        branchName,
        '--title',
        title,
        '--body',
        body,
      ]).trim();
      return url;
    });
    return {
      kind: 'ok',
      skillName,
      branchName,
      base,
      prUrl,
    };
  } catch (err) {
    return {
      kind: 'error',
      code: 'E_PROPOSE_PATCH_FAILED',
      message: `propose-patch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
