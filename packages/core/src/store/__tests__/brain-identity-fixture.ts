/**
 * Brain rows for row-identity fixtures (T12894): one or more rows in every
 * brain table declared in ROW_IDENTITY, written raw (no uid), with the birth
 * shapes the live stores hold (ms ISO, second-precision SQLite text, INTEGER
 * epoch ms for `brain_attention`). Every column that defaults to the current
 * time is set, so two fixtures built apart hold the same content.
 *
 * T12895 adds the natural-key tables: page edges (one directed edge to a
 * node with no page-node row, and a `co_retrieved` pair stored both ways), a
 * memory link and, with `sticky`, a sticky tag.
 *
 * @task T12894
 * @task T12895
 */

import type { DatabaseSync } from 'node:sqlite';

/** Insert one row into every declared brain table (both scopes carry them all). */
export function seedBrainRows(native: DatabaseSync, opts: { sticky?: boolean } = {}): void {
  native.exec(`
    INSERT INTO brain_decisions (id, type, decision, rationale, confidence, created_at, valid_at) VALUES
      ('D0001', 'architecture', 'Use uids', 'merge key', 'high', '2026-09-01 09:00:00', '2026-09-01 09:00:00'),
      ('D0002', 'technical', 'Fill at open', 'deterministic', 'medium', '2026-09-01T09:01:00.000Z', '2026-09-01 09:01:00');
    UPDATE brain_decisions SET supersedes = 'D0001' WHERE id = 'D0002';
    INSERT INTO brain_patterns (id, type, pattern, context, extracted_at, valid_at) VALUES
      ('P-0a1b2c3d', 'workflow', 'merge up the stack', 'sync', '2026-09-01 09:02:00', '2026-09-01 09:02:00');
    INSERT INTO brain_learnings (id, insight, source, confidence, created_at, valid_at) VALUES
      ('L-0a1b2c3d', 'zsh does not word-split', 'session', 0.9, '2026-09-01 09:03:00', '2026-09-01 09:03:00');
    INSERT INTO brain_observations (id, type, title, created_at, valid_at) VALUES
      ('O-0a1b2c3d', 'discovery', 'Brain rows need uids', '2026-09-01T09:04:00.123Z', '2026-09-01 09:04:00'),
      ('O-lzx1a2b3', 'change', 'Second observation', '2026-09-01 09:04:01', '2026-09-01 09:04:01');
    INSERT INTO brain_page_nodes (id, node_type, label, created_at, last_activity_at) VALUES
      ('decision:D0001', 'decision', 'Use uids', '2026-09-01 09:05:00', '2026-09-01 09:05:00');
    INSERT INTO brain_attention (id, content, scope_kind, scope_id, created_at) VALUES
      ('att-1', 'watch the fill', 'task', 'T1', 1788253500000);
    INSERT INTO brain_backfill_runs (id, kind, created_at) VALUES
      ('bf-1', 'observation-promotion', '2026-09-01 09:06:00');
    INSERT INTO brain_observations_staging (id, source_table, source_id, sweep_run_id, action, created_at) VALUES
      ('stg-1', 'brain_observations', 'O-0a1b2c3d', 'sweep-1', 'keep', '2026-09-01 09:07:00');
    INSERT INTO brain_promotion_log (id, observation_id, from_tier, to_tier, score, decided_at) VALUES
      ('pl-1', 'O-0a1b2c3d', 'short', 'medium', 0.7, '2026-09-01 09:08:00');
    INSERT INTO brain_transcript_events (id, session_id, seq, role, block_type, content, created_at) VALUES
      ('te-1', 'ses-1', 1, 'user', 'text', 'hello', '2026-09-01 09:09:00');
    INSERT INTO brain_session_narrative (session_id, narrative) VALUES ('ses-1', 'it began');
    INSERT INTO brain_page_edges (from_id, to_id, edge_type, created_at) VALUES
      ('decision:D0001', 'symbol:src/a.ts#f', 'code_reference', '2026-09-01 09:11:00'),
      ('decision:D0001', 'observation:O-0a1b2c3d', 'co_retrieved', '2026-09-01 09:11:01'),
      ('observation:O-0a1b2c3d', 'decision:D0001', 'co_retrieved', '2026-09-01 09:11:02');
    INSERT INTO brain_memory_links (memory_type, memory_id, task_id, link_type, created_at) VALUES
      ('observation', 'O-0a1b2c3d', 'T1', 'produced_by', '2026-09-01 09:12:00');
  `);
  if (opts.sticky) {
    native.exec(`INSERT INTO brain_sticky_notes (id, content, created_at) VALUES
      ('SN-001', 'remember the pins', '2026-09-01 09:10:00')`);
    native.exec(`INSERT INTO brain_sticky_tags (sticky_id, tag) VALUES ('SN-001', 'sync')`);
  }
}
