# T703 STDP M1 Migration — Evidence Report

**Tasks**: T703 (Migration M1), T715 (session_id backfill SQL)
**Date**: 2026-04-15
**Status**: COMPLETE
**Agent**: cleo-subagent Worker (Wave 0)

---

## Summary

Delivered M1 migration for the STDP Phase 5 wire-up. All three BUG-2 root causes are fixed
for the `brain_retrieval_log` table. Full spec ref: `docs/specs/stdp-wire-up-spec.md §5.1`.

---

## Files Delivered

| File | Change | Committed |
|------|--------|-----------|
| `packages/core/migrations/drizzle-brain/20260416000001_t673-retrieval-log-plasticity-columns/migration.sql` | Created — M1 migration | `1b860dfc` / `591b2ff1` |
| `packages/core/src/store/brain-schema.ts` | Added `retrievalOrder`, `deltaMs`, `rewardSignal` columns + `idx_retrieval_log_reward` index to `brainRetrievalLog` | `42a22ea2` |
| `packages/core/src/store/brain-sqlite.ts` | Added `ensureColumns` safety net for all 4 M1 columns on `brain_retrieval_log` | `42a22ea2` |
| `packages/core/src/memory/brain-retrieval.ts` | Fixed BUG-2: `entryIds.join(',')` → `JSON.stringify(entryIds)` | `5787f72e` |
| `packages/core/src/memory/__tests__/brain-retrieval-m1.test.ts` | 6 real-SQLite tests (no mocks) | `5787f72e` |

---

## Migration SQL Summary

File: `20260416000001_t673-retrieval-log-plasticity-columns/migration.sql`

1. `CREATE TABLE IF NOT EXISTS brain_retrieval_log` — safe for fresh installs
2. `ALTER TABLE brain_retrieval_log ADD COLUMN session_id text` — was missing from live DDL
3. `ALTER TABLE brain_retrieval_log ADD COLUMN reward_signal real` — new R-STDP column
4. `UPDATE ... SET entry_ids = JSON array` — fixes BUG-2 for 38 historical rows
5. `UPDATE ... SET session_id = 'ses_backfill_' || ...` — T715 backfill SQL
6. `CREATE INDEX idx_retrieval_log_reward` and `idx_retrieval_log_session`

NOTE: `retrieval_order` and `delta_ms` were NOT added via migration (already present
in live table via self-healing DDL). The Drizzle schema declares them for type safety
only. The `ensureColumns` safety net in `brain-sqlite.ts` handles installs where those
columns may be absent.

---

## Live Database Verification

```
PRAGMA table_info(brain_retrieval_log):
  id, query, entry_ids, entry_count, source, tokens_used, created_at,
  retrieval_order, delta_ms, session_id, reward_signal  (11 columns total)

SELECT COUNT(*) total, COUNT(session_id) with_session,
       SUM(CASE WHEN entry_ids LIKE '[%' THEN 1 ELSE 0 END) json_entry_ids
FROM brain_retrieval_log:
  38 | 38 | 38  (all 38 rows have session_id and JSON entry_ids)
```

Session ID format: `ses_backfill_2026-04-13`, `ses_backfill_2026-04-14`, `ses_backfill_2026-04-15`

---

## Test Results

File: `packages/core/src/memory/__tests__/brain-retrieval-m1.test.ts`

```
M1-1: All four T673-M1 columns exist after getBrainDb initialises  ✓
M1-2: logRetrieval stores entry_ids as JSON array (not CSV)         ✓
M1-3: Round-trip JSON.stringify → JSON.parse yields original array  ✓
M1-4: session_id backfill pattern — ses_backfill_ rows skippable   ✓
M1-5: reward_signal column accepts NULL and numeric values          ✓
M1-6: indexes idx_retrieval_log_reward and session exist            ✓

Test Files: 246 passed (246)
Tests: 3910 passed | 32 todo (3942)
```

No mocks used. Real SQLite via `mkdtemp` temp directory.

---

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| Migration file committed | DONE — `20260416000001_t673-retrieval-log-plasticity-columns/migration.sql` |
| brain-schema.ts has all 10 columns matching live table | DONE — 11 columns in live + schema |
| ensureColumns updated for session_id + reward_signal + retrieval_order + delta_ms | DONE |
| PRAGMA table_info shows all columns after migration | DONE — verified above |
| Existing entry_ids converted to JSON array | DONE — 38/38 rows |
| pnpm biome check --write passes | DONE |
| pnpm run build passes | DONE |
| T715 backfill SQL included in M1 migration | DONE |
| Backfill is idempotent | DONE — WHERE session_id IS NULL |
| backfillRewardSignals skip guard documented | DONE — ses_backfill_% in schema comment |

---

## Unblocks

Wave 1 tasks that depend on M1 being applied:
- T679 (STDP-W2: fix applyStdpPlasticity lookback + session_id INSERT)
- T681 (STDP-W4: backfillRewardSignals function + Step 9a wiring)
- T693 (STDP-A6: plasticity_class column writer)
