# T5372 Complete: CLEO-NEXUS-SPECIFICATION.md

## File created
docs/specs/CLEO-NEXUS-SPECIFICATION.md

## Sections included
1. Overview - NEXUS purpose, portability model, database relationships
2. Terminology - 8 key terms defined
3. Storage Model - 3 tables described with exact columns from nexus-schema.ts
4. Identity Model - projectId vs projectHash, portability contract
5. Registration/Reconciliation Lifecycle - 4-scenario matrix with algorithm details
6. Operation Surface - 17 query + 14 mutate = 31 total operations
7. Logging/Audit Model - writeNexusAudit() behavior, correlation fields
8. Migration Plan - JSON-to-SQLite migration and rollback
9. Failure/Recovery Semantics - Exit codes 70-79, conflict policy, orphan detection
10. Portability Guarantees - Data location and portability matrix

## Accurate operation counts
- Query operations: 17 (14 core + 3 sharing)
- Mutate operations: 14 (7 core + 7 sharing)
- Total: 31

## Data sources verified
- `src/store/nexus-schema.ts` -- exact column names and types
- `src/core/nexus/registry.ts` -- all functions (nexusInit through nexusReconcile)
- `src/core/nexus/migrate-json-to-sqlite.ts` -- migration logic
- `src/dispatch/registry.ts` -- operation counts via grep
- `src/types/exit-codes.ts` -- exit code ranges 70-79

## Status: COMPLETE
