# Schema Authority

This document defines how to interpret CLEO schema state and migration history.

## Canonical Sources

1. `src/store/schema.ts` is the single source of truth for current DB structure, constraints, and types.
2. The latest effective migration state under `drizzle/` is the runtime DDL history for applying schema changes.
3. `src/core/lifecycle/stages.ts` is the canonical lifecycle stage constant source for application logic.

## Migration History Rules

- Historical migration files MAY contain superseded intermediate constraints.
- Do not treat an older migration file as the current schema by itself.
- Always compare current behavior against `src/store/schema.ts` plus latest effective migration state.

## Validation Guardrails

- Lifecycle parity guardrail: `src/store/__tests__/lifecycle-schema-parity.test.ts`
- Recovery DDL anti-hardcoding guardrail: `src/store/__tests__/recover-tooling-guardrail.test.ts`
- AJV canonical path checks: `src/core/__tests__/schema.test.ts`

## Contributor Checklist

1. Update schema definitions in `src/store/schema.ts` (and core lifecycle constants when applicable).
2. Generate/update migrations in `drizzle/` from schema changes.
3. Run guardrails:
   - `npx vitest run src/store/__tests__/lifecycle-schema-parity.test.ts`
   - `npx vitest run src/store/__tests__/recover-tooling-guardrail.test.ts`
4. Run typecheck: `npx tsc --noEmit`.
5. Commit schema + migration + tests/docs together (single coherent change set).

## Related ADRs

- `/.cleo/adrs/ADR-012-drizzle-kit-migration-system.md` (Section 8)
- `/.cleo/adrs/ADR-006-canonical-sqlite-storage.md`
- `/.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md`
