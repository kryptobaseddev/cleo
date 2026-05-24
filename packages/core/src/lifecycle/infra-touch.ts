/**
 * Infrastructure-touch detection for IVTR Lead R2 (Validate phase).
 *
 * **Problem this solves (T9842):**
 *
 * The IVTR Lead spawn prompt previously instructed the Validate-phase agent to
 * run only the test files explicitly named in the task spec. When an
 * "implementation" change touched an infrastructure file — e.g. a transaction
 * primitive in `packages/core/src/store/sqlite-data-accessor.ts` — the Lead
 * verified targeted unit tests passed but missed cross-package regressions.
 *
 * **Precedent — T9814 R2 (2026-05-20):**
 *
 * T9814 swapped `BEGIN IMMEDIATE` for SAVEPOINTs inside `DataAccessor.transaction()`
 * to support nested transactions for `add-batch`. The targeted tests passed (6/6
 * for add-batch, 34/34 for add, 9/9 for allocate). IVTR Lead R2 approved on the
 * targeted scope. CI then surfaced a regression in `agent-resolver.test.ts`
 * (`preferTier` failed) because the agent-resolver depended on `BEGIN IMMEDIATE`
 * outer-transaction semantics that SAVEPOINTs do not replicate verbatim. The
 * hotfix commit `baa996d2b` restored the outer-tx case.
 *
 * **Rule (this module):**
 *
 * When the Implement-phase evidence bundle includes `filesChanged` that match
 * any of the canonical infrastructure path patterns, the Lead's Validate-phase
 * prompt MUST instruct it to run the full per-package vitest suite for every
 * package whose source surface was touched — not the targeted tests alone.
 *
 * Infrastructure paths include:
 *  - `packages/core/src/store/**`              (DB chokepoint, transactions, migrations)
 *  - `packages/core/src/orchestration/**`      (spawn-prompt, dispatch resolution)
 *  - `packages/core/src/dispatch/**`           (typed-dispatch, domain handlers)
 *  - `packages/contracts/src/**`               (cross-package types — every consumer rebuilds)
 *  - `packages/worktree/src/**`                (worktree-create / git-shim integration)
 *  - `packages/core/src/migration/**`          (schema bootstrapping)
 *  - any path containing `transaction` or `pragma` in its basename
 *
 * @task T9842 — IVTR Lead spawn prompt blast-radius test scope
 * @precedent T9814 — SAVEPOINT refactor broke agent-resolver.preferTier despite green targeted tests
 */

// =============================================================================
// CANONICAL PATH PATTERNS
// =============================================================================

/**
 * Canonical infrastructure-path glob patterns.
 *
 * Each pattern is matched as a string-prefix test against forward-slashed paths
 * (no real glob engine needed for the current shape — every pattern is a
 * directory prefix or a substring match on `transaction`/`pragma`/`migration`).
 *
 * Order matters only for documentation: the matcher is a logical OR.
 *
 * @task T9842
 */
export const INFRASTRUCTURE_PATH_PATTERNS: readonly string[] = [
  // Database / store chokepoint
  'packages/core/src/store/',
  // Orchestration surface — spawn prompts, dispatch resolution, IVTR
  'packages/core/src/orchestration/',
  // Typed dispatch — every CLI command routes through here
  'packages/core/src/dispatch/',
  'packages/cleo/src/dispatch/',
  // Cross-package contracts — every consumer rebuilds against changes here
  'packages/contracts/src/',
  // Worktree provisioning + git-shim — orchestrator infrastructure
  'packages/worktree/src/',
  // Schema migrations — bootstrap path for every fresh init
  'packages/core/src/migration/',
] as const;

/**
 * Substring patterns matched against a path's basename (case-insensitive).
 *
 * A file outside the directory-prefix patterns above is still considered an
 * infrastructure touch when its basename signals transactional / pragma /
 * migration semantics — these change shared invariants regardless of the
 * package they live in.
 *
 * @task T9842
 */
export const INFRASTRUCTURE_BASENAME_SUBSTRINGS: readonly string[] = [
  'transaction',
  'pragma',
  'migration',
] as const;

// =============================================================================
// PURE DETECTION
// =============================================================================

/**
 * Result of {@link detectInfrastructureTouch}.
 *
 * @task T9842
 */
export interface InfrastructureTouchResult {
  /** True iff any file in the input matches an infrastructure pattern. */
  affected: boolean;
  /** The subset of input paths that matched. Order preserved from input. */
  matchedPaths: string[];
  /**
   * Sorted unique list of package directory names (e.g. `core`, `contracts`,
   * `worktree`) that were touched. Useful for composing
   * `pnpm --filter @cleocode/<pkg> run test` commands.
   *
   * Returned in ascending alphabetical order for deterministic prompt rendering.
   */
  packages: string[];
}

/**
 * Normalize a path: collapse backslashes, strip leading `./`, lowercase.
 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Extract the `@cleocode/<pkg>` package short-name from a `packages/<pkg>/…`
 * path. Returns `null` if the path is not under `packages/`.
 */
