/**
 * AC-coverage gate — the load-bearing IVTR-closure piece.
 *
 * Runs inside `cleo complete <tid>` BEFORE the status flip and refuses to
 * mark a task done when any acceptance criterion has zero
 * `evidence_ac_bindings` rows pointing at it. Closes the rubber-stamp
 * loophole that let workers complete tasks whose ACs were never tied to
 * evidence.
 *
 * # Binding semantics
 *
 * An AC is "covered" when at least one of the following kinds of binding
 * row exists for its `ac_id`:
 *   - `direct`    — Worker's own evidence atom emitted by the owning task
 *   - `satisfies` — Cross-task atom via ADR-079-r2 `satisfies:<task>#<ac>`
 *   - `coverage`  — Validator-computed transitive coverage marker
 *
 * All three counts contribute equally. Per ADR-079-r4 §3.
 *
 * # Override paths
 *
 * The gate is hard: programmatic evidence is the canonical satisfaction
 * path. Two audited override paths exist for legitimate exceptions:
 *   1. `--waive-ac "<csv>" --waive-reason "<text>"` — per-AC waiver
 *      logged to `.cleo/audit/ac-waiver.jsonl`. Waivers are scoped to a
 *      single `cleo complete` call; the unsatisfied AC list is
 *      recomputed AFTER applying the waiver set so partially-waived
 *      tasks fail when any AC is left unaddressed.
 *   2. `CLEO_OWNER_OVERRIDE=1` (+ `CLEO_OWNER_OVERRIDE_REASON=<text>`)
 *      — full bypass logged to `.cleo/audit/force-bypass.jsonl` per
 *      existing convention (ADR-051 §6.2).
 *
 * # Tasks with zero ACs
 *
 * The gate is a no-op for tasks that declare zero acceptance criteria
 * — nothing to satisfy means nothing to enforce. Operators that want
 * "every task must have ACs" should turn on the existing
 * `enforcement.acceptance.mode='block'` config knob, which fires
 * earlier in the pipeline.
 *
 * # Transactional safety
 *
 * The coverage check is run as a pre-condition inside the caller's
 * transaction context, BEFORE any state mutation. The DB read uses the
 * same accessor handle as the subsequent writes so SQLite snapshot
 * isolation pins the AC + binding rows for the duration of the
 * completion call.
 *
 * @task T10509
 * @saga T10377 (SG-IVTR-AC-BINDING)
 * @epic T10381 (E-AC-MIGRATION)
 * @adr ADR-079-r4
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// AcBindingRow is the shape returned by accessor.getAcBindings — kept as a
// type-only import for forward use by callers that build helpers on top of
// `computeAcCoverage`. The current implementation only needs the `acId` field
// (cardinality, not type), so the import is consumed transitively via the
// accessor signature rather than locally. Importing it here pins the public
// contract surface so a downstream re-export stays type-safe.
import type { AcBindingRow as _AcBindingRow, AcRow, DataAccessor } from '@cleocode/contracts';

/**
 * Re-export so consumers of this module can pull the binding row shape
 * without depending directly on `@cleocode/contracts`. Keeps the dispatch
 * boundary thin per the SG-ARCH-SOLID contracts-fan-out invariant.
 */
export type AcBindingRow = _AcBindingRow;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-AC envelope returned on the `unsatisfied` array when the gate
 * rejects completion. Powers the CLI message + JSON details payload.
 */
export interface UnsatisfiedAc {
  /** UUIDv4 of the acceptance-criterion row. */
  acId: string;
  /** Display alias — `AC<ordinal>`. */
  alias: string;
  /** Verbatim AC text from `task_acceptance_criteria.text`. */
  text: string;
}

/**
 * Outcome of the AC-coverage check.
 *
 * `ok=true` when every AC has at least one binding (or when the task
 * declared zero ACs). `ok=false` carries the offenders so the caller
 * can shape the structured error.
 */
export type AcCoverageResult =
  | { ok: true }
  | {
      ok: false;
      unsatisfied: UnsatisfiedAc[];
    };

/**
 * Result of resolving caller-supplied `--waive-ac` tokens against the
 * task's actual AC rows. Powers the audit-log payload and the post-
 * waiver coverage recompute.
 */
