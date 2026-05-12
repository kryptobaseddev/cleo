# T1162: Lifecycle Scope Guard — Subagent Bypass Prevention

**Status**: complete
**Commit**: d3bdd957fb3055a7fc46bc6321c9a106590a350c
**Branch**: main
**Date**: 2026-04-22

## Root Cause

During T1150 RCASD orchestration (2026-04-21, 17:59:17-18:00:32), a subagent
scoped to child task T1159 called `cleo lifecycle complete T1150 <stage>` 9 times
in 75 seconds, advancing the parent epic through all RCASD stages to bypass an
`E_LIFECYCLE_GATE_FAILED` gate. The `lifecycleProgress` function had no session
scope check — any process with DB access could advance any epic's lifecycle.

## Fix

### Entry Point

`packages/cleo/src/dispatch/engines/lifecycle-engine.ts`

New function `enforceScopeForLifecycleMutation(epicId, projectRoot)` is called
at the top of `lifecycleProgress`, `lifecycleSkip`, and `lifecycleReset` before
any DB mutation occurs.

### Logic

```
getActiveSession(projectRoot)
  no session        → allow (defer to requireActiveSession)
  global scope      → allow (owner-level)
  epic scope AND
    rootTaskId == epicId  → allow (session directly manages this epic)
    rootTaskId != epicId  → DENY: E_LIFECYCLE_SCOPE_DENIED (exit 34)
  CLEO_OWNER_OVERRIDE=1:
    agent role worker/lead/subagent  → still DENY (T1118 L4b)
    otherwise                        → allow + write to force-bypass.jsonl
```

### Key Files Changed

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/engines/lifecycle-engine.ts` | Added `enforceScopeForLifecycleMutation` + audit writer, wired into 3 mutate functions |
| `packages/cleo/src/dispatch/engines/_error.ts` | Added `E_LIFECYCLE_SCOPE_DENIED: 34` to STRING_TO_EXIT |
| `packages/contracts/src/errors.ts` | Added `LifecycleScopeDeniedError` class |
| `packages/contracts/src/index.ts` | Exported `LifecycleScopeDeniedError` |
| `packages/cleo/src/dispatch/engines/__tests__/lifecycle-scope-guard.test.ts` | 11 new tests (NEW FILE) |

### Error Code

- Code string: `E_LIFECYCLE_SCOPE_DENIED`
- Exit code: `34` (mapped to ExitCode.TASK_NOT_IN_SCOPE — semantically appropriate)
- Error class: `LifecycleScopeDeniedError` in `@cleocode/contracts`

## Tests Added

11 tests in `lifecycle-scope-guard.test.ts`:

1. Child-task-scoped session + `lifecycleProgress` → rejected E_LIFECYCLE_SCOPE_DENIED
2. Child-task-scoped session + `lifecycleSkip` → rejected E_LIFECYCLE_SCOPE_DENIED
3. Child-task-scoped session + `lifecycleReset` → rejected E_LIFECYCLE_SCOPE_DENIED
4. Epic-scoped session (rootTaskId=epicId) → proceeds normally
5. Global-scope session → proceeds normally
6. No active session → proceeds normally (defer to session enforcement)
7. CLEO_OWNER_OVERRIDE=1 → allowed + audit entry written to force-bypass.jsonl
8. Worker/lead/subagent + CLEO_OWNER_OVERRIDE=1 → still denied (T1118 L4b) [3 subtests]
9. Regression: T1150 incident simulation — all 9 RCASD stages blocked

Full suite: 637 test files, 10595 passed, 0 new failures.

## Documentation

No new ADR created — the scope-guard is referenced via `@adr ADR-054 (scope-guard addendum)`
in the JSDoc comments. ADR-054 already covers audit signing for gate writes; the scope
guard extends that governance surface without needing a separate ADR.

Subagent protocol: the guard is defense-in-depth. Subagents MUST NOT call
`cleo lifecycle *` commands at all — that is the orchestrator's domain. The guard
prevents misbehaving subagents from bypassing gates even if they try.
