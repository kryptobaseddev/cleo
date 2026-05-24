/**
 * Template Drift Detector — Tier-2 sentient proposal source (T9895).
 *
 * Emits a Tier-2 proposal for each {@link TemplateManifestEntry} whose
 * deployed copy at `installPath` has drifted from the rendered source AND
 * whose `updateStrategy` supports refresh (`'overwrite-on-bump'` or
 * `'manifest-merge'`). `'immutable'` entries are intentionally locked and
 * are never proposed; `'diff-prompt'` entries are skipped because they
 * already require interactive owner action and a Tier-2 proposal would be
 * redundant noise. Uninstalled entries are also skipped — installation is a
 * separate lifecycle event handled by `cleo templates install`.
 *
 * Design principles:
 *   - NO LLM calls. All data comes from a structured manifest read + a
 *     byte-for-byte file comparison.
 *   - Plural detector: returns an array of proposals (one per drifted
 *     entry) rather than a single nullable proposal. Companion to T9896
 *     {@link import('./context-staleness.js').detectContextStaleness}.
 *   - Generation vs. persistence are decoupled — the detector ALWAYS
 *     computes and returns proposals; the wrapper
 *     {@link safeRunTemplateDriftScan} respects kill-switch + tier2Enabled
 *     before any side effect.
 *   - All file/read/registry errors collapse to empty array (best-effort —
 *     never throw).
 *
 * Integration point: {@link safeRunTemplateDriftScan} is fired (best-effort)
 * from `tick.ts` alongside the existing stage-drift / hygiene / context-
 * staleness scans (wiring is a separate task — this module is the leaf).
 *
 * @task T9895
 * @epic T9855
 * @see T9896 — Context-staleness detector (pattern reference)
 * @see T9886 — `cleo templates diff <id>` (CLI equivalent)
 * @see T9877 — Template registry SSoT
 * @see ADR-076 — Project context detection
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { existsSync, readFileSync } from 'node:fs';
import type { TemplateManifestEntry, UpdateStrategy } from '@cleocode/contracts';
import {
  getInstalledStatus,
  getTemplateManifest,
  resolveSourcePathAbsolute,
} from '../../templates/registry.js';
import { readSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default cadence (12 hours) between template-drift scan passes when the
 * detector is wired into the tick loop. Longer than context-staleness
 * (6 h) because template drift only changes when the consumer manually
 * edits an installed template file — a low-frequency event.
 */
export const TEMPLATE_DRIFT_SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Discriminant for template-refresh proposals. */
export const TEMPLATE_REFRESH_KIND = 'template-refresh' as const;

/**
 * Update strategies that support automated refresh and therefore qualify
 * for a Tier-2 proposal on drift. Order is incidental; uses `Set` for O(1)
 * membership tests in the detector hot loop.
 *
 * - `overwrite-on-bump` — Safe to blindly rewrite when drift detected.
 * - `manifest-merge`    — Structural merge can reconcile drift.
 *
 * Excluded by design:
 * - `immutable`   — never overwrite (skipped per task brief).
 * - `diff-prompt` — already prompts interactively on `cleo templates
 *                   upgrade`; a Tier-2 proposal is redundant.
 */
const REFRESHABLE_STRATEGIES: ReadonlySet<UpdateStrategy> = new Set([
  'overwrite-on-bump',
  'manifest-merge',
]);

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
 * Detector-side Tier-2 proposal shape for template drift (T9895 contract).
 *
 * Same lightweight shape used by the sibling T9896 detector but with a
 * dedicated `kind` discriminant. Each entry maps to ONE proposal so that
 * the persistence layer can dedup on `id` and the orchestrator can render
 * a per-template fix prompt.
 */
export interface Tier2Proposal {
  /**
   * Stable identifier — `prop-template-drift-<entry.id>`. Deterministic per
   * `(detector, entry)` so repeated detections dedup cleanly on persistence.
   */
  id: string;
  /** Discriminant — `'template-refresh'` for this detector. */
  kind: typeof TEMPLATE_REFRESH_KIND;
  /** Short human-readable headline. */
  title: string;
  /** Severity bucket; fixed at `'P3'` for template-drift (low priority). */
  severity: Tier2ProposalSeverity;
  /** CLI command the owner should run to reconcile the drift. */
  fixAction: string;
  /** Why this proposal was emitted (includes entry id, kind, paths, strategy). */
  reason: string;
}

/** Options accepted by {@link safeRunTemplateDriftScan}. */
export interface TemplateDriftScanOptions {
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
   * Override the detector function. Injected by tests so the scan wrapper
   * can be exercised without a real template registry on disk.
   */
  detect?: (projectRoot: string) => Promise<Tier2Proposal[]>;
}

/** Outcome discriminant produced by {@link safeRunTemplateDriftScan}. */
export type TemplateDriftScanKind =
  | 'killed' // killSwitch active before the detector ran
  | 'disabled' // tier2Enabled=false; detector ran but persistence is gated off
  | 'no-drift' // detector ran, no drifted templates found
  | 'drifted' // one or more proposals were generated
  | 'error'; // unexpected error during the scan

