/**
 * Trust-gate adapter — thin facade that bridges the caamp install command
 * to the canonical skills-guard implementation in `@cleocode/core`.
 *
 * Why an adapter? `@cleocode/core` depends on `@cleocode/caamp`, so caamp
 * MUST NOT statically import core. The adapter uses dynamic import inside
 * a function body so the static module graph stays acyclic while still
 * letting the install command call into the canonical scanner.
 *
 * Failure mode: when `@cleocode/core` is not present at runtime (e.g. caamp
 * is used standalone outside the cleo monorepo), the adapter degrades to
 * an "allow" decision and emits a warning to stderr. Refusing to install
 * because core is missing would break legitimate non-cleo usage.
 *
 * @task T9730
 * @epic T9564
 */

/**
 * Trust-gate decision exposed to caamp callers.
 *
 * Shape mirrors `@cleocode/core`'s {@link InstallGateDecision} plus the
 * underlying {@link ScanResult} so callers can surface details in error
 * envelopes without re-scanning.
 */
export interface TrustGateOutcome {
  /** Final decision — `allow`, `block`, or `ask`. */
  readonly decision: 'allow' | 'block' | 'ask';
  /** Human-readable rationale. */
  readonly reason: string;
  /** Underlying scan result. */
  readonly scan: AdapterScanResult;
}

/**
 * Local mirror of `@cleocode/core`'s ScanResult — kept as a separate type
 * so the static module graph stays free of core imports. Field set matches
 * exactly; semantics are identical.
 */
export interface AdapterScanResult {
  readonly skillName: string;
  readonly source: string;
  readonly trustLevel: 'builtin' | 'trusted' | 'community' | 'agent-created';
  readonly verdict: 'safe' | 'caution' | 'dangerous';
  readonly findings: ReadonlyArray<{
    readonly patternId: string;
    readonly severity: string;
    readonly category: string;
    readonly file: string;
    readonly line: number;
    readonly match: string;
    readonly description: string;
  }>;
  readonly scannedAt: string;
  readonly summary: string;
}

/**
 * Minimal structural typing of the core APIs we call through the dynamic
 * import. Declared here (rather than via `typeof import('@cleocode/core')`)
 * because caamp does NOT statically depend on core — adding it as a typed
 * import would re-introduce the cycle this adapter exists to avoid.
 */
interface CoreSkillsGuardShape {
  readonly scanSkill: (path: string, source: string) => AdapterScanResult;
  readonly shouldAllowInstall: (
    scan: AdapterScanResult,
    force: boolean,
  ) => { readonly decision: 'allow' | 'block' | 'ask'; readonly reason: string };
  readonly recordTrustBypass: (scan: AdapterScanResult, reason: string | null) => unknown;
}

/**
 * Lazy core resolver — caches the dynamic import so repeated install calls
 * don't pay the resolution cost more than once per process.
 */
let cachedCore: CoreSkillsGuardShape | null | undefined;

async function resolveCore(): Promise<CoreSkillsGuardShape | null> {
  if (cachedCore !== undefined) return cachedCore;
  try {
    // Dynamic import keeps the static module graph acyclic. The string is
    // intentionally not statically analysable for circular-detection tools.
    const mod = (await import('@cleocode/core' as string)) as CoreSkillsGuardShape;
    cachedCore = mod;
  } catch {
    cachedCore = null;
    process.stderr.write(
      '[caamp] WARNING: @cleocode/core unavailable — skipping trust gate (skill installs not security-checked)\n',
    );
  }
  return cachedCore;
}

/**
 * Run the skills-guard scan + INSTALL_POLICY gate against a local skill
 * path.
 *
 * @param localPath - Absolute path to the skill root (the directory that
 *                    contains SKILL.md or the markdown file itself).
 * @param source    - Source identifier — drives trust-level resolution
 *                    (e.g. GitHub URL, `owner/repo`, `agent-created`).
 * @param force     - Operator override — flips `block` to `allow` and
 *                    records an audit row. Never flips `ask` (the caller
 *                    must surface a prompt or non-TTY error).
 * @returns Composite decision + scan result.
 *
 * @task T9730
 */
export async function evaluateSkillTrustGate(
  localPath: string,
  source: string,
  force: boolean = false,
): Promise<TrustGateOutcome> {
  const core = await resolveCore();
  if (!core) {
    return {
      decision: 'allow',
      reason: 'Trust gate skipped — @cleocode/core not available',
      scan: {
        skillName: localPath.split('/').filter(Boolean).pop() ?? localPath,
        source,
        trustLevel: 'community',
        verdict: 'safe',
        findings: [],
        scannedAt: new Date().toISOString(),
        summary: 'core-unavailable',
      },
    };
  }
  const scan = core.scanSkill(localPath, source);
  const gate = core.shouldAllowInstall(scan, force);
  return { decision: gate.decision, reason: gate.reason, scan };
}

/**
 * Re-export of {@link AdapterScanResult} so the caamp wire-site stays
 * decoupled from core's exact type names.
 */
export type SkillScanResult = AdapterScanResult;

/**
 * Append a bypass entry to `.cleo/audit/skill-trust-bypass.jsonl`.
 *
 * No-op when `@cleocode/core` is unavailable. Errors during writing are
 * swallowed and logged to stderr to avoid breaking installs purely on
 * audit-log failures.
 *
 * @param scan   - The scan result that was overridden.
 * @param reason - Optional operator-supplied justification.
 *
 * @task T9730
 */
export async function recordSkillTrustBypass(
  scan: AdapterScanResult,
  reason: string | null = null,
): Promise<void> {
  const core = await resolveCore();
  if (!core) return;
  try {
    core.recordTrustBypass(scan, reason);
  } catch (err) {
    process.stderr.write(
      `[caamp] WARNING: failed to record trust-bypass audit row: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
