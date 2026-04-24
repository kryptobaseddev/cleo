/**
 * Session Journal Contract — types and Zod schema for `.cleo/session-journals/*.jsonl`.
 *
 * Session journals are append-only JSONL files (one JSON object per line) that
 * capture session lifecycle events as a training corpus for the meta-agent.
 * Each daily file is named `YYYY-MM-DD.jsonl` and lives under
 * `.cleo/session-journals/`. The directory is excluded from git via `.cleo/.gitignore`.
 *
 * **Privacy constraints**:
 * - `noteExcerpt` is capped at 200 characters.
 * - Task IDs only — task titles are never written.
 * - `doctorSummary` includes pattern names but not raw DB content.
 *
 * **Concurrency**: multiple sessions append to the same daily file using
 * Node.js `appendFile` which leverages O_APPEND atomicity for writes under
 * ~4 KB on Linux ext4/macOS APFS.
 *
 * **Retention** (enforced by `rotateSessionJournals`):
 * | Tier    | Age       | Disposition                          |
 * |---------|-----------|--------------------------------------|
 * | Hot     | 0–7 days  | All entries retained verbatim        |
 * | Warm    | 8–30 days | session_end entries only             |
 * | Archive | 31–90 days| Monthly rollup; individual files deleted |
 * | Purge   | >90 days  | Monthly rollups deleted              |
 *
 * @module session-journal
 * @task T1263
 * @epic T1075
 * @see packages/core/src/sessions/session-journal.ts
 * @see .cleo/adrs/ADR-013 §9 (runtime-data-safety)
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

/**
 * Current schema version for session journal entries.
 *
 * Increment when adding new required fields or changing field semantics.
 * Readers MUST treat unknown versions as forwards-compatible (new optional
 * fields only) and fall back gracefully.
 */
export const SESSION_JOURNAL_SCHEMA_VERSION = '1.0' as const;

// ============================================================================
// Zod Schema
// ============================================================================

/**
 * Zod schema for a session journal doctor summary sub-object.
 *
 * Embeds a compact summary of the `cleo memory doctor` scan run at session-end.
 * Implements T1262 absorption into E6 session-journal integration.
 */
export const sessionJournalDoctorSummarySchema = z.object({
  /** `true` when zero noise patterns were detected. */
  isClean: z.boolean(),
  /** Total number of noise findings across all patterns. */
  findingsCount: z.number().int().nonnegative(),
  /** Pattern names that were detected (empty when isClean). */
  patterns: z.array(z.string()),
  /** Total brain entries scanned. `0` = empty or unavailable. */
  totalScanned: z.number().int().nonnegative(),
});

/**
 * Zod schema for the debrief summary sub-object.
 *
 * Captures a compact excerpt from the session note and a count of completed tasks.
 */
export const sessionJournalDebriefSummarySchema = z.object({
  /** First 200 characters of the session end note (if provided). */
  noteExcerpt: z.string().max(200).optional(),
  /** Number of tasks completed during the session. */
  tasksCompletedCount: z.number().int().nonnegative(),
  /** Up to 5 task IDs (not titles) that were the focus of the session. */
  tasksFocused: z.array(z.string()).max(5).optional(),
});

/**
 * Zod schema for a single session journal entry.
 *
 * All fields except the identity fields are optional to allow incremental
 * enrichment and forward-compatible schema evolution.
 */
export const sessionJournalEntrySchema = z.object({
  // Identity
  /** Schema version for forward-compatibility. Always `'1.0'` in this release. */
  schemaVersion: z.literal(SESSION_JOURNAL_SCHEMA_VERSION),
  /** ISO 8601 timestamp when the entry was written. */
  timestamp: z.string(),
  /** CLEO session ID (e.g. `ses_20260424055456_ede571`). */
  sessionId: z.string(),
  /** Event type that triggered this journal entry. */
  eventType: z.enum(['session_start', 'session_end', 'observation', 'decision', 'error']),

  // Session metadata (set on session_start / session_end)
  /** Agent identifier (e.g. `cleo-prime`, `claude-code`). */
  agentIdentifier: z.string().optional(),
  /** Provider adapter ID active for this session. */
  providerId: z.string().optional(),
  /** Session scope string (e.g. `'global'` or `'epic:T1263'`). */
  scope: z.string().optional(),

  // Session-end fields
  /** Duration of the session in seconds (session_end only). */
  duration: z.number().int().nonnegative().optional(),
  /** Task IDs (not titles) completed during the session. */
  tasksCompleted: z.array(z.string()).optional(),

  // Doctor summary (T1262 absorbed)
  /** Compact result of `scanBrainNoise` run at session-end. */
  doctorSummary: sessionJournalDoctorSummarySchema.optional(),

  // Debrief summary
  /** Compact excerpt from session debrief data. */
  debriefSummary: sessionJournalDebriefSummarySchema.optional(),

  // Optional hash chain
  /** SHA-256 hex of the previous entry's raw JSON string (for integrity chain). */
  prevEntryHash: z.string().optional(),
});

// ============================================================================
// Types
// ============================================================================

/** Doctor summary embedded in session journal entries at session-end. */
export type SessionJournalDoctorSummary = z.infer<typeof sessionJournalDoctorSummarySchema>;

/** Debrief summary embedded in session journal entries at session-end. */
export type SessionJournalDebriefSummary = z.infer<typeof sessionJournalDebriefSummarySchema>;

/**
 * A single entry in a session journal JSONL file.
 *
 * One JSON object per line in `.cleo/session-journals/YYYY-MM-DD.jsonl`.
 * Lines are appended atomically via `appendFile` (O_APPEND).
 *
 * @example
 * ```json
 * {"schemaVersion":"1.0","timestamp":"2026-04-24T10:00:00.000Z","sessionId":"ses_xxx","eventType":"session_start","agentIdentifier":"claude-code","scope":"global"}
 * ```
 */
export type SessionJournalEntry = z.infer<typeof sessionJournalEntrySchema>;
