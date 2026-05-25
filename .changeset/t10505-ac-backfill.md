---
id: t10505-ac-backfill
tasks: [T10505]
kind: feat
summary: "migration: backfill task_acceptance_criteria from tasks.acceptance_json (T10381 Wave 2b)"
---

Idempotent SQL-only data migration that walks every row in `tasks` and expands its legacy `acceptance_json` array into first-class `task_acceptance_criteria` rows (Saga T10377 SG-IVTR-AC-BINDING, Epic T10381 E-AC-MIGRATION). Wave 2b — PR 4 of 8 in the AC-binding migration train. Sits atop the Wave 2a schemas (T10502 AC table, T10503 evidence bindings, T10504 history) and is the first migration to write data, not just DDL.

Each non-empty, non-whitespace AC entry becomes one row with a UUIDv4 `id` (generated in pure SQL via `printf`/`randomblob` — RFC 4122 version + variant bits both forced) and a 1-based `ordinal` derived from `ROW_NUMBER() OVER (PARTITION BY task_id)` preserving authorship order. Empty arrays, NULL columns, and malformed JSON are skipped via a `json_valid`/`json_type` CASE guard that wraps the input to `json_each` — without it a single bad row would abort the migration. Plain-text and `{criteria: "..."}` object element shapes are both handled (matching `parseAcceptanceJson` in `hygiene-scan.ts`). Whitespace is stripped with `trim(x, char(9,10,13,32))` because SQLite's default `trim()` only strips ASCII space.

Every backfilled AC also gets one `task_acceptance_criteria_history` audit row with `reason='backfill'` and `previous_text = ac.text`. Both inserts are gated by `NOT EXISTS` clauses — re-running the SQL produces zero net new rows. The legacy `tasks.acceptance_json` column is NEVER altered or dropped; back-compat read paths (hygiene-scan, workflow-telemetry) continue to resolve through it until the cutover wave later in Epic T10381.

Migration: `packages/core/migrations/drizzle-tasks/20260524000005_t10505-ac-backfill/{migration,revert}.sql`. Tests: `packages/core/src/store/__tests__/t10505-ac-backfill.test.ts` (18 tests covering SQL content, end-to-end fresh-DB apply across 9 fixture shapes, idempotency, ordinal assignment, UUIDv4 shape, history-row creation, whitespace/empty/NULL/malformed handling, and legacy-column preservation).
