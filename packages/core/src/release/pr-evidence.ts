/**
 * `pr:<number>` evidence-atom validator.
 *
 * Resolves a GitHub pull request via the `gh` CLI and decides whether the PR
 * satisfies the `implemented`, `testsPassed`, and `qaPassed` gates (T9838).
 * Closes the release-verb dogfood gap (T9764): tasks that ship via the
 * standard PR + admin-merge flow previously had no zero-friction way to record
 * evidence retroactively —
 * `tool:test` re-runs the entire monorepo suite and `note:` is rejected for
 * hard gates on critical verifications.
 *
 * A PR atom counts as evidence when:
 *   1. `state === 'MERGED'` — the PR was actually shipped to main.
 *   2. `mergedAt` is non-null — defends against API races.
 *   3. Every required-workflow check has `conclusion === 'SUCCESS'` (or
 *      `'SKIPPED'`) — there are zero `FAILURE` checks among the
 *      required workflows configured by branch protection.
 *
 * Results are cached under `<projectRoot>/.cleo/cache/evidence/pr-<num>.json`,
 * keyed on `(prNumber, mergedAt)` so re-verifies skip the network round trip.
 *
 * @task T9764
 * @epic T9762
 * @saga T9758
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type GhPrViewPayload,
  ghPrViewSchema,
  PR_REQUIRED_WORKFLOWS,
  PR_REQUIRED_WORKFLOWS_ENV_VAR,
} from '@cleocode/contracts';

import { isGhCliAvailable } from './github-pr.js';

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

/**
 * Result of resolving a `pr:<number>` atom.
 *
 * On success carries the data needed to materialise an `EvidenceAtom` of
 * `kind: 'pr'`. On failure carries a human-readable reason plus the same
 * `codeName` vocabulary used by the rest of the evidence pipeline so error
 * presentation stays uniform.
 *
 * @task T9764
 */
export type PrAtomResolution =
  | {
      ok: true;
      prNumber: number;
      mergeCommitSha: string;
      mergedAt: string;
      successCount: number;
      totalChecks: number;
      cacheHit: boolean;
    }
  | {
      ok: false;
      reason: string;
      codeName:
        | 'E_EVIDENCE_INVALID'
        | 'E_EVIDENCE_INSUFFICIENT'
        | 'E_EVIDENCE_TESTS_FAILED'
        | 'E_EVIDENCE_TOOL_FAILED';
    };

// ---------------------------------------------------------------------------
// Cache layout
// ---------------------------------------------------------------------------

/**
 * Filesystem location for the cached PR validation result.
 *
 * Path: `<projectRoot>/.cleo/cache/evidence/pr-<num>.json`.
 *
 * @task T9764
 */
export function prCacheEntryPath(projectRoot: string, prNumber: number): string {
  return join(projectRoot, '.cleo', 'cache', 'evidence', `pr-${prNumber}.json`);
}

/**
 * On-disk cache entry shape. The `key` field couples the entry to a
 * specific (prNumber, mergedAt) tuple — when GitHub re-merges (rare) or
 * the entry was captured before merge, the key changes and the cache
 * is invalidated automatically.
 *
 * @task T9764
 */
interface PrCacheEntry {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly prNumber: number;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  readonly successCount: number;
  readonly totalChecks: number;
  readonly capturedAt: string;
}

function buildCacheKey(prNumber: number, mergedAt: string): string {
  return `pr-${prNumber}@${mergedAt}`;
}

function readCacheEntry(projectRoot: string, prNumber: number): PrCacheEntry | null {
  const path = prCacheEntryPath(projectRoot, prNumber);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PrCacheEntry>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.prNumber !== 'number' || parsed.prNumber !== prNumber) return null;
    if (typeof parsed.mergedAt !== 'string' || parsed.mergedAt === '') return null;
    if (typeof parsed.mergeCommitSha !== 'string' || parsed.mergeCommitSha === '') return null;
    if (typeof parsed.key !== 'string') return null;
    if (parsed.key !== buildCacheKey(prNumber, parsed.mergedAt)) return null;
    return parsed as PrCacheEntry;
  } catch {
    return null;
  }
}

