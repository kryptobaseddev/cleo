/**
 * Core business logic for `cleo verify --explain` (T1013 / ADR-051 §2.3).
 *
 * Extracted from the CLI dispatch layer (packages/cleo) per ADR-057 D3:
 * "CLI is thin transport — domain logic lives in Core."
 *
 * {@link checkExplainVerification} accepts the raw gate-status view produced
 * by `validateGateVerify` and enriches it with:
 *   - `gates[]`   — per-gate `{name, state, timestamp}` records
 *   - `evidence[]`— per-gate evidence atoms with re-validation status
 *   - `blockers[]`— human-readable reasons why `cleo complete` cannot run
 *   - `explanation`— multi-line text summary for human-readable output
 *
 * The dispatch handler in `packages/cleo/src/dispatch/domains/check.ts` is a
 * thin wrapper: it calls `validateGateVerify`, checks the error, then
 * delegates all rendering to this function.
 *
 * @task T1541
 * @task T1013
 * @task T1006
 * @adr ADR-051
 * @adr ADR-057
 */

import type { EvidenceAtom, GateEvidence } from '@cleocode/contracts';
import { checkRevalidateEvidence } from '../../validation/ops.js';

// ---------------------------------------------------------------------------
// Input shape — matches the raw.data coming out of validateGateVerify
// (view mode: no gate / all / reset).
// ---------------------------------------------------------------------------

/**
 * Raw gate-status data produced by `validateGateVerify` in view mode.
 * This is the shape of `raw.data` after a successful no-op call.
 */
