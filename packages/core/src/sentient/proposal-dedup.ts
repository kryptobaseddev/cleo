/**
 * Per-parent Proposal Deduplication Gate (T1592).
 *
 * Prevents the T1555-style burst failure mode where the sentient proposer
 * runs twice on the same audit output and creates near-identical pairs of
 * proposed tasks (e.g. T1544/T1550, T1545/T1551, ...).
 *
 * Strategy
 * --------
 * Before {@link transactionalInsertProposal} is called, the propose tick
 * computes a stable `dedupHash` from
 *
 *   sha256(`${normalizedParentId}${normalizedTitle}${normalizedRationale}`)
 *
 * where `normalize = lowercase + strip punctuation + collapse whitespace`.
 *
 * The hash is then checked against existing tier-2 proposals in tasks.db
 * within a 24-hour window:
 *   - parent scope: same `parent_id` (or "<root>" if both null) AND same hash
 *   - timestamp window: `created_at >= datetime('now', '-1 day')`
 *   - tier-2 only: `labels_json LIKE '%sentient-tier2%'`
 *
 * If a match is found the proposal is REJECTED, the rejection is appended
 * to `.cleo/audit/sentient-dedup.jsonl`, and the candidate is dropped.
 *
 * If no match is found the hash is embedded into `tasks.notes_json` (as part
 * of the existing `proposal-meta` envelope, see {@link ProposedTaskMeta}) and
 * future ticks will see it via the same query path. This avoids a schema
 * migration — the existing proposal-meta JSON is the single source of truth.
 *
 * @task T1592 (Foundation Lockdown · Wave A · Worker 4)
 * @see ADR-054 — Sentient Loop Tier-2
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SENTIENT_TIER2_TAG } from './proposal-rate-limiter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path (relative to projectRoot) of the dedup-rejection audit log. */
export const SENTIENT_DEDUP_AUDIT_FILE = '.cleo/audit/sentient-dedup.jsonl';

/**
 * Default look-back window for dedup checks, in hours.
 * Mirrors the wording of T1592: "within last 24h".
 */
export const DEFAULT_DEDUP_WINDOW_HOURS = 24;

/**
 * Sentinel token used in place of a NULL parentId so that the hash key is
 * always defined. Must NEVER appear as a real task ID.
 */
const NULL_PARENT_SENTINEL = '<root>';

/**
 * Field separator (ASCII SOH) — chosen so it cannot appear in normalized
 * text (which is alnum + single spaces). Prevents collisions like
 * `("ab", "cd")` vs `("a", "bcd")`.
 */
const FIELD_SEP = '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs for {@link computeDedupHash}. */
export interface DedupHashInput {
  /** Parent task ID. `null` / `undefined` are coerced to a sentinel. */
  parentId: string | null | undefined;
  /** Proposal title (will be normalized). */
  title: string;
  /**
   * Proposal acceptance criteria, rationale, or description.
   * The mission spec calls this `normalizedAcceptance`; for the Tier-2
   * proposer this is the `rationale` field of {@link ProposalCandidate}.
   */
  acceptance: string;
}

/** Outcome of {@link checkDedupCollision}. */
export interface DedupCheckResult {
  /** `true` when a dup is detected and the proposal MUST be skipped. */
  isDuplicate: boolean;
  /** When `isDuplicate=true`, the existing task ID that owns the matching hash. */
  existingTaskId?: string;
  /** Stable dedup hash regardless of outcome (callers persist it on insert). */
  dedupHash: string;
}

