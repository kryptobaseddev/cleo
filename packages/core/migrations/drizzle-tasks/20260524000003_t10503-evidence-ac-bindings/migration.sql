-- T10503 — Add `evidence_ac_bindings` M:N join between evidence atoms
-- and acceptance criteria. Wave 2a of Epic T10381 (ADR-079-r2:
-- cross-task `satisfies:<task-id>#<ac-id>` evidence atoms).
--
-- Purpose: lets the validator resolve
--   "which ACs does this evidence atom satisfy?"  (via index on evidence_atom_id)
--   "what evidence has been recorded against this AC?" (via index on ac_id)
-- without re-parsing every evidence string at query time.
--
-- Wave 2a ordering (intra-second seconds-component):
--   20260524000002_t10502-…  → creates `task_acceptance_criteria`
--   20260524000003_t10503-…  → THIS migration (binding table — depends on above)
--   20260524000004_t10504-…  → next sibling (independent)
-- migration-manager.ts applies migrations in lexicographic timestamp order,
-- so this binding table is guaranteed to land AFTER T10502's parent table.
--
-- Columns:
--   1. id               TEXT PRIMARY KEY    — UUIDv4, set by the writer.
--   2. evidence_atom_id TEXT NOT NULL       — stable hash / composite key of
--                                             the evidence atom (e.g. `commit:<sha>`,
--                                             `pr:<num>`, `satisfies:<task>#<ac>`).
--                                             NOT an FK — evidence atoms are
--                                             derived from evidence strings, not
--                                             stored in a single normalised table.
--   3. ac_id            TEXT NOT NULL       — FK → task_acceptance_criteria(id)
--                                             ON DELETE CASCADE. The Drizzle
--                                             schema in evidence-bindings.ts
--                                             intentionally OMITS .references()
--                                             because the target table's
--                                             TypeScript symbol lives in T10502's
--                                             parallel branch — the FK is
--                                             declared inline here.
--   4. binding_type     TEXT NOT NULL       — one of {direct, satisfies, coverage}.
--                                             Enforced at the dispatch layer
--                                             (T10505/T10506 writers), NOT via
--                                             a SQL CHECK so adding a new kind
--                                             in a future epic does not require
--                                             a schema migration.
--   5. created_at       TEXT NOT NULL       — ISO-8601, defaults to datetime('now').
--
-- Indexes:
--   - uq_evidence_ac_bindings_atom_ac_type  — UNIQUE on
--       (evidence_atom_id, ac_id, binding_type). One binding per triple;
--       idempotent re-inserts collapse.
--   - idx_evidence_ac_bindings_ac_id        — "what evidence satisfies this AC?"
--   - idx_evidence_ac_bindings_evidence_atom_id — "what ACs does this atom target?"
--
-- DEPENDS ON: 20260524000002_t10502-… (creates `task_acceptance_criteria`)
-- SAFE FOR:   SQLite 3.35+ (CREATE TABLE with inline FK is atomic)
--
-- @task T10503
-- @epic T10381
-- @saga T10377 (SG-IVTR-AC-BINDING)
-- @adr  ADR-079-r2

CREATE TABLE `evidence_ac_bindings` (
  `id`                TEXT PRIMARY KEY NOT NULL,
  `evidence_atom_id`  TEXT NOT NULL,
  `ac_id`             TEXT NOT NULL REFERENCES `task_acceptance_criteria`(`id`) ON DELETE CASCADE,
  `binding_type`      TEXT NOT NULL,
  `created_at`        TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_evidence_ac_bindings_atom_ac_type`
  ON `evidence_ac_bindings` (`evidence_atom_id`, `ac_id`, `binding_type`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_ac_bindings_ac_id`
  ON `evidence_ac_bindings` (`ac_id`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_ac_bindings_evidence_atom_id`
  ON `evidence_ac_bindings` (`evidence_atom_id`);
