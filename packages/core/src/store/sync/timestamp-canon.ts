/**
 * The pure half of the uniform timestamp format (journal spec §1.8, R3, M4;
 * T12986): the strict canonicalizer and the captured timestamp columns. It
 * has no runtime imports, so the Gate B fingerprint script
 * (`scripts/fingerprint-store.mjs --canon-timestamps`) loads this file
 * directly and applies the very function the sealer applies on the wire
 * (T12987). {@link module:store/sync/timestamps} re-exports it.
 *
 * @module store/sync/timestamp-canon
 * @task T12986
 * @task T12987
 */

import type { TableScope } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// The canonicalizer
// ---------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const SQLITE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The canonical wire form of a stored timestamp,
 * `YYYY-MM-DDTHH:MM:SS.sssZ`, or `null` when the value is refused.
 *
 * Fractions beyond milliseconds are truncated, never rounded, so a carry can
 * never change the second. Pure: two replicas always agree.
 *
 * @example
 * ```ts
 * canonicalStoreTimestamp('2026-09-14 19:56:01');          // '2026-09-14T19:56:01.000Z'
 * canonicalStoreTimestamp('2026-09-14T21:56:01.5+02:00');  // '2026-09-14T19:56:01.500Z'
 * canonicalStoreTimestamp('2026-09-14T19:56:01');          // null (zoneless)
 * canonicalStoreTimestamp('2026-09-14');                   // null (date only)
 * ```
 */
export function canonicalStoreTimestamp(value: string): string | null {
  const m = ISO.exec(value) ?? SQLITE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  let offsetMin = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
  }
  // setUTCFullYear keeps years below 100 as written (Date.UTC would add 1900).
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  const at = t.getTime() - offsetMin * 60_000;
  const out = new Date(at);
  const year = out.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  return out.toISOString();
}

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

/**
 * Captured TEXT timestamp columns per sync-set table. The claim-lease columns
 * (`claimed_at`, `lease_expires_at`) are local-only and are not captured, so
 * they are not here. INTEGER epoch-millisecond columns (`brain_attention`,
 * `brain_decisions.validator_run_at`, `brain_session_narrative.last_updated_at`)
 * are already canonical and are not here either. A test pins this map, plus
 * an explicit list of those integer columns, against every captured `*_at`
 * column of both sync sets.
 */
export const SYNC_TIMESTAMP_COLUMNS: Readonly<
  Record<TableScope, Readonly<Record<string, readonly string[]>>>
