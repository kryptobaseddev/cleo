/**
 * Evidence ↔ Acceptance-Criterion bindings — M:N join table.
 *
 * Lets the validator resolve "which ACs does this evidence atom satisfy?"
 * and the inverse "what evidence has been recorded against this AC?".
 * Powers ADR-079-r2 cross-task `satisfies:<task-id>#<ac-id>` evidence
 * atoms and (forward-compatibly) the T10509 H-gate coverage marker.
 *
 * IMPORTANT: `evidence_atom_id` is TEXT (not an FK) because evidence atoms
 * are parsed from evidence strings (e.g. `commit:<sha>`, `pr:<num>`,
 * `satisfies:<task>#<ac>`) and are NOT stored in a single normalised
 * table — they are derived. The stable hash / composite key of the atom
 * is what we store here, so the binding survives re-parsing of the same
 * evidence string.
 *
 * `ac_id` IS an FK to `task_acceptance_criteria(id)` (CASCADE on delete) —
 * the target table is created by T10502 in the same Wave 2a. The
 * migration timestamps are coordinated:
 *   T10502 → seconds end in `02` (table first)
 *   T10503 → seconds end in `03` (this binding table, after T10502)
 *   T10504 → seconds end in `04` (last)
 *
 * The TypeScript schema below intentionally does NOT call `.references()`
 * because the target Drizzle symbol (`taskAcceptanceCriteria`) lives in
 * T10502's still-unmerged branch. The hand-authored migration SQL encodes
 * the inline `REFERENCES task_acceptance_criteria(id) ON DELETE CASCADE`
 * constraint at the column-definition level — that's the runtime SSoT.
 *
 * @task T10503
 * @epic T10381
 * @saga T10377 (SG-IVTR-AC-BINDING)
 * @adr ADR-079-r2
 */

import { sql } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// === ENUM CONSTANTS ===

/**
 * Three binding kinds, each with distinct semantics for the validator:
 *
 *   - `direct`    — Worker's own evidence: the atom was emitted by the
 *                   task that owns this AC. The default for everything
 *                   produced inside the owning task's `cleo verify` call.
 *   - `satisfies` — Cross-task binding declared via ADR-079-r2 grammar
 *                   (`satisfies:<task-id>#<ac-id>`). The atom originated
 *                   in a different task and explicitly claims credit
 *                   against this AC.
 *   - `coverage`  — Computed coverage marker — set by the validator when
 *                   the AC is satisfied transitively (no direct binding,
 *                   but a parent / sibling / downstream task's evidence
 *                   chain covers it). Forward-compatible placeholder for
 *                   the T10509 H-gate.
 *
 * Enforced at the dispatch layer (writer code in T10505/T10506), NOT via
 * a SQL CHECK — that way adding a new binding kind in a future epic
 * does not require a schema migration.
 *
 * @adr ADR-079-r2 §validator-semantics
 */
export const EVIDENCE_BINDING_TYPES = ['direct', 'satisfies', 'coverage'] as const;

/** Union type for `evidence_ac_bindings.binding_type` column. */
export type EvidenceBindingType = (typeof EVIDENCE_BINDING_TYPES)[number];

// === TABLE ===

/**
 * `evidence_ac_bindings` — M:N join between evidence atoms and acceptance
 * criteria. Created by T10503 (Wave 2a of T10381).
 *
 * Columns:
 *   - `id`              UUIDv4, primary key.
 *   - `evidence_atom_id` Stable hash / composite key of the evidence atom
 *                        (e.g. `commit:abc123`, `pr:357`). NOT an FK —
 *                        evidence atoms are derived, not stored in a
 *                        single normalised table.
 *   - `ac_id`           FK → `task_acceptance_criteria(id)` (CASCADE).
 *                        The Drizzle `.references()` is intentionally
 *                        omitted; the FK lives in the hand-authored
 *                        migration SQL because the target table is
 *                        created by T10502 in a parallel still-unmerged
 *                        branch.
 *   - `binding_type`    One of {direct, satisfies, coverage}.
 *   - `created_at`      ISO-8601 timestamp; defaults to `datetime('now')`.
 *
 * Indexes:
 *   - Unique on (evidence_atom_id, ac_id, binding_type) — one binding
 *     per atom/ac/type triple. Idempotent re-inserts collapse.
 *   - On (ac_id) — "what evidence satisfies this AC?" lookup.
 *   - On (evidence_atom_id) — "what ACs does this atom target?" lookup.
 */
export const evidenceAcBindings = sqliteTable(
  'evidence_ac_bindings',
  {
    /** UUIDv4 — set by the writer (T10505/T10506). */
    id: text('id').primaryKey(),
    /** Stable hash / composite key of the evidence atom. NOT an FK. */
    evidenceAtomId: text('evidence_atom_id').notNull(),
    /**
     * FK → `task_acceptance_criteria(id)` (CASCADE) — declared in the
     * migration SQL, not via Drizzle `.references()`, because the target
     * Drizzle symbol lives in T10502's parallel branch.
     */
    acId: text('ac_id').notNull(),
    /** One of {direct, satisfies, coverage}. Enforced at the dispatch layer. */
    bindingType: text('binding_type', {
      enum: EVIDENCE_BINDING_TYPES,
    }).notNull(),
    /** ISO-8601 timestamp of binding creation. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // One binding per atom/ac/type triple — idempotent re-inserts collapse.
    uniqueIndex('uq_evidence_ac_bindings_atom_ac_type').on(
      table.evidenceAtomId,
      table.acId,
      table.bindingType,
    ),
    // "What evidence satisfies this AC?" lookup.
    index('idx_evidence_ac_bindings_ac_id').on(table.acId),
    // "What ACs does this atom target?" lookup.
    index('idx_evidence_ac_bindings_evidence_atom_id').on(table.evidenceAtomId),
  ],
);

// === TYPE EXPORTS ===

/** Row shape for SELECTs from `evidence_ac_bindings`. */
export type EvidenceAcBindingRow = typeof evidenceAcBindings.$inferSelect;
/** Row shape for INSERTs into `evidence_ac_bindings`. */
export type NewEvidenceAcBindingRow = typeof evidenceAcBindings.$inferInsert;
