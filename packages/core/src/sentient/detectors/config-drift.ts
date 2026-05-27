/**
 * Config Drift Detector — Tier-2 sentient proposal source (T9897).
 *
 * Wraps {@link validateConfig} (T9887) and {@link checkDrift} (T9878) from
 * `packages/core/src/config/registry.ts`. Emits Tier-2 proposals when a
 * scoped config file violates its declared schema (severity `P2`) or when a
 * cascade entry's drift-detection strategy flags drift (severity `P3`).
 *
 * Design principles:
 *   - NO LLM calls. All data comes from the schema + drift surfaces.
 *   - Detector function generates proposals unconditionally; the wrapper
 *     {@link safeRunConfigDriftScan} applies kill-switch + `tier2Enabled`
 *     gating before persistence.
 *   - All errors from the underlying surfaces are SILENT — a single bad
 *     scope produces an `'error'` outcome rather than throwing.
 *   - Missing config files are NOT a violation. `validateConfig` short-circuits
 *     to `{ ok: true }` when the file is absent, and `checkDrift` returns
 *     `{ drift: false }`; neither path emits a proposal.
 *
 * Companion detector to {@link import('./context-staleness.js')} (T9896).
 *
 * @task T9897
 * @see ADR-076 — Project context detection
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { checkDrift, validateConfig } from '../../config/registry.js';
import { readSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cadence (4 hours) between config-drift scan passes when wired into
 * the tick loop. Schema/drift checks are cheap (zod safeParse + a JSON read),
 * so the scan can run more frequently than the 6-hour context-staleness scan.
 */
export const CONFIG_DRIFT_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Discriminant for config-fix proposals. */
export const CONFIG_FIX_KIND = 'config-fix' as const;

/** Validation scopes covered by every detector pass. */
const VALIDATION_SCOPES = ['project', 'global'] as const satisfies readonly (
  | 'project'
  | 'global'
)[];

/** Drift scopes covered by every detector pass. */
const DRIFT_SCOPES = ['project', 'global', 'metadata'] as const satisfies readonly (
  | 'project'
  | 'global'
  | 'metadata'
)[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Severity assigned to detector-emitted Tier-2 proposals.
 * Mirrors the `severity` column allowlist (`P0`|`P1`|`P2`|`P3`) defined in
 * `packages/contracts/src/enums.ts`.
 */
export type Tier2ProposalSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * Detector-side Tier-2 proposal shape (T9897 contract).
 *
 * Lightweight representation emitted by {@link detectConfigDrift}. Mirrors
 * the {@link import('./context-staleness.js').Tier2Proposal} shape so both
 * detectors share a uniform contract for the persistence layer.
 */
export interface Tier2Proposal {
  /**
   * Stable identifier. Encodes the detector source, the scope, and a
   * timestamp so repeated emissions for the same scope produce distinct IDs
   * (the persistence layer dedupes on `(kind, title, fixAction)` content).
   */
  id: string;
  /** Discriminant — `'config-fix'` for this detector. */
  kind: typeof CONFIG_FIX_KIND;
  /** Short human-readable headline (no freeform LLM text). */
  title: string;
  /** Severity bucket. `P2` for schema violations, `P3` for drift findings. */
  severity: Tier2ProposalSeverity;
  /** CLI command the owner should run to clear the proposal. */
  fixAction: string;
  /** Why this proposal was emitted (template-generated, includes issues). */
  reason: string;
}

/** Options accepted by {@link safeRunConfigDriftScan}. */
export interface ConfigDriftScanOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override the kill-switch check. Injected by tests to avoid touching the
   * state file. When omitted, reads the daemon state file directly.
   */
  isKilled?: () => Promise<boolean>;
  /**
   * Override the tier2Enabled check. Injected by tests. When omitted, reads
   * the daemon state file directly.
   */
  isTier2Enabled?: () => Promise<boolean>;
  /**
   * Override the detector function. Injected by tests so the scan wrapper can
   * be exercised without touching real config surfaces.
   */
  detect?: (projectRoot: string) => Promise<Tier2Proposal[]>;
}

/** Outcome discriminant produced by {@link safeRunConfigDriftScan}. */
export type ConfigDriftScanKind =
  | 'killed' // killSwitch active before the detector ran
  | 'disabled' // tier2Enabled=false; detector ran but persistence is gated off
  | 'clean' // detector produced zero proposals
  | 'violations' // proposals were emitted
  | 'error'; // unexpected error during the scan

