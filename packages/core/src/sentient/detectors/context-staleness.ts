/**
 * Context Staleness Detector — Tier-2 sentient proposal source (T9896).
 *
 * Emits a Tier-2 proposal when `.cleo/project-context.json` has a `detectedAt`
 * timestamp older than {@link CONTEXT_STALENESS_MS} (30 days). Stale project
 * context can mislead the test/build command resolver and the framework
 * detector, so we surface a low-priority refresh recommendation through the
 * existing sentient propose-enable gate.
 *
 * Design principles:
 *   - NO LLM calls. All data comes from a structured JSON read.
 *   - Single-purpose: one detector function returning ONE proposal or null.
 *   - Generation vs. persistence are decoupled — the detector ALWAYS computes
 *     and returns the proposal; the wrapper {@link safeRunContextStalenessScan}
 *     respects kill-switch + `tier2Enabled` before any side effect.
 *   - All file/parse errors return `null` (best-effort — never throw).
 *
 * Integration point: {@link safeRunContextStalenessScan} is fired (best-effort)
 * from `tick.ts` alongside the existing stage-drift / hygiene scans.
 *
 * @task T9896
 * @see ADR-076 — Project context detection
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { computeProjectHash } from '@cleocode/paths';
import { loadProjectContext } from '../../config/registry.js';
import { readSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Staleness threshold (30 days, in milliseconds).
 * Matches `PROJECT_CONTEXT_STALENESS_MS` in `config/registry.ts` so the
 * sentient detector and `checkDrift('staleness-gate', ...)` agree.
 */
export const CONTEXT_STALENESS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Default cadence (6 hours) between context-staleness scan passes when the
 * detector is wired into the tick loop. Longer than stage-drift (30 min) and
 * hygiene (4 h) because the underlying file changes at most once per
 * `cleo init --refresh-context` invocation.
 */
export const CONTEXT_STALENESS_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Number of ms in a day, used for human-readable age formatting. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Discriminant for context-refresh proposals. */
export const CONTEXT_REFRESH_KIND = 'context-refresh' as const;

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
 * Detector-side Tier-2 proposal shape (T9896 contract).
 *
 * Lightweight representation returned by sentient detector functions BEFORE
 * the persistence layer turns it into a `tasks.db` row. Distinct from
 * {@link import('@cleocode/contracts').ProposalCandidate} because detectors
 * carry a concrete `fixAction` (the CLI command the owner should run) rather
 * than a weighted ingester rationale.
 */
export interface Tier2Proposal {
  /**
   * Stable identifier. Deterministic per `(detector, projectRoot)` so that
   * repeated detections of the same staleness condition share an ID and the
   * persistence layer can dedup cleanly.
   */
  id: string;
  /** Discriminant — `'context-refresh'` for this detector. */
  kind: typeof CONTEXT_REFRESH_KIND;
  /** Short human-readable headline (no freeform LLM text). */
  title: string;
  /** Severity bucket; defaults to `'P2'` for staleness proposals. */
  severity: Tier2ProposalSeverity;
  /** CLI command the owner should run to clear the proposal. */
  fixAction: string;
  /** Why this proposal was emitted (template-generated, includes age). */
  reason: string;
}

/** Options accepted by {@link safeRunContextStalenessScan}. */
export interface ContextStalenessScanOptions {
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
   * be exercised without a real `project-context.json` on disk.
   */
  detect?: (projectRoot: string) => Promise<Tier2Proposal | null>;
}

/** Outcome discriminant produced by {@link safeRunContextStalenessScan}. */
export type ContextStalenessScanKind =
  | 'killed' // killSwitch active before the detector ran
  | 'disabled' // tier2Enabled=false; detector ran but persistence is gated off
  | 'fresh' // context exists and is within the staleness window
  | 'no-context' // no project-context.json present
  | 'stale' // proposal was generated
  | 'error'; // unexpected error during the scan