/** Structured outcome of one scan pass. */
export interface TemplateDriftScanOutcome {
  /** How the scan ended. */
  kind: TemplateDriftScanKind;
  /** Every proposal generated by the detector (empty when none). */
  proposals: Tier2Proposal[];
  /** Human-readable detail (one line). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Build the Tier-2 proposal payload for a single drifted manifest entry.
 *
 * Pure function — no IO, no `Date.now()`, deterministic on inputs.
 *
 * @internal
 */
function buildProposal(entry: TemplateManifestEntry): Tier2Proposal {
  return {
    id: `prop-template-drift-${entry.id}`,
    kind: TEMPLATE_REFRESH_KIND,
    title: `Template ${entry.id} has drifted from source`,
    severity: 'P3',
    fixAction: `cleo templates upgrade ${entry.id}`,
    reason:
      `Template ${entry.id} (${entry.kind}) at ${entry.installPath} differs ` +
      `from source ${entry.sourcePath}. Strategy: ${entry.updateStrategy}.`,
  };
}

/**
 * Compare a single template entry's installed copy against its rendered
 * source and return `true` IFF they differ byte-for-byte.
 *
 * Errors (registry resolution, source read, install read) collapse to
 * `false` — the detector is best-effort and MUST NOT emit a noisy
 * "differs" proposal on a transient IO failure.
 *
 * @internal
 */
function isDrifted(entry: TemplateManifestEntry, projectRoot: string): boolean {
  try {
    const { installed, path: installPath } = getInstalledStatus(entry.id, projectRoot);
    if (!installed) return false;
    const sourceAbsolute = resolveSourcePathAbsolute(entry);
    if (!existsSync(sourceAbsolute)) return false;
    const source = readFileSync(sourceAbsolute, 'utf8');
    const installed_ = readFileSync(installPath, 'utf8');
    return source !== installed_;
  } catch {
    return false;
  }
}

/**
 * Run the template-drift detector against `projectRoot` and return one
 * {@link Tier2Proposal} per drifted entry.
 *
 * Returns an empty array when:
 *   - No templates are registered.
 *   - Every refreshable entry is either uninstalled or in-sync.
 *   - The registry cannot be enumerated (best-effort — never throws).
 *
 * Entries with `updateStrategy: 'immutable'` or `'diff-prompt'` are
 * skipped (see {@link REFRESHABLE_STRATEGIES}). Entries that are not yet
 * installed (`getInstalledStatus(...).installed === false`) are also
 * skipped — installation is a separate lifecycle event.
 *
 * This function MUST NOT throw — all errors collapse to `[]`.
 *
 * @param projectRoot - Absolute path to the project root to probe.
 * @returns Array of drift proposals (empty when no action is required).
 *
 * @task T9895
 */
export async function detectTemplateDrift(projectRoot: string): Promise<Tier2Proposal[]> {
  let entries: readonly TemplateManifestEntry[];
  try {
    entries = getTemplateManifest();
  } catch {
    return [];
  }

  const proposals: Tier2Proposal[] = [];
  for (const entry of entries) {
    if (!REFRESHABLE_STRATEGIES.has(entry.updateStrategy)) continue;
    if (!isDrifted(entry, projectRoot)) continue;
    proposals.push(buildProposal(entry));
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
 * Run the template-drift detector with sentient gating applied.
 *
 * Steps:
 *   1. Honour the kill-switch — abort before any side effect.
 *   2. Run the detector. If it returns `[]`, return outcome `'no-drift'`.
 *   3. When proposals are generated, honour `tier2Enabled` — the proposals
 *      are returned to the caller either way, but the outcome discriminant
 *      marks whether persistence is permitted.
 *
 * This wrapper NEVER throws — all errors collapse to an `'error'` outcome.
 *
 * @param options - See {@link TemplateDriftScanOptions}.
 * @returns {@link TemplateDriftScanOutcome}.
 *
 * @task T9895
 */
export async function safeRunTemplateDriftScan(
  options: TemplateDriftScanOptions,
): Promise<TemplateDriftScanOutcome> {
  try {
    const isKilled = options.isKilled ?? (() => defaultIsKilled(options.statePath));
    if (await isKilled()) {
      return {
        kind: 'killed',
        proposals: [],
        detail: 'killSwitch active — template drift scan skipped',
      };
    }

    const detect = options.detect ?? detectTemplateDrift;
    const proposals = await detect(options.projectRoot);

    if (proposals.length === 0) {
      return {
        kind: 'no-drift',
        proposals: [],
        detail: 'no installed template differs from its source',
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
      kind: 'drifted',
      proposals,
      detail: `${proposals.length} template(s) drifted from source`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      proposals: [],
      detail: `template drift scan threw: ${message}`,
    };
  }
}