function writeCacheEntry(projectRoot: string, entry: PrCacheEntry): void {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalPath = prCacheEntryPath(projectRoot, entry.prNumber);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
  renameSync(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// gh CLI wrapper (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Function signature for fetching a GitHub PR's metadata.
 *
 * Returning `null` signals a fetch failure (binary missing, auth error,
 * malformed JSON). Returning a payload that fails {@link ghPrViewSchema}
 * also yields a `E_EVIDENCE_TOOL_FAILED` outcome.
 *
 * @task T9764
 */
export type FetchGhPrPayload = (
  prNumber: number,
  cwd: string,
) => Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }>;

/**
 * Default `gh pr view` invocation. Calls `gh pr view <num> --json
 * state,mergedAt,mergeable,headRefOid,statusCheckRollup` via `execFileSync`
 * for parity with the rest of the release module's `gh` usage.
 *
 * @task T9764
 */
export const defaultFetchGhPrPayload: FetchGhPrPayload = async (prNumber: number, cwd: string) => {
  if (!isGhCliAvailable()) {
    return {
      ok: false,
      reason:
        `gh CLI is not available on PATH. Install GitHub CLI and run \`gh auth login\` ` +
        `before using \`pr:<number>\` evidence atoms.`,
    };
  }
  try {
    const stdout = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'state,mergedAt,mergeable,headRefOid,statusCheckRollup',
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `gh pr view returned non-JSON output: ${msg}` };
    }
    return { ok: true, payload: parsed };
  } catch (err) {
    const stderr =
      err instanceof Error && 'stderr' in err
        ? String((err as NodeJS.ErrnoException & { stderr?: unknown }).stderr ?? err.message)
        : err instanceof Error
          ? err.message
          : String(err);
    if (/auth|login|401/i.test(stderr)) {
      return {
        ok: false,
        reason:
          `gh pr view failed — looks like \`gh\` is not authenticated. Run \`gh auth login\` ` +
          `(stderr: ${stderr.slice(0, 200)})`,
      };
    }
    if (/could not resolve.*pull request|not found|no pull requests|HTTP 404/i.test(stderr)) {
      return {
        ok: false,
        reason: `gh pr view: PR #${prNumber} not found in this repository (stderr: ${stderr.slice(0, 200)})`,
      };
    }
    return {
      ok: false,
      reason: `gh pr view failed: ${stderr.slice(0, 400)}`,
    };
  }
};

// ---------------------------------------------------------------------------
// Required-workflow resolution
// ---------------------------------------------------------------------------

/**
 * Extract a project's declared required-workflow set from a parsed
 * `.cleo/project-context.json` object (the `release.prRequiredWorkflows` field,
 * {@link PR_REQUIRED_WORKFLOWS_CONTEXT_KEY}).
 *
 * Semantics (gh#1104):
 * - Returns `null` when the key is ABSENT or malformed (not an array) — the
 *   caller falls through to the {@link PR_REQUIRED_WORKFLOWS} default.
 * - Returns the (possibly EMPTY) array of trimmed, non-empty string entries
 *   when the key is present. An empty array is a meaningful value meaning "no
 *   required workflows" — a MERGED PR with no/empty checks then satisfies `pr:`.
 *   It MUST NOT be coerced to `null` or to the default.
 *
 * @task T12014 (gh#1104)
 */