/** Structured outcome of one scan pass. */
export interface ContextStalenessScanOutcome {
  /** How the scan ended. */
  kind: ContextStalenessScanKind;
  /** The proposal generated by the detector (null if no proposal was emitted). */
  proposal: Tier2Proposal | null;
  /** Human-readable detail (one line). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Run the staleness detector against `.cleo/project-context.json` and return
 * either a Tier-2 proposal or `null`.
 *
 * Returns `null` (no proposal) when:
 *   - `loadProjectContext` returns `null` (file absent or unreadable).
 *   - `detectedAt` is missing, non-string, or unparseable.
 *   - The age is within the staleness window.
 *
 * Returns a {@link Tier2Proposal} when `detectedAt` is older than
 * {@link CONTEXT_STALENESS_MS}.
 *
 * This function MUST NOT throw — all errors collapse to `null`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns A staleness proposal, or `null` when no action is required.
 *
 * @task T9896
 */
export async function detectContextStaleness(projectRoot: string): Promise<Tier2Proposal | null> {
  let context: Awaited<ReturnType<typeof loadProjectContext>>;
  try {
    context = await loadProjectContext(projectRoot);
  } catch {
    return null;
  }

  if (context === null) return null;

  const detectedAtRaw = context.detectedAt;
  if (typeof detectedAtRaw !== 'string' || detectedAtRaw.length === 0) {
    return null;
  }

  const detectedAtMs = Date.parse(detectedAtRaw);
  if (Number.isNaN(detectedAtMs)) return null;

  const ageMs = Date.now() - detectedAtMs;
  if (ageMs <= CONTEXT_STALENESS_MS) return null;

  const ageDays = Math.floor(ageMs / MS_PER_DAY);
  const projectHash = computeProjectHash(projectRoot);

  return {
    id: `prop-context-staleness-${projectHash}`,
    kind: CONTEXT_REFRESH_KIND,
    title: 'Project context is >30 days old',
    severity: 'P2',
    fixAction: 'cleo init --refresh-context  # re-runs project detection',
    reason:
      `project-context.json detectedAt is ${detectedAtRaw} (${ageDays} days ago). ` +
      'Stale context can mislead test/build commands. Refresh recommended.',
  };
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
 * Run the context-staleness detector with sentient gating applied.
 *
 * Steps:
 *   1. Honour the kill-switch — abort before any side effect.
 *   2. Run the detector. If it returns `null`, return outcome `'fresh'` (or
 *      `'no-context'` when the context file is absent; we cannot distinguish
 *      the two without re-reading, so the detail string carries the nuance).
 *   3. When a proposal is generated, honour `tier2Enabled` — the proposal is
 *      returned to the caller either way, but the outcome discriminant marks
 *      whether persistence is permitted.
 *
 * This wrapper NEVER throws — all errors collapse to a `'error'` outcome.
 *
 * @param options - See {@link ContextStalenessScanOptions}.
 * @returns {@link ContextStalenessScanOutcome}.
 *
 * @task T9896
 */
export async function safeRunContextStalenessScan(
  options: ContextStalenessScanOptions,
): Promise<ContextStalenessScanOutcome> {
  try {
    const isKilled = options.isKilled ?? (() => defaultIsKilled(options.statePath));
    if (await isKilled()) {
      return {
        kind: 'killed',
        proposal: null,
        detail: 'killSwitch active — context staleness scan skipped',
      };
    }

    const detect = options.detect ?? detectContextStaleness;
    const proposal = await detect(options.projectRoot);

    if (proposal === null) {
      // The detector returns null for BOTH "fresh" and "no-context". Re-read
      // the context to disambiguate the outcome discriminant. This is a
      // cheap read; the file is already in OS cache after the detector pass.
      let hasContext = false;
      try {
        hasContext = (await loadProjectContext(options.projectRoot)) !== null;
      } catch {
        hasContext = false;
      }
      return hasContext
        ? {
            kind: 'fresh',
            proposal: null,
            detail: 'project-context.json is within staleness window',
          }
        : { kind: 'no-context', proposal: null, detail: 'no project-context.json present' };
    }

    const isTier2Enabled =
      options.isTier2Enabled ?? (() => defaultIsTier2Enabled(options.statePath));
    if (!(await isTier2Enabled())) {
      return {
        kind: 'disabled',
        proposal,
        detail: 'tier2Enabled=false; proposal generated but not persisted',
      };
    }

    return {
      kind: 'stale',
      proposal,
      detail: proposal.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      proposal: null,
      detail: `context staleness scan threw: ${message}`,
    };
  }
}
