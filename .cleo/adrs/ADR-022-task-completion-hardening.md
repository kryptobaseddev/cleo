# ADR-022: Task Completion Hardening and Canonical Done Semantics

**Status**: Accepted
**Date**: 2026-03-03
**Task**: T5253
**Amends**: ADR-008, ADR-017

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

Task completion had enforcement drift across paths:
- `tasks.complete` enforced dependencies, but `tasks.update status=done` could bypass completion checks.
- Acceptance and verification policies existed in config/schema but were not consistently enforced in completion.
- Completion behavior and lifecycle gate semantics were not clearly codified in canonical docs.

This created ambiguity for agents and inconsistent enforcement outcomes.

---

## 2. Decision

### 2.1 Canonical completion path

1. `tasks.complete` is the canonical transition to `status=done`.
2. `tasks.update` with `status=done` as a status-only transition MUST route through completion semantics.
3. `tasks.update` with `status=done` plus any additional field changes MUST be rejected.

### 2.2 Completion policy enforcement

1. Dependency completion considers dependency statuses `done` and `cancelled` as satisfied.
2. Acceptance enforcement is config-driven:
   - `enforcement.acceptance.mode = block` MAY block completion.
   - `enforcement.acceptance.requiredForPriorities` controls priority scope.
3. Verification enforcement is default-on:
   - If `verification.enabled` is unset, enforcement defaults to enabled.
   - Explicit `verification.enabled = false` disables verification gate checks.
   - Required gates come from `verification.requiredGates`.
   - Round cap comes from `verification.maxRounds`.
4. In strict lifecycle mode, verification gate failure during completion MUST surface lifecycle gate failure semantics.

### 2.3 Error mapping discipline

1. Engine adapters SHOULD map core exit codes through centralized engine error helpers.
2. Domain-specific exit-code mapping tables MAY be used to keep handlers deterministic and auditable.

### 2.4 Naming clarification for data-safety wrappers

1. Existing `safeSaveTaskFile` naming remains valid for compatibility.
2. `safeSaveTaskData` is introduced as the preferred alias for task-domain data writes.
3. Migration to `*Data` naming MAY proceed incrementally without breaking existing callers.

---

## 3. Consequences

### Positive
- Single, auditable completion semantics across CLI/MCP and update/complete paths.
- Stronger anti-bypass guarantees for dependency, acceptance, verification, and lifecycle rules.
- Deterministic behavior for agents with clearer error branching.

### Negative
- Some historical workflows that used `update --status done` with other field edits now require two commands.
- More strict defaults can surface validation errors in previously permissive projects.

### Neutral
- Existing projects can opt out of verification enforcement explicitly via project config.

---

## 4. Implementation References

- `src/core/tasks/complete.ts`
- `src/core/tasks/update.ts`
- `src/dispatch/engines/task-engine.ts`
- `src/store/data-safety-central.ts`
- `docs/guides/task-fields.md`
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`
- `docs/concepts/CLEO-VISION.md`