export interface ResolvedWaivers {
  /** AC UUIDs that the operator explicitly waived. */
  acIds: string[];
  /** Display aliases of the waived ACs (`AC<ordinal>`). */
  aliases: string[];
  /** Verbatim AC texts captured at audit time for forensic traceability. */
  texts: string[];
  /** Tokens that did NOT resolve to any AC on the task. */
  unresolved: string[];
}

// ---------------------------------------------------------------------------
// Coverage check
// ---------------------------------------------------------------------------

/**
 * Compute coverage for a task. Returns `{ok:true}` when every AC has
 * at least one binding OR the task declared zero ACs; otherwise
 * `{ok:false}` with the offending AC rows.
 *
 * @param taskId - The task being completed.
 * @param accessor - DataAccessor used for the AC + binding reads.
 * @returns Coverage outcome.
 */
export async function computeAcCoverage(
  taskId: string,
  accessor: DataAccessor,
): Promise<AcCoverageResult> {
  const acRows = await accessor.getAcRows(taskId);
  if (acRows.length === 0) {
    // No ACs → nothing to cover. Operators that want "every task must
    // have ACs" should set `enforcement.acceptance.mode='block'`.
    return { ok: true };
  }

  const acIds = acRows.map((r) => r.id);
  const bindings = await accessor.getAcBindings(acIds);

  // Build the "covered" set — an AC is covered when AT LEAST ONE binding
  // row has its `ac_id`. All three binding kinds (direct, satisfies,
  // coverage) count equally per ADR-079-r4 §3.
  const covered = new Set<string>();
  for (const b of bindings) {
    covered.add(b.acId);
  }

  const unsatisfied = acRows
    .filter((r) => !covered.has(r.id))
    .map<UnsatisfiedAc>((r) => ({
      acId: r.id,
      alias: `AC${r.ordinal}`,
      text: r.text,
    }));

  if (unsatisfied.length === 0) return { ok: true };
  return { ok: false, unsatisfied };
}

// ---------------------------------------------------------------------------
// Waiver resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the comma-separated `--waive-ac` token list against the
 * task's AC rows. Tokens may be:
 *   - A canonical UUIDv4 (`task_acceptance_criteria.id`)
 *   - A display alias (`AC<ordinal>`)
 *
 * Tokens that resolve to neither are surfaced on `unresolved` so the
 * caller can warn — they are NOT silently dropped, but they also do
 * not fail the gate by themselves. The caller decides.
 *
 * @param waiveCsv - Comma-separated token list (may be empty / undefined).
 * @param acRows - The task's AC rows (from `accessor.getAcRows`).
 * @returns Resolved waiver descriptor.
 */
export function resolveWaivers(
  waiveCsv: string | undefined,
  acRows: readonly AcRow[],
): ResolvedWaivers {
  if (waiveCsv === undefined || waiveCsv.trim().length === 0) {
    return { acIds: [], aliases: [], texts: [], unresolved: [] };
  }

  const tokens = waiveCsv
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const byUuid = new Map<string, AcRow>();
  const byAlias = new Map<string, AcRow>();
  for (const row of acRows) {
    byUuid.set(row.id.toLowerCase(), row);
    byAlias.set(`AC${row.ordinal}`.toLowerCase(), row);
  }

  const acIds: string[] = [];
  const aliases: string[] = [];
  const texts: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const key = token.toLowerCase();
    const row = byUuid.get(key) ?? byAlias.get(key);
    if (row === undefined) {
      unresolved.push(token);
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    acIds.push(row.id);
    aliases.push(`AC${row.ordinal}`);
    texts.push(row.text);
  }

  return { acIds, aliases, texts, unresolved };
}

/**
 * Subtract a waiver set from an unsatisfied list. Returns the residual
 * unsatisfied ACs. When the residual is empty, the gate passes; when
 * non-empty the caller surfaces `E_AC_COVERAGE_INCOMPLETE` with the
 * residual.
 *
 * @param unsatisfied - From {@link computeAcCoverage}.
 * @param waivedAcIds - Set of canonical AC UUIDs the operator waived.
 * @returns Residual unsatisfied list (ACs not covered AND not waived).
 */
export function applyWaivers(
  unsatisfied: readonly UnsatisfiedAc[],
  waivedAcIds: ReadonlySet<string>,
): UnsatisfiedAc[] {
  if (waivedAcIds.size === 0) return [...unsatisfied];
  return unsatisfied.filter((u) => !waivedAcIds.has(u.acId));
}

// ---------------------------------------------------------------------------
// Audit-log writers
// ---------------------------------------------------------------------------

