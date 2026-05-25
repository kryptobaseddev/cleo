---
id: t10502-ac-table-schema
tasks: [T10502]
kind: feat
summary: "schema: task_acceptance_criteria table (T10381 Wave 2a)"
---

Adds the canonical `task_acceptance_criteria` table to `tasks.db` per ADR-079-r1 §2.1 + §2.2 (Saga T10377 SG-IVTR-AC-BINDING, Epic T10381 E-AC-MIGRATION). First of three parallel-safe Drizzle schemas in Wave 2a (siblings T10503 + T10504 land alongside).

Each Acceptance Criterion now gets exactly one canonical identifier — a UUIDv4 PRIMARY KEY generated at AC creation by `crypto.randomUUID()` — binding Validator verdicts, `satisfies:` evidence atoms, and CI gate references through a single stable handle. The 1-based `ordinal` column powers the `AC<n>` display alias; the UNIQUE (task_id, ordinal) index enforces the no-collision invariant from ADR-079-r1 §2.2.

Forward-only and additive — the legacy `tasks.acceptance_json` column remains the read-path SSoT until the backfill + cutover wave later in Epic T10381. New table is reachable but unused by any writer in this PR; downstream tasks bring the writer surface online.

Migration: `packages/core/migrations/drizzle-tasks/20260524000002_t10502-task-acceptance-criteria/`. Schema extension: `packages/core/src/store/schema/tasks.ts` (additive — no existing tables touched). Parity tests: `packages/core/src/store/__tests__/task-acceptance-criteria-schema.test.ts` (13 tests covering SQL content, Drizzle parity, fresh-apply, UNIQUE constraint enforcement).