function packageOf(normalizedPath: string): string | null {
  if (!normalizedPath.startsWith('packages/')) return null;
  const rest = normalizedPath.slice('packages/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/**
 * Return the basename portion of a path (everything after the final `/`).
 */
function basenameOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? normalizedPath : normalizedPath.slice(slash + 1);
}

/**
 * Detect whether any file in `filesChanged` lives on a CLEO infrastructure
 * code path that demands a full per-package test scope rather than targeted
 * tests alone.
 *
 * **Semantics:**
 *
 * - A path matches when its normalized form starts with one of the directory
 *   patterns in {@link INFRASTRUCTURE_PATH_PATTERNS}, **or** when its basename
 *   contains one of {@link INFRASTRUCTURE_BASENAME_SUBSTRINGS} as a substring.
 * - The match is case-insensitive and tolerant of `./` prefixes and Windows
 *   backslashes.
 * - The `packages` field is sorted alphabetically with duplicates removed so
 *   the prompt renders deterministically.
 *
 * **Used by:** {@link buildValidatePhaseInstruction} in `./ivtr-loop.ts`.
 *
 * @param filesChanged - Relative repo paths from the Implement-phase evidence
 *                       bundle (`ImplEvidenceSummary.filesChanged`). May be
 *                       empty or undefined-flat.
 * @returns Detection result. When `affected === false`, `matchedPaths` and
 *          `packages` are empty arrays.
 *
 * @task T9842
 * @example
 * ```ts
 * detectInfrastructureTouch([
 *   'packages/core/src/store/sqlite-data-accessor.ts',
 *   'packages/cleo/src/cli/commands/show.ts',
 * ]);
 * // → { affected: true,
 * //     matchedPaths: ['packages/core/src/store/sqlite-data-accessor.ts'],
 * //     packages: ['core'] }
 * ```
 */
export function detectInfrastructureTouch(
  filesChanged: readonly string[] | undefined | null,
): InfrastructureTouchResult {
  if (!filesChanged || filesChanged.length === 0) {
    return { affected: false, matchedPaths: [], packages: [] };
  }

  const matched: string[] = [];
  const packageSet = new Set<string>();

  for (const raw of filesChanged) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const norm = normalize(raw);

    const prefixHit = INFRASTRUCTURE_PATH_PATTERNS.some((pat) => norm.startsWith(pat));
    let basenameHit = false;
    if (!prefixHit) {
      const base = basenameOf(norm);
      basenameHit = INFRASTRUCTURE_BASENAME_SUBSTRINGS.some((sub) => base.includes(sub));
    }

    if (prefixHit || basenameHit) {
      matched.push(raw);
      const pkg = packageOf(norm);
      if (pkg) packageSet.add(pkg);
    }
  }

  return {
    affected: matched.length > 0,
    matchedPaths: matched,
    packages: [...packageSet].sort(),
  };
}

// =============================================================================
// PROMPT FRAGMENT
// =============================================================================

/**
 * Build the "Blast-Radius Test Scope" prompt section to be injected into the
 * Validate-phase Lead spawn prompt when an infrastructure touch is detected.
 *
 * The section instructs the Lead to run the FULL per-package vitest suite for
 * every touched package, citing the T9814 precedent.
 *
 * Returns an empty string when `result.affected === false`, so callers can
 * unconditionally append the output.
 *
 * @param result - Output of {@link detectInfrastructureTouch}.
 * @returns Markdown section (or empty string).
 *
 * @task T9842
 */
export function buildBlastRadiusTestScopeSection(result: InfrastructureTouchResult): string {
  if (!result.affected) return '';

  const packageCommands =
    result.packages.length > 0
      ? result.packages.map((pkg) => `pnpm --filter @cleocode/${pkg} run test`).join('\n')
      : 'pnpm run test';

  const matchedList = result.matchedPaths.map((p) => `- \`${p}\``).join('\n');

  return `### Blast-Radius Test Scope — MANDATORY (T9842)

> **Infrastructure paths were touched in this task.** Targeted test files alone
> are INSUFFICIENT — you MUST run the full per-package vitest suite for every
> affected package before passing this Validate phase.
>
> **Precedent (T9814 R2)**: A SAVEPOINT refactor in \`DataAccessor.transaction()\`
> passed every targeted test (6/6 add-batch, 34/34 add, 9/9 allocate) but broke
> \`agent-resolver.test.ts preferTier\`. The IVTR Lead approved on the targeted
> scope and CI caught the regression. Full per-package runs prevent this class
> of failure.

#### Infrastructure-touched files

${matchedList}

#### Required test commands

\`\`\`bash
${packageCommands}
\`\`\`

Attach the JSON output of each run as evidence (\`cleo docs add --labels test-output\`)
and reference the sha256 set in your \`--next\` call. **Approving on targeted-only
test results when infrastructure paths are touched is grounds for loop-back with
reason \`infra-test-scope-violation\`.**`;
}
