/**
 * Shared-evidence tracking for batch verify calls (T1502 / P0-6).
 *
 * When the same evidence atom (e.g. `commit:<sha>`, `tool:<name>`) is applied
 * to more than 3 distinct tasks within a session, the verifier must:
 *
 *   - **Without `--shared-evidence`**: emit a warning to stderr and log
 *     `sharedAtomWarning: true` to force-bypass.jsonl.  In strict mode
 *     (`CLEO_STRICT_EVIDENCE=1` or when called from CI), reject with
 *     `E_SHARED_EVIDENCE_FLAG_REQUIRED`.
 *   - **With `--shared-evidence`**: accept silently and log
 *     `sharedEvidence: true` to force-bypass.jsonl.
 *
 * Atom usage is persisted in `.cleo/audit/shared-evidence-recent.jsonl` (a
 * rolling append-only log) so the check works across CLI invocations.  Only
 * atoms from the current session are considered; entries from older sessions
 * are ignored.
 *
 * @adr ADR-059
 * @task T1502
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of distinct tasks a single evidence atom may close before the
 *  shared-evidence warning / rejection is triggered (T1502 / P0-6). */
export const SHARED_EVIDENCE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Atom key extraction
// ---------------------------------------------------------------------------

/**
 * Derive a canonical key from a raw evidence atom string.
 *
 * Examples:
 *   `commit:abc123def456` → `commit:abc123def456`
 *   `tool:pnpm-test`     → `tool:pnpm-test`
 *   `files:a.ts,b.ts`   → `files:a.ts,b.ts`
 *
 * @param atomStr - Raw atom string (before semicolon splitting).
 * @returns Trimmed lower-case canonical key.
 *
 * @task T1502
 */
export function atomKey(atomStr: string): string {
  return atomStr.trim().toLowerCase();
}

/**
 * Extract all atom keys from a semicolon-separated evidence string.
 *
 * @param evidence - Raw `--evidence` value, e.g.
 *   `"commit:abc;files:a.ts,b.ts;tool:pnpm-test"`.
 * @returns Array of canonical atom keys.
 *
 * @task T1502
 */
export function extractAtomKeys(evidence: string): string[] {
  return evidence
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(atomKey);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** One entry in the rolling shared-evidence log. */
interface SharedEvidenceEntry {
  /** Session ID this atom was used in. */
  sessionId: string;
  /** Canonical atom key (e.g. `commit:abc123`). */
  atomKey: string;
  /** Task ID that was verified using this atom. */
  taskId: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

/**
 * Resolve the path of the shared-evidence rolling log.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to `.cleo/audit/shared-evidence-recent.jsonl`.
 *
 * @task T1502
 */
export function getSharedEvidencePath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'audit', 'shared-evidence-recent.jsonl');
}

/**
 * Read the shared-evidence rolling log and build a map of
 * `atomKey → Set<taskId>` for a given session.
 *
 * Entries from other sessions are ignored.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Session ID to filter by.
 * @returns Map from atom key to the set of task IDs that used it.
 *
 * @task T1502
 */
export function readAtomUsageMap(projectRoot: string, sessionId: string): Map<string, Set<string>> {
  const path = getSharedEvidencePath(projectRoot);
  const result = new Map<string, Set<string>>();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return result; // File absent — no prior usage.
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as SharedEvidenceEntry).sessionId !== 'string' ||
      typeof (entry as SharedEvidenceEntry).atomKey !== 'string' ||
      typeof (entry as SharedEvidenceEntry).taskId !== 'string'
    ) {
      continue;
    }
    const e = entry as SharedEvidenceEntry;
    if (e.sessionId !== sessionId) continue;

    const tasks = result.get(e.atomKey) ?? new Set<string>();
    tasks.add(e.taskId);
    result.set(e.atomKey, tasks);
  }

  return result;
}

/**
 * Append an atom-usage entry to the shared-evidence log.
 *
 * Errors are swallowed — log writes must not block the verify operation.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Session ID.
 * @param key - Canonical atom key.
 * @param taskId - Task ID being verified.
 *
 * @task T1502
 */
