# T4766: Memory Layer Design

**Date**: 2026-02-27
**Task**: T4766
**Epic**: T4763 (BRAIN Foundation)
**Type**: Design/Architecture
**Supersedes**: T3171 (orphaned under cancelled T3156)

---

## 1. Storage Architecture

Per ADR-009 Section 3.1, the storage model is:

- **Runtime Store**: SQLite tables (`brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_memory_links`)
- **Export/Import Format**: JSONL files for portability
- **Existing Audit Data**: `.cleo/audit/decisions.jsonl` and `.cleo/audit/assumptions.jsonl` (pre-BRAIN, T4782)

## 2. Directory Layout

```
.cleo/
  cleo.db                          # SQLite database (contains brain_* tables)
  audit/
    decisions.jsonl                # Legacy decision log (pre-BRAIN, append-only)
    assumptions.jsonl              # Legacy assumption log (pre-BRAIN, append-only)
  memory/                          # BRAIN memory export/import directory
    exports/                       # Timestamped JSONL exports
      decisions-YYYY-MM-DD.jsonl   # Decision memory export
      patterns-YYYY-MM-DD.jsonl    # Pattern memory export
      learnings-YYYY-MM-DD.jsonl   # Learning memory export
    imports/                       # Staging area for JSONL imports
```

## 3. JSON Schemas Created

| Schema | File | Aligns With |
|--------|------|-------------|
| Decision Memory | `schemas/brain-decision.schema.json` | ADR-009 Section 3.2 `brain_decisions` table |
| Pattern Memory | `schemas/brain-pattern.schema.json` | ADR-009 Section 3.2 `brain_patterns` table |
| Learning Memory | `schemas/brain-learning.schema.json` | ADR-009 Section 3.2 `brain_learnings` table |

## 4. Migration Path from Legacy Audit

The existing `.cleo/audit/decisions.jsonl` format (from T4782) uses a different schema:
- `id`: `dec-<hex>` (vs BRAIN's `D###`)
- Fields: `sessionId`, `taskId`, `decision`, `rationale`, `alternatives`, `timestamp`
- Missing: `type`, `confidence`, `outcome`, `contextPhase`

**Migration strategy**: When BRAIN SQLite tables are created, a one-time migration will:
1. Read existing `.cleo/audit/decisions.jsonl` entries
2. Map to `brain_decisions` table with defaults (`type='technical'`, `confidence='medium'`)
3. Preserve original `sessionId` → `contextTaskId` mapping
4. Legacy audit files remain as backup (read-only)

## 5. Schema Alignment with ADR-009

All schemas map 1:1 with the SQLite table definitions in ADR-009 Section 3.2:
- Column names → camelCase JSON properties
- CHECK constraints → enum validations in JSON Schema
- SQL `TEXT NOT NULL` → `"type": "string", "minLength": 1`
- SQL `REAL` → `"type": "number"`
- SQL `INTEGER ... DEFAULT 0` (boolean) → `"type": "boolean", "default": false`
- SQL JSON columns (`alternatives_json`, `examples_json`, `applicable_types_json`) → native arrays

## 6. Future: SQLite Table Implementation

The actual `brain_*` SQLite tables will be created as a drizzle migration when:
1. The drizzle schema in `src/store/schema.ts` is updated with the table definitions
2. `npx drizzle-kit generate` produces the migration SQL
3. Core modules in `src/core/memory/` (or `src/core/brain/`) implement CRUD operations

This is tracked under T4763 as a future implementation task, not part of T4766 (design only).