/**
 * One row in `.cleo/audit/ac-waiver.jsonl` — appended whenever a caller
 * supplies `--waive-ac` with a reason. The schema is intentionally flat
 * for grep-friendly post-mortem analysis.
 */
export interface AcWaiverAuditEntry {
  /** ISO-8601 timestamp the waiver was recorded. */
  timestamp: string;
  /** Task that was completed under the waiver. */
  taskId: string;
  /** AC UUIDs that were waived (subset of the task's AC set). */
  waivedAcs: string[];
  /** Display aliases (`AC<n>`) — duplicates `waivedAcs` semantically but is grep-friendly. */
  waivedAliases: string[];
  /** Operator-supplied justification text. Mandatory. */
  reason: string;
  /** Agent / user identity that performed the completion. */
  actor: string;
  /** Tokens passed to `--waive-ac` that did NOT resolve to any AC. */
  unresolvedTokens: string[];
}

/**
 * Append a single waiver entry to `.cleo/audit/ac-waiver.jsonl`. Creates
 * the audit directory on first use. Errors propagate — failure to write
 * the audit row MUST block the completion since the audit trail is the
 * forensic guarantee that backs the override.
 *
 * @param entry - Pre-built audit entry.
 * @param projectRoot - Absolute path to the project root.
 */
export async function appendAcWaiverAudit(
  entry: AcWaiverAuditEntry,
  projectRoot: string,
): Promise<void> {
  const auditDir = join(projectRoot, '.cleo', 'audit');
  await mkdir(auditDir, { recursive: true });
  const filePath = join(auditDir, 'ac-waiver.jsonl');
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(filePath, line, { encoding: 'utf8' });
}

/**
 * One row in `.cleo/audit/force-bypass.jsonl` written when an operator
 * sets `CLEO_OWNER_OVERRIDE=1` to bypass the AC-coverage gate entirely.
 * Mirrors the existing `ForceBypassRecord` shape from `gate-audit.ts`
 * (T832) so the same downstream tools can read both. The `kind` field
 * discriminates AC-coverage entries from the existing evidence-gate
 * entries.
 */
export interface AcCoverageForceBypassEntry {
  /** Discriminator — `'ac-coverage'` for this gate. */
  kind: 'ac-coverage';
  /** ISO-8601 timestamp of the bypass. */
  timestamp: string;
  /** Task that was completed under the override. */
  taskId: string;
  /** Operator-supplied justification (from `CLEO_OWNER_OVERRIDE_REASON`). */
  reason: string;
  /** Agent / user identity that performed the completion. */
  actor: string;
  /** Unsatisfied ACs that were skipped by the bypass — captured for post-mortem. */
  unsatisfied: UnsatisfiedAc[];
}

/**
 * Append an AC-coverage force-bypass entry to `.cleo/audit/force-bypass.jsonl`.
 * Re-uses the canonical force-bypass log per ADR-051 §6.2; the `kind`
 * discriminator on the entry distinguishes AC-coverage bypasses from
 * existing evidence-gate bypasses.
 *
 * Errors propagate — like {@link appendAcWaiverAudit} the audit trail
 * is load-bearing.
 *
 * @param entry - Pre-built audit entry.
 * @param projectRoot - Absolute path to the project root.
 */
export async function appendAcCoverageForceBypass(
  entry: AcCoverageForceBypassEntry,
  projectRoot: string,
): Promise<void> {
  const auditDir = join(projectRoot, '.cleo', 'audit');
  await mkdir(auditDir, { recursive: true });
  const filePath = join(auditDir, 'force-bypass.jsonl');
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(filePath, line, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Owner-override env helpers
// ---------------------------------------------------------------------------

/**
 * Inspect the runtime env for the canonical `CLEO_OWNER_OVERRIDE=1`
 * + `CLEO_OWNER_OVERRIDE_REASON=<text>` pair. Returns the reason when
 * BOTH are present; returns `null` when override is off or the reason
 * is missing/blank.
 *
 * Centralised here so the gate, the audit writer, and the dispatch
 * layer agree on the exact semantics. Mirrors the convention used by
 * `gate-audit.ts`.
 */
export function readOwnerOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = env['CLEO_OWNER_OVERRIDE'];
  if (flag !== '1' && flag !== 'true') return null;
  const reason = env['CLEO_OWNER_OVERRIDE_REASON'];
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