export function appendAtomUsage(
  projectRoot: string,
  sessionId: string,
  key: string,
  taskId: string,
): void {
  try {
    const path = getSharedEvidencePath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    const entry: SharedEvidenceEntry = {
      sessionId,
      atomKey: key,
      taskId,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    // Non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Detection result
// ---------------------------------------------------------------------------

/** Result of the shared-evidence check. */
export interface SharedEvidenceCheckResult {
  /**
   * True when at least one atom in the evidence string has been used across
   * more than `SHARED_EVIDENCE_THRESHOLD` distinct tasks this session.
   */
  triggered: boolean;
  /** The atom key(s) that triggered the check. */
  triggeredAtoms: string[];
  /** Total distinct tasks the first triggered atom has been applied to. */
  taskCount: number;
}

// ---------------------------------------------------------------------------
// Main check + record function
// ---------------------------------------------------------------------------

/**
 * Check whether any evidence atom in `evidence` has been applied to more than
 * `SHARED_EVIDENCE_THRESHOLD` distinct tasks in this session, then append the
 * current taskId to the usage log.
 *
 * This function reads the rolling log, detects collisions, appends entries for
 * the current write, and returns a result describing whether the check was
 * triggered.  The caller decides how to act (warn / reject / accept).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID.
 * @param taskId - Task being verified now.
 * @param evidence - Raw evidence string from `--evidence`.
 * @returns Check result indicating whether the threshold was exceeded.
 *
 * @task T1502
 * @adr ADR-059
 */
export function checkAndRecordSharedEvidence(
  projectRoot: string,
  sessionId: string,
  taskId: string,
  evidence: string,
): SharedEvidenceCheckResult {
  const keys = extractAtomKeys(evidence);
  const usageMap = readAtomUsageMap(projectRoot, sessionId);

  const triggeredAtoms: string[] = [];
  let maxTaskCount = 0;

  for (const key of keys) {
    // Fetch existing task set (before adding current taskId).
    const existing = usageMap.get(key) ?? new Set<string>();
    // Count tasks excluding the current one (we check whether *previous* uses
    // already reached the threshold, because the current task is about to be
    // added now).
    const prevCount = existing.has(taskId) ? existing.size : existing.size;
    if (prevCount >= SHARED_EVIDENCE_THRESHOLD) {
      triggeredAtoms.push(key);
      if (prevCount > maxTaskCount) maxTaskCount = prevCount;
    }
  }

  // Append usage entries for the current write.
  for (const key of keys) {
    appendAtomUsage(projectRoot, sessionId, key, taskId);
  }

  return {
    triggered: triggeredAtoms.length > 0,
    triggeredAtoms,
    taskCount: maxTaskCount,
  };
}

// ---------------------------------------------------------------------------
// Enforce function (used by validate-engine)
// ---------------------------------------------------------------------------

/** Result of the shared-evidence enforcement gate. */
export interface SharedEvidenceEnforceResult {
  /** Whether the verify operation may proceed. */
  allowed: boolean;
  /** Error code when rejected (strict mode). */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
  /** True when the warning was emitted (non-strict mode). */
  warned?: boolean;
  /** True when `--shared-evidence` was provided and the check was acknowledged. */
  acknowledged?: boolean;
}

/**
 * Enforce shared-evidence policy for a gate write.
 *
 * - Calls {@link checkAndRecordSharedEvidence} to detect threshold exceedance.
 * - If triggered and `sharedEvidenceFlag` is true: allow + return
 *   `{ acknowledged: true }`.
 * - If triggered and flag is false:
 *   - Non-strict mode (`CLEO_STRICT_EVIDENCE` absent): allow + return
 *     `{ warned: true }`, emit warning to stderr.
 *   - Strict mode (`CLEO_STRICT_EVIDENCE=1`): reject with
 *     `E_SHARED_EVIDENCE_FLAG_REQUIRED`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param sessionId - Active session ID.
 * @param taskId - Task being verified.
 * @param evidence - Raw evidence string.
 * @param sharedEvidenceFlag - Whether `--shared-evidence` was passed.
 * @returns Enforcement result.
 *
 * @task T1502
 * @adr ADR-059
 */
export function enforceSharedEvidence(
  projectRoot: string,
  sessionId: string,
  taskId: string,
  evidence: string,
  sharedEvidenceFlag: boolean,
): SharedEvidenceEnforceResult {
  const check = checkAndRecordSharedEvidence(projectRoot, sessionId, taskId, evidence);

  if (!check.triggered) {
    return { allowed: true };
  }

  const atomList = check.triggeredAtoms.join(', ');

  if (sharedEvidenceFlag) {
    // Acknowledged — proceed silently.
    return { allowed: true, acknowledged: true };
  }

  const strictMode =
    process.env['CLEO_STRICT_EVIDENCE'] === '1' || process.env['CLEO_STRICT_EVIDENCE'] === 'true';

  if (strictMode) {
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_SHARED_EVIDENCE_FLAG_REQUIRED,
      errorMessage:
        `Evidence atom(s) [${atomList}] have already been applied to ` +
        `${check.taskCount}+ distinct tasks in this session (threshold: ${SHARED_EVIDENCE_THRESHOLD}). ` +
        `In strict mode (CLEO_STRICT_EVIDENCE=1), you must pass --shared-evidence to acknowledge ` +
        `batch reuse. This prevents accidental copy-paste evidence across unrelated tasks.`,
    };
  }

  // Non-strict: warn and allow.
  process.stderr.write(
    `[CLEO WARN] Shared evidence atom(s) [${atomList}] applied to >3 tasks in this session. ` +
      `Pass --shared-evidence to suppress this warning. In CI (CLEO_STRICT_EVIDENCE=1) this will become a hard reject.\n`,
  );

  return { allowed: true, warned: true };
}
