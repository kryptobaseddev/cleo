# Schema Authority

This document defines how to interpret CLEO schema state and migration history.

## Canonical Sources

1. The schema files below are the single source of truth for current DB structure, constraints, and types:
   - `packages/core/src/store/tasks-schema.ts` — tasks.db (tasks, sessions, lifecycle, audit, agents, token usage, WarpChain, ADR)
   - `packages/core/src/store/brain-schema.ts` — brain.db (decisions, patterns, learnings, observations, graph)
   - `packages/core/src/store/chain-schema.ts` — WarpChain tables (re-exported from tasks-schema.ts)
   - `packages/core/src/agents/agent-schema.ts` — agent_instances, agent_error_log tables (re-exported from tasks-schema.ts)
   - `packages/core/src/store/nexus-schema.ts` — nexus.db (project_registry, nexus_audit_log)
   - `packages/core/src/store/conduit-sqlite.ts` — conduit.db DDL (project-tier messaging, project_agent_refs)
   - `packages/core/src/store/signaldock-sqlite.ts` — signaldock.db DDL (global-tier agent identity)
   - `packages/contracts/src/status-registry.ts` — canonical status enum constants (SSoT per ADR-018)
2. The latest effective migration state under `packages/core/migrations/` is the runtime DDL history:
   - `drizzle-tasks/` — tasks.db migrations
   - `drizzle-brain/` — brain.db migrations
3. `packages/core/src/store/tasks-schema.ts` also exports all lifecycle stage constant names via `LIFECYCLE_STAGE_NAMES`.

> **Note**: The legacy `packages/core/src/store/schema.ts` no longer exists. All references to it should point to `tasks-schema.ts` instead.

## Migration History Rules

- Historical migration files MAY contain superseded intermediate constraints.
- Do not treat an older migration file as the current schema by itself.
- Always compare current behavior against `packages/core/src/store/schema.ts` plus latest effective migration state.

## Validation Guardrails

- Lifecycle parity guardrail: `packages/core/src/store/__tests__/lifecycle-schema-parity.test.ts`
- Recovery DDL anti-hardcoding guardrail: `packages/core/src/store/__tests__/recover-tooling-guardrail.test.ts`
- AJV canonical path checks: `packages/core/src/__tests__/schema.test.ts`

## Contributor Checklist

1. Update schema definitions in the appropriate file under `packages/core/src/store/` (see Canonical Sources above).
   - Status enums go in `packages/contracts/src/status-registry.ts` only (ADR-018).
   - Do not duplicate status constants in schema files.
2. Generate/update migrations under `packages/core/migrations/drizzle-tasks/` or `drizzle-brain/`.
3. Run guardrails:
   - `pnpm vitest run packages/core/src/store/__tests__/lifecycle-schema-parity.test.ts`
   - `pnpm vitest run packages/core/src/store/__tests__/recover-tooling-guardrail.test.ts`
4. Run typecheck: `pnpm tsc --noEmit`.
5. Run biome: `pnpm biome check --write .`
6. Commit schema + migration + tests/docs together (single coherent change set).
7. Update `docs/architecture/DATABASE-ERDS.md` to reflect any table/column/index changes.

## Related ADRs

- `/.cleo/adrs/ADR-012-drizzle-kit-migration-system.md` (Section 8)
- `/.cleo/adrs/ADR-006-canonical-sqlite-storage.md`
- `/.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md`