/** Structured outcome of one scan pass. */
export interface ConfigDriftScanOutcome {
  /** How the scan ended. */
  kind: ConfigDriftScanKind;
  /** All proposals generated by the detector (empty when none). */
  proposals: Tier2Proposal[];
  /** Human-readable detail (one line). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Build a schema-violation proposal for one scope.
 */
function buildValidationProposal(
  scope: 'project' | 'global',
  issues: readonly string[],
): Tier2Proposal {
  const issueSummary = issues.join('; ');
  return {
    id: `prop-config-drift-${scope}-${Date.now()}`,
    kind: CONFIG_FIX_KIND,
    title: `Config (${scope}) violates schema`,
    severity: 'P2',
    fixAction: `cleo config validate --scope ${scope}  # then fix reported issues`,
    reason: `Config ${scope} has ${issues.length} schema violation(s): ${issueSummary}`,
  };
}

/**
 * Build a drift proposal for one scope.
 */
function buildDriftProposal(
  scope: 'project' | 'global' | 'metadata',
  reason: string | undefined,
): Tier2Proposal {
  const detail = reason ?? 'drift detected';
  return {
    id: `prop-config-drift-${scope}-drift-${Date.now()}`,
    kind: CONFIG_FIX_KIND,
    title: `Config (${scope}) drift detected`,
    severity: 'P3',
    fixAction: `cleo config drift-check --scope ${scope}  # inspect drift reason`,
    reason: `Config ${scope} drift: ${detail}`,
  };
}

/**
 * Run schema validation across project + global scopes and drift detection
 * across project + global + metadata scopes. Returns one Tier-2 proposal per
 * violation or drift finding.
 *
 * Returns an empty array when:
 *   - Every scope passes schema validation AND every drift scope reports no
 *     drift.
 *   - The underlying config files are absent (missing config is not a
 *     violation; validators short-circuit to ok=true and drift=false).
 *
 * Errors raised by `validateConfig` or `checkDrift` for an individual scope
 * are silently skipped — the detector returns whatever proposals it can
 * collect from the surfaces that did succeed. Bubbling a single bad scope
 * would defeat the partial-progress semantics the sentient loop relies on.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Zero or more Tier-2 proposals.
 *
 * @task T9897
 */
export async function detectConfigDrift(projectRoot: string): Promise<Tier2Proposal[]> {
  const proposals: Tier2Proposal[] = [];

  for (const scope of VALIDATION_SCOPES) {
    try {
      const result = await validateConfig(scope, projectRoot);
      if (!result.ok && result.issues.length > 0) {
        proposals.push(buildValidationProposal(scope, result.issues));
      }
    } catch {
      // Per design: a single bad scope MUST NOT abort the detector. The
      // outer scan wrapper surfaces unhandled errors via outcome='error'.
    }
  }

  for (const scope of DRIFT_SCOPES) {
    try {
      const result = await checkDrift(scope, projectRoot);
      if (result.drift) {
        proposals.push(buildDriftProposal(scope, result.reason));
      }
    } catch {
      // Same partial-progress contract as the validation loop above.
    }
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Scan wrapper (kill-switch + tier2Enabled gated)
// ---------------------------------------------------------------------------

/**
 * Default kill-switch check — reads sentient-state.json via {@link readSentientState}.
 */
async function defaultIsKilled(statePath: string): Promise<boolean> {
  const state = await readSentientState(statePath);
  return state.killSwitch === true;
}

/**
 * Default tier2Enabled check — reads sentient-state.json via {@link readSentientState}.
 */
async function defaultIsTier2Enabled(statePath: string): Promise<boolean> {
  const state = await readSentientState(statePath);
  return state.tier2Enabled === true;
}

/**
 * Run the config-drift detector with sentient gating applied.
 *
 * Steps:
 *   1. Honour the kill-switch — abort before any side effect.
 *   2. Run the detector. When it returns zero proposals, the outcome is
 *      `'clean'`.
 *   3. When proposals are generated, honour `tier2Enabled` — the proposals
 *      are returned to the caller either way, but the outcome discriminant
 *      marks whether persistence is permitted.
 *
 * This wrapper NEVER throws — all errors collapse to an `'error'` outcome.
 *
 * @param options - See {@link ConfigDriftScanOptions}.
 * @returns {@link ConfigDriftScanOutcome}.
 *
 * @task T9897
 */
export async function safeRunConfigDriftScan(
  options: ConfigDriftScanOptions,
): Promise<ConfigDriftScanOutcome> {
  try {
    const isKilled = options.isKilled ?? (() => defaultIsKilled(options.statePath));
    if (await isKilled()) {
      return {
        kind: 'killed',
        proposals: [],
        detail: 'killSwitch active — config drift scan skipped',
      };
    }

    const detect = options.detect ?? detectConfigDrift;
    const proposals = await detect(options.projectRoot);

    if (proposals.length === 0) {
      return {
        kind: 'clean',
        proposals: [],
        detail: 'all config scopes pass schema + drift checks',
      };
    }

    const isTier2Enabled =
      options.isTier2Enabled ?? (() => defaultIsTier2Enabled(options.statePath));
    if (!(await isTier2Enabled())) {
      return {
        kind: 'disabled',
        proposals,
        detail: `tier2Enabled=false; ${proposals.length} proposal(s) generated but not persisted`,
      };
    }

    return {
      kind: 'violations',
      proposals,
      detail: `${proposals.length} config proposal(s) ready to persist`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      proposals: [],
      detail: `config drift scan threw: ${message}`,
    };
  }
}