function extractProjectContextRequiredWorkflows(
  projectContext?: Record<string, unknown> | null,
): string[] | null {
  if (typeof projectContext !== 'object' || projectContext === null) return null;
  const release = (projectContext as Record<string, unknown>).release;
  if (typeof release !== 'object' || release === null) return null;
  const declared = (release as Record<string, unknown>).prRequiredWorkflows;
  if (!Array.isArray(declared)) return null;
  // Present-but-empty is intentional: return [] (not null) so an explicit
  // "no required workflows" declaration accepts any MERGED PR.
  return declared
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the list of required-workflow names for the current project.
 *
 * Precedence (most specific wins):
 * 1. `CLEO_PR_REQUIRED_WORKFLOWS` env var (comma-separated) — CI/operator
 *    override.
 * 2. `.cleo/project-context.json` `release.prRequiredWorkflows`
 *    ({@link PR_REQUIRED_WORKFLOWS_CONTEXT_KEY}) — committed per-project config.
 *    An explicit empty array means NO required workflows (gh#1104).
 * 3. {@link PR_REQUIRED_WORKFLOWS} default (the cleocode contract-repo gates).
 *
 * @task T9764
 * @task T12014 (gh#1104)
 */
export function resolveRequiredWorkflows(
  env: NodeJS.ProcessEnv = process.env,
  projectContext?: Record<string, unknown> | null,
): string[] {
  const raw = env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const fromContext = extractProjectContextRequiredWorkflows(projectContext);
  if (fromContext !== null) return fromContext;
  return [...PR_REQUIRED_WORKFLOWS];
}

// ---------------------------------------------------------------------------
// Rollup evaluation
// ---------------------------------------------------------------------------

/**
 * Inspect the `statusCheckRollup` and decide whether the required checks
 * are green.
 *
 * Required-check names from {@link PR_REQUIRED_WORKFLOWS} match against
 * EITHER the rollup entry's `workflowName` (top-level workflow like
 * `"Lockfile Check"`) OR its `name` (individual job, like `"Contracts
 * Dep Lint"` which lives under `workflowName === "CI"`). GitHub branch
 * protection lists required contexts by job name OR workflow name, and
 * the rollup may surface them at either granularity.
 *
 * ## Per-required-entry success rule
 *
 * For each entry in {@link PR_REQUIRED_WORKFLOWS}:
 *   1. At least one rollup check must match by name OR workflowName.
 *   2. At least one matching check must have `conclusion === 'SUCCESS'`.
 *   3. The match's status must be `COMPLETED` (not pending).
 *
 * Workflow-level matches (e.g. `"CI"` matches every job under CI) are
 * intentionally LENIENT: when ANY job under the workflow is `SUCCESS`,
 * the workflow counts as satisfied even if other (non-required-by-name)
 * jobs inside the same workflow are `FAILURE`. This mirrors GitHub's
 * branch-protection behavior, which gates merge on the
 * `required_status_checks[contexts]` list — administrators may merge
 * past non-required job failures, and `pr:<num>` evidence accepts that
 * reality. To enforce stricter rules, narrow the required list via the
 * {@link PR_REQUIRED_WORKFLOWS_ENV_VAR} env var to specific job names.
 *
 * @internal
 * @task T9764
 */
export function evaluateRollup(
  rollup: GhPrViewPayload['statusCheckRollup'],
  requiredWorkflows: readonly string[],
): { ok: true; successCount: number; totalChecks: number } | { ok: false; reason: string } {
  const totalChecks = rollup.length;
  let successCount = 0;

  // For each required entry, track:
  //   - whether ANY rollup check matched (by name OR workflowName)
  //   - whether a matching check had conclusion=SUCCESS
  //   - whether a matching check that matched BY NAME exactly was FAILURE
  //     (job-name matches are strict; workflow-name matches are lenient)
  //   - whether a matching check is pending
  interface MatchStatus {
    seen: boolean;
    success: boolean;
    nameMatchFailure: string[];
    pending: string[];
  }
  const status = new Map<string, MatchStatus>(
    requiredWorkflows.map((r) => [
      r,
      { seen: false, success: false, nameMatchFailure: [], pending: [] },
    ]),
  );

  for (const check of rollup) {
    if (check.conclusion === 'SUCCESS') successCount++;
    const workflow = check.workflowName ?? '';
    const name = check.name ?? '';

    for (const req of requiredWorkflows) {
      const nameMatch = req === name;
      const workflowMatch = req === workflow;
      if (!nameMatch && !workflowMatch) continue;
      const entry = status.get(req);
      if (!entry) continue;
      entry.seen = true;
      const isPending =
        check.status !== undefined && check.status !== 'COMPLETED' && check.status !== 'NEUTRAL';
      if (isPending) {
        entry.pending.push(name || '(unnamed)');
        continue;
      }
      // SUCCESS or SKIPPED (conditional skip) both count as satisfying
      // the gate. SKIPPED is what GitHub Actions emits when a job's `if:`
      // condition evaluates false — that's a legitimate "this didn't
      // need to run" outcome, not a failure.
      if (check.conclusion === 'SUCCESS' || check.conclusion === 'SKIPPED') {
        entry.success = true;
      }
      if (nameMatch && (check.conclusion === 'FAILURE' || check.conclusion === 'CANCELLED')) {
        // Exact-name match with FAILURE/CANCELLED is fatal — the named
        // gate explicitly failed and cannot be excused by a sibling
        // workflow success.
        entry.nameMatchFailure.push(name);
      }
    }
  }

  const missing: string[] = [];
  const pending: string[] = [];
  const failures: string[] = [];

  for (const [req, entry] of status) {
    if (!entry.seen) {
      missing.push(req);
      continue;
    }
    if (entry.nameMatchFailure.length > 0) {
      failures.push(`${req} (${entry.nameMatchFailure.join(', ')})`);
      continue;
    }
    if (!entry.success) {
      if (entry.pending.length > 0) {
        pending.push(`${req} (${entry.pending.slice(0, 3).join(', ')})`);
      } else {
        failures.push(`${req} (no SUCCESS check found)`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `Required workflows did not run for this PR: ${missing.join(', ')}. ` +
        `Cannot accept pr atom — required gates were skipped.`,
    };
  }

  if (pending.length > 0) {
    return {
      ok: false,
      reason:
        `Required PR checks are still pending: ${pending.slice(0, 5).join(', ')}` +
        `${pending.length > 5 ? '…' : ''}. Re-run verify after CI completes.`,
    };
  }

  if (failures.length > 0) {
    return {
      ok: false,
      reason:
        `Required PR checks failed: ${failures.slice(0, 5).join(', ')}` +
        `${failures.length > 5 ? '…' : ''}. Cannot accept pr atom — CI was not green.`,
    };
  }

  return { ok: true, successCount, totalChecks };
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

/**
 * Options for {@link resolvePrEvidenceAtom}. Allows test injection of a
 * mock `gh` wrapper plus an env override so tests do not have to mutate
 * `process.env`.
 *
 * @task T9764
 */
export interface ResolvePrEvidenceAtomOptions {
  /** Mock `gh` wrapper for tests; defaults to {@link defaultFetchGhPrPayload}. */
  readonly fetchGhPrPayload?: FetchGhPrPayload;
  /** Env (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** When `true`, bypass cache reads. Cache writes always happen. */
  readonly bypassCache?: boolean;
  /**
   * Parsed `.cleo/project-context.json` (or `null`). Tier between env and the
   * built-in default for required-workflow resolution (gh#1104). @task T12014
   */
  readonly projectContext?: Record<string, unknown> | null;
}

/**
 * Validate a `pr:<number>` atom end-to-end.
 *
 * Steps:
 *   1. Cache lookup — return immediately on a fresh hit.
 *   2. Fetch `gh pr view <num> --json …`.
 *   3. Schema-validate the payload.
 *   4. Reject non-merged PRs (`state !== 'MERGED'` or null `mergedAt`).
 *   5. Evaluate the status-check rollup against required workflows.
 *   6. Persist the result to cache and return.
 *
 * @param prNumber - PR number (positive integer).
 * @param projectRoot - Absolute path to the project root (for cache + cwd).
 * @param opts - Optional overrides for testing.
 * @returns Validation result envelope.
 *
 * @task T9764
 */
export async function resolvePrEvidenceAtom(
  prNumber: number,
  projectRoot: string,
  opts: ResolvePrEvidenceAtomOptions = {},
): Promise<PrAtomResolution> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return {
      ok: false,
      reason: `pr atom: prNumber must be a positive integer, got ${prNumber}`,
      codeName: 'E_EVIDENCE_INVALID',
    };
  }

  // Cache lookup
  if (!opts.bypassCache) {
    const cached = readCacheEntry(projectRoot, prNumber);
    if (cached) {
      return {
        ok: true,
        prNumber: cached.prNumber,
        mergeCommitSha: cached.mergeCommitSha,
        mergedAt: cached.mergedAt,
        successCount: cached.successCount,
        totalChecks: cached.totalChecks,
        cacheHit: true,
      };
    }
  }

  const fetch = opts.fetchGhPrPayload ?? defaultFetchGhPrPayload;
  const fetched = await fetch(prNumber, projectRoot);
  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  const parsed = ghPrViewSchema.safeParse(fetched.payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `gh pr view payload failed schema validation: ${parsed.error.message}`,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
    };
  }

  const payload = parsed.data;

  if (payload.state !== 'MERGED') {
    return {
      ok: false,
      reason:
        `PR #${prNumber} is in state '${payload.state}' — pr atom requires state=MERGED. ` +
        `Merge the PR (or use a different atom kind) before verifying with pr:<num>.`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }

  if (!payload.mergedAt) {
    return {
      ok: false,
      reason: `PR #${prNumber} reports state=MERGED but mergedAt is null — possible API race.`,
      codeName: 'E_EVIDENCE_INSUFFICIENT',
    };
  }

  const rollupResult = evaluateRollup(
    payload.statusCheckRollup,
    resolveRequiredWorkflows(opts.env, opts.projectContext),
  );
  if (!rollupResult.ok) {
    return {
      ok: false,
      reason: rollupResult.reason,
      codeName: 'E_EVIDENCE_TESTS_FAILED',
    };
  }

  const mergeCommitSha = payload.headRefOid ?? '';
  const entry: PrCacheEntry = {
    schemaVersion: 1,
    key: buildCacheKey(prNumber, payload.mergedAt),
    prNumber,
    mergeCommitSha,
    mergedAt: payload.mergedAt,
    successCount: rollupResult.successCount,
    totalChecks: rollupResult.totalChecks,
    capturedAt: new Date().toISOString(),
  };

  // Best-effort cache write — never fail the resolution because the cache
  // directory was read-only or full.
  try {
    writeCacheEntry(projectRoot, entry);
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    prNumber,
    mergeCommitSha,
    mergedAt: payload.mergedAt,
    successCount: rollupResult.successCount,
    totalChecks: rollupResult.totalChecks,
    cacheHit: false,
  };
}