> = {
  project: {
    tasks_tasks: ['created_at', 'updated_at', 'completed_at', 'cancelled_at', 'archived_at'],
    tasks_sessions: ['started_at', 'ended_at', 'task_started_at', 'handoff_consumed_at'],
    tasks_task_acceptance_criteria: ['created_at', 'updated_at'],
    tasks_task_acceptance_criteria_history: ['recorded_at'],
    tasks_evidence_ac_bindings: ['created_at'],
    tasks_display_id_aliases: ['created_at'],
    tasks_uid_aliases: ['created_at'],
    brain_decisions: ['created_at', 'updated_at', 'valid_at', 'invalid_at', 'tier_promoted_at'],
    brain_patterns: [
      'extracted_at',
      'updated_at',
      'last_seen_at',
      'valid_at',
      'invalid_at',
      'tier_promoted_at',
    ],
    brain_learnings: ['created_at', 'updated_at', 'valid_at', 'invalid_at', 'tier_promoted_at'],
    brain_observations: [
      'created_at',
      'updated_at',
      'validated_at',
      'valid_at',
      'invalid_at',
      'tier_promoted_at',
    ],
    brain_page_nodes: ['created_at', 'updated_at', 'last_activity_at'],
    brain_backfill_runs: ['created_at', 'approved_at'],
    brain_observations_staging: ['created_at', 'new_invalid_at'],
    brain_promotion_log: ['decided_at'],
    brain_transcript_events: ['created_at', 'redacted_at'],
    brain_page_edges: ['created_at', 'last_reinforced_at', 'last_depressed_at'],
    brain_memory_links: ['created_at'],
    brain_retrieval_log: ['created_at'],
    brain_weight_history: ['changed_at'],
    brain_modulators: ['created_at'],
    brain_consolidation_events: ['started_at'],
    brain_usage_log: ['created_at'],
    tasks_brain_release_links: ['created_at'],
    brain_task_observations: ['created_at'],
    // T13354 (CleoDocs re-key): the re-keyed/new syncing tables of the doc
    // history family.
    conduit_attachments: ['created_at', 'expires_at'],
    conduit_attachment_versions: ['created_at'],
    conduit_attachment_approvals: ['created_at', 'updated_at'],
    conduit_doc_slug_aliases: ['created_at'],
    conduit_doc_heads: ['updated_at'],
    // T13359 (decisions vs ADRs): created_at is the birth, updated_at moves
    // exactly once — the revoke tombstone latch.
    decision_adr_links: ['created_at', 'updated_at'],
    // T13360 (legacy docs migration): migrated_at is stamped once when the
    // receipt is written and never moves (append-only ledger).
    conduit_doc_migration_ledger: ['migrated_at'],
    // T13362 (publications ledger moves into the store): published_at moves
    // on every re-publish of the (owner, blob, path) LWW row.
    docs_publications: ['published_at'],
    // T12919 (docs sync coverage): the doc registry and its owner refs.
    docs_attachments: ['created_at'],
    docs_attachment_refs: ['attached_at'],
    // T12914 (lifecycle, release, PR and commit sync coverage).
    tasks_lifecycle_pipelines: ['started_at', 'completed_at', 'updated_at'],
    tasks_lifecycle_stages: [
      'started_at',
      'completed_at',
      'blocked_at',
      'skipped_at',
      'validated_at',
    ],
    tasks_lifecycle_gate_results: ['checked_at'],
    tasks_lifecycle_evidence: ['recorded_at'],
    tasks_lifecycle_transitions: ['created_at'],
    tasks_releases: [
      'created_at',
      'planned_at',
      'pr_opened_at',
      'pr_merged_at',
      'published_at',
      'reconciled_at',
      'rolled_back_at',
      'failed_at',
      'cancelled_at',
      'prepared_at',
      'committed_at',
      'tagged_at',
      'pushed_at',
    ],
    tasks_release_changes: ['classified_at'],
    tasks_release_changesets: ['created_at'],
    tasks_release_artifacts: ['published_at'],
    tasks_pull_requests: ['opened_at', 'merged_at', 'closed_at', 'created_at', 'updated_at'],
    tasks_pr_tasks: ['created_at'],
    tasks_commits: ['authored_at', 'committed_at', 'created_at'],
    tasks_task_commits: ['created_at'],
  },
  global: {
    brain_decisions: ['created_at', 'updated_at', 'valid_at', 'invalid_at', 'tier_promoted_at'],
    brain_patterns: [
      'extracted_at',
      'updated_at',
      'last_seen_at',
      'valid_at',
      'invalid_at',
      'tier_promoted_at',
    ],
    brain_learnings: ['created_at', 'updated_at', 'valid_at', 'invalid_at', 'tier_promoted_at'],
    brain_observations: [
      'created_at',
      'updated_at',
      'validated_at',
      'valid_at',
      'invalid_at',
      'tier_promoted_at',
    ],
    brain_page_nodes: ['created_at', 'updated_at', 'last_activity_at'],
    brain_backfill_runs: ['created_at', 'approved_at'],
    brain_observations_staging: ['created_at', 'new_invalid_at'],
    brain_promotion_log: ['decided_at'],
    brain_transcript_events: ['created_at', 'redacted_at'],
    brain_page_edges: ['created_at', 'last_reinforced_at', 'last_depressed_at'],
    brain_memory_links: ['created_at'],
    brain_retrieval_log: ['created_at'],
    brain_weight_history: ['changed_at'],
    brain_modulators: ['created_at'],
    brain_consolidation_events: ['started_at'],
    brain_usage_log: ['created_at'],
    brain_sticky_notes: ['created_at', 'updated_at'],
    agent_registry_agents: ['created_at', 'installed_at', 'updated_at'],
    // T13467: the credential tables' timestamps are sealed, canonical inside the seal.
    accounts: ['cooldown_reset_at', 'created_at', 'expires_at', 'updated_at'],
    service_connections: ['connected_at', 'expires_at', 'updated_at'],
    service_configs: ['created_at', 'updated_at'],
    agent_service_grants: ['created_at', 'updated_at'],
  },
};

/**
 * Columns the one-time rewrite never touches: `tasks_tasks.updated_at` is the
 * #1698 CAS token, and rewriting it would invalidate a caller's `--if-match`.
 */
export const CANON_EXCLUDED_COLUMNS: Readonly<
  Record<TableScope, Readonly<Record<string, readonly string[]>>>
> = {
  project: { tasks_tasks: ['updated_at'] },
  global: {},
};

/** The captured timestamp columns of `table` (empty when it has none). */
export function timestampColumns(scope: TableScope, table: string): ReadonlySet<string> {
  const cols = SYNC_TIMESTAMP_COLUMNS[scope];
  return new Set(Object.hasOwn(cols, table) ? cols[table] : []);
}