export interface GateStatusRawData {
  taskId: string;
  title?: string;
  status?: string;
  verification?: {
    passed: boolean;
    round: number;
    gates: Record<string, boolean>;
    evidence?: Record<string, unknown>;
    failureLog?: unknown[];
    lastUpdated?: string | null;
  };
  requiredGates?: string[];
  missingGates?: string[];
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/**
 * Per-gate state record included in the explain response.
 */
export interface GateStateRecord {
  /** Gate name (e.g. `"implemented"`, `"testsPassed"`). */
  name: string;
  /** `"pass"` | `"fail"` | `"pending"` */
  state: 'pass' | 'fail' | 'pending';
  /** ISO 8601 timestamp of the last update, or `null` if not yet captured. */
  timestamp: string | null;
}

/**
 * Per-gate evidence entry included in the explain response.
 */
export interface EvidenceEntry {
  /** Gate this evidence backs. */
  gate: string;
  /** Evidence atoms for this gate. */
  atoms: EvidenceAtom[];
  /** ISO 8601 timestamp when evidence was captured. */
  capturedAt: string;
  /** Agent that captured the evidence. */
  capturedBy: string;
  /** True when CLEO_OWNER_OVERRIDE was used. */
  override: boolean;
  /** Whether the evidence still matches filesystem / git state. */
  stillValid: boolean;
  /** Atoms that failed re-validation, with the failure reason. */
  failedAtoms: Array<{ kind: EvidenceAtom['kind']; reason: string }>;
}

/**
 * Full explain result returned by {@link checkExplainVerification}.
 */
export interface ExplainVerificationResult {
  taskId: string;
  title: string | undefined;
  status: string | undefined;
  passed: boolean;
  round: number;
  /** Per-gate `{name, state, timestamp}` array (T1013). */
  gates: GateStateRecord[];
  /** Per-gate evidence with re-validation status (T1013). */
  evidence: EvidenceEntry[];
  /** Human-readable blockers preventing `cleo complete` (T1013). */
  blockers: string[];
  /** Back-compat: raw gate pass/fail map from the DB. */
  gatesMap: Record<string, boolean>;
  /** Back-compat: raw evidence map from the DB. */
  evidenceMap: Record<string, unknown>;
  requiredGates: string[];
  missingGates: string[];
  /** Multi-line text summary for human-readable output. */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Helper: normalise evidence to canonical GateEvidence shape
// ---------------------------------------------------------------------------

/**
 * Normalises a raw DB evidence entry (may be a legacy atom array or a modern
 * GateEvidence object) into the canonical form required for re-validation.
 *
 * @internal
 */
function normaliseGateEvidence(
  raw: unknown,
  lastUpdated: string | null,
): {
  atoms: EvidenceAtom[];
  capturedAt: string;
  capturedBy: string;
  override?: boolean;
} | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    // Legacy format: bare atom array.
    return {
      atoms: raw as EvidenceAtom[],
      capturedAt: lastUpdated ?? '',
      capturedBy: 'unknown',
    };
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['atoms'])) {
      // Modern GateEvidence object.
      return {
        atoms: obj['atoms'] as EvidenceAtom[],
        capturedAt: (obj['capturedAt'] as string) ?? lastUpdated ?? '',
        capturedBy: (obj['capturedBy'] as string) ?? 'unknown',
        override: obj['override'] === true,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: build human-readable atom description
// ---------------------------------------------------------------------------

/**
 * Returns a short `"kind:payload"` description for a single evidence atom.
 *
 * @internal
 */
function describeAtom(atom: EvidenceAtom): string {
  const a = atom as Record<string, unknown>;
  const kind = a['kind'] as string;
  const payload =
    a['sha'] ??
    a['shortSha'] ??
    a['tool'] ??
    a['url'] ??
    a['note'] ??
    a['path'] ??
    a['value'] ??
    '';
  return kind ? `${kind}:${payload}` : String(atom);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Builds the enriched verify-explain response from a raw gate-status snapshot.
 *
 * This is the Core business logic for `cleo verify --explain` (T1013).  The
 * CLI dispatch handler calls `validateGateVerify` to get `rawData`, validates
 * it did not error, then delegates all rendering to this function.
 *
 * @param rawData    Raw data from a `validateGateVerify` view-mode call.
 * @param projectRoot Absolute path to the project root (needed for re-validation).
 * @param taskId     Task ID (used in blocker messages).
 * @returns A fully-populated {@link ExplainVerificationResult}.
 *
 * @task T1541
 * @task T1013
 * @adr ADR-051
 * @adr ADR-057
 */
// SSoT-EXEMPT:positional-rawData — pre-struct wrapper, positional args retained for call-site compat
export async function checkExplainVerification(
  rawData: GateStatusRawData,
  projectRoot: string,
  taskId: string,
): Promise<ExplainVerificationResult> {
  const gatesObj = rawData.verification?.gates ?? {};
  const evidenceObj = (rawData.verification?.evidence ?? {}) as Record<string, unknown>;
  const requiredGates = rawData.requiredGates ?? [];
  const missingGates = rawData.missingGates ?? [];
  const lastUpdated = rawData.verification?.lastUpdated ?? null;

  // ---- Build gates[] array ------------------------------------------------
  const gatesArray: GateStateRecord[] = requiredGates.map((gate) => {
    const v = gatesObj[gate];
    const state: 'pass' | 'fail' | 'pending' =
      v === true ? 'pass' : v === false ? 'fail' : 'pending';
    const evidenceEntry = evidenceObj[gate];
    const capturedAt =
      evidenceEntry && typeof evidenceEntry === 'object' && !Array.isArray(evidenceEntry)
        ? ((evidenceEntry as { capturedAt?: string })['capturedAt'] ?? null)
        : null;
    const timestamp = capturedAt ?? (state === 'pending' ? null : lastUpdated);
    return { name: gate, state, timestamp };
  });

  // ---- Build evidence[] with re-validation --------------------------------
  const evidenceArray: EvidenceEntry[] = [];
  const staleGates: string[] = [];

  for (const gate of requiredGates) {
    const normalised = normaliseGateEvidence(evidenceObj[gate], lastUpdated);
    if (!normalised) continue;

    let stillValid = true;
    let failedAtoms: EvidenceEntry['failedAtoms'] = [];
    try {
      const reval = await checkRevalidateEvidence(projectRoot, {
        evidence: {
          atoms: normalised.atoms,
          capturedAt: normalised.capturedAt,
          capturedBy: normalised.capturedBy,
          override: normalised.override,
        } as GateEvidence,
      });
      stillValid = reval.stillValid;
      failedAtoms = reval.failedAtoms.map((f) => ({
        kind: f.atom.kind,
        reason: f.reason,
      }));
    } catch {
      // Re-validation failure is non-fatal — treat as still valid.
      stillValid = true;
      failedAtoms = [];
    }

    if (!stillValid) {
      staleGates.push(gate);
    }

    evidenceArray.push({
      gate,
      atoms: normalised.atoms,
      capturedAt: normalised.capturedAt,
      capturedBy: normalised.capturedBy,
      override: normalised.override === true,
      stillValid,
      failedAtoms,
    });
  }

  // ---- Build blockers[] ---------------------------------------------------
  const blockers: string[] = [];
  for (const g of missingGates) {
    blockers.push(
      `Gate '${g}' is not yet passing — run \`cleo verify ${taskId} --gate ${g} --evidence …\``,
    );
  }
  for (const g of staleGates) {
    const entry = evidenceArray.find((e) => e.gate === g);
    const firstFailure = entry?.failedAtoms[0]?.reason ?? 'evidence re-validation failed';
    blockers.push(`Gate '${g}' evidence is stale: ${firstFailure} (E_EVIDENCE_STALE)`);
  }
  if (rawData.status === 'done') {
    blockers.push(`Task ${taskId} is already done — verification is locked (ADR-051 §11.1)`);
  }

  // ---- Build human-readable explanation -----------------------------------
  const gateLines = requiredGates.map((gate) => {
    const passed = gatesObj[gate] === true;
    const entry = evidenceArray.find((e) => e.gate === gate);
    const atomDesc =
      entry && entry.atoms.length > 0
        ? entry.atoms.map(describeAtom).join(', ')
        : 'no evidence recorded';
    const staleTag = entry && !entry.stillValid ? ' [STALE]' : '';
    return `  ${passed ? 'PASS' : 'FAIL'} [${gate}]${staleTag} — ${atomDesc}`;
  });

  const overallVerdict = rawData.verification?.passed
    ? staleGates.length > 0
      ? `BLOCKED — ${staleGates.length} gate(s) have stale evidence`
      : 'All required gates PASSED'
    : `PENDING — ${missingGates.length} gate(s) not yet passing: ${missingGates.join(', ')}`;

  const explanation = [
    `Task: ${rawData.taskId}${rawData.title ? ` — ${rawData.title}` : ''}`,
    `Status: ${rawData.status ?? 'unknown'} | Verification round: ${rawData.verification?.round ?? 0}`,
    ``,
    `Gate breakdown:`,
    ...gateLines,
    ``,
    `Verdict: ${overallVerdict}`,
  ].join('\n');

  return {
    taskId: rawData.taskId,
    title: rawData.title,
    status: rawData.status,
    passed: rawData.verification?.passed ?? false,
    round: rawData.verification?.round ?? 0,
    gates: gatesArray,
    evidence: evidenceArray,
    blockers,
    gatesMap: gatesObj,
    evidenceMap: evidenceObj,
    requiredGates,
    missingGates,
    explanation,
  };
}