/** Persisted shape inside `.cleo/audit/sentient-dedup.jsonl`. */
export interface DedupRejectionRecord {
  /** ISO-8601 timestamp of the rejection. */
  timestamp: string;
  /** Reason discriminant. */
  reason: 'per-parent-dedup';
  /** The dedup hash that collided. */
  dedupHash: string;
  /** Parent task ID (null preserved in JSON for clarity). */
  parentId: string | null;
  /** The would-have-been-inserted candidate title. */
  title: string;
  /** Proposal source (brain | nexus | test). */
  source: string;
  /** External source ID (brain entry id, nexus node id, etc.). */
  sourceId: string;
  /** ID of the existing task whose hash matched. */
  existingTaskId: string;
  /** Look-back window applied, in hours. */
  windowHours: number;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a free-text field for hash-stable comparison.
 *
 * Steps (in order):
 *   1. Lower-case
 *   2. Strip every code point NOT in `[a-z0-9\s]`
 *      (Unicode-aware — accented Latin letters are stripped, matching the
 *      "strip punctuation" intent for English-language proposal titles.)
 *   3. Collapse runs of whitespace to a single space
 *   4. Trim leading/trailing whitespace
 *
 * @param raw - Input text. `null` / `undefined` become the empty string.
 * @returns Normalized form, suitable for use as a hash input segment.
 */
export function normalizeForDedup(raw: string | null | undefined): string {
  if (raw == null) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/**
 * Compute the per-parent dedup hash.
 *
 * The hash is sha-256 over `parent | title | acceptance` (all normalized,
 * separated by ``). Stable across processes and machines — same input
 * always yields the same hex digest.
 *
 * @param input - Parent + title + acceptance.
 * @returns 64-char lowercase hex sha-256 digest.
 */
export function computeDedupHash(input: DedupHashInput): string {
  const parentKey =
    input.parentId == null || input.parentId === '' ? NULL_PARENT_SENTINEL : input.parentId;
  const canonical = [
    parentKey,
    normalizeForDedup(input.title),
    normalizeForDedup(input.acceptance),
  ].join(FIELD_SEP);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Collision check (DB query)
// ---------------------------------------------------------------------------

/** Options for {@link checkDedupCollision}. */
export interface DedupCheckOptions {
  /** Open DatabaseSync handle to tasks.db. May be null (then no-op). */
  tasksDb: DatabaseSync | null;
  /** The candidate hash inputs. */
  candidate: DedupHashInput;
  /**
   * Look-back window in hours. Defaults to {@link DEFAULT_DEDUP_WINDOW_HOURS}.
   * Set to `0` to disable the time bound (useful for tests).
   */
  windowHours?: number;
}

/**
 * Query tasks.db for an existing tier-2 proposal whose
 * `notes_json` contains the same `dedupHash` AND that lives under the same
 * parent (or root scope) AND was created within the look-back window.
 *
 * The check is deliberately conservative:
 *   - parent scope: rows are filtered by `parent_id IS :parentId` (with the
 *     `<root>` sentinel mapped to `IS NULL`)
 *   - time bound: `created_at >= datetime('now', '-N hours')`
 *   - tier-2 only: `labels_json LIKE '%sentient-tier2%'`
 *   - hash match: `notes_json LIKE '%"dedupHash":"<hex>"%'` (substring match
 *     is safe — the hex digest is 64 chars of `[0-9a-f]` and cannot collide
 *     with any other JSON value).
 *
 * @param opts - Check options.
 * @returns DedupCheckResult; `isDuplicate=true` when a collision is found.
 */
export function checkDedupCollision(opts: DedupCheckOptions): DedupCheckResult {
  const dedupHash = computeDedupHash(opts.candidate);

  if (!opts.tasksDb) {
    return { isDuplicate: false, dedupHash };
  }

  const windowHours = opts.windowHours ?? DEFAULT_DEDUP_WINDOW_HOURS;
  const parentKey =
    opts.candidate.parentId == null || opts.candidate.parentId === ''
      ? null
      : opts.candidate.parentId;

  // Build the parent_id predicate.  SQLite has no parameterized "IS NULL",
  // so we branch on whether the parent is null.  Both branches use the same
  // hash + label + window predicates.
  const baseSql = `
    SELECT id
    FROM tasks
    WHERE labels_json LIKE :labelPattern
      AND notes_json  LIKE :hashPattern
      ${windowHours > 0 ? `AND datetime(created_at) >= datetime('now', :windowSpec)` : ''}
      AND ${parentKey === null ? 'parent_id IS NULL' : 'parent_id = :parentId'}
    LIMIT 1
  `;

  // The proposal-meta envelope is JSON-stringified twice (once as the meta
  // object, then again as the first element of `notes_json[]`).  As a result
  // the canonical persisted form is `\"dedupHash\":\"<hex>\"` (with escaped
  // double quotes).  The LIKE pattern below uses the bare hex digest so it
  // matches regardless of which serialization layer wrapped it — sha-256 hex
  // cannot collide with any other JSON value (64 chars of `[0-9a-f]`).
  const params: Record<string, string> = {
    labelPattern: `%${SENTIENT_TIER2_TAG}%`,
    hashPattern: `%dedupHash%${dedupHash}%`,
  };
  if (windowHours > 0) params.windowSpec = `-${windowHours} hours`;
  if (parentKey !== null) params.parentId = parentKey;

  const stmt = opts.tasksDb.prepare(baseSql);
  const row = stmt.get(params) as { id: string } | undefined;

  if (row) {
    return { isDuplicate: true, existingTaskId: row.id, dedupHash };
  }
  return { isDuplicate: false, dedupHash };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** Inputs for {@link recordDedupRejection}. */
export interface DedupRejectionInput {
  /** Project root (audit log is written under `<root>/.cleo/audit/`). */
  projectRoot: string;
  /** Parent task ID (null preserved). */
  parentId: string | null;
  /** Proposal title. */
  title: string;
  /** Source (brain | nexus | test). */
  source: string;
  /** External source ID. */
  sourceId: string;
  /** Hash that collided. */
  dedupHash: string;
  /** Existing task ID that owns the matching hash. */
  existingTaskId: string;
  /** Window applied (defaults to {@link DEFAULT_DEDUP_WINDOW_HOURS}). */
  windowHours?: number;
}

/**
 * Append a single NDJSON line to `.cleo/audit/sentient-dedup.jsonl`
 * documenting a rejected proposal.
 *
 * The directory is created if missing. The write is best-effort — failures
 * are surfaced via the returned promise (callers should `await` and log on
 * failure but MUST NOT propagate the error into the propose tick result).
 *
 * @param input - Rejection details.
 */
export async function recordDedupRejection(input: DedupRejectionInput): Promise<void> {
  const auditPath = join(input.projectRoot, SENTIENT_DEDUP_AUDIT_FILE);
  await mkdir(dirname(auditPath), { recursive: true });
  const record: DedupRejectionRecord = {
    timestamp: new Date().toISOString(),
    reason: 'per-parent-dedup',
    dedupHash: input.dedupHash,
    parentId: input.parentId,
    title: input.title,
    source: input.source,
    sourceId: input.sourceId,
    existingTaskId: input.existingTaskId,
    windowHours: input.windowHours ?? DEFAULT_DEDUP_WINDOW_HOURS,
  };
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf-8');
}
