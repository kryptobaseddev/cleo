# T9580 Audit: Executive Brief

## Three Most Urgent Fixes

### 🔴 CRITICAL (Fix Week 1): `packages/core/src/validation/doctor/checks.ts`

**Risk:** Health-check command creates orphan `.cleo/` dirs in subdirectories instead of project root.

**Impact:** Operators running `cleo doctor` from `packages/core/` instead of project root silently corrupt their database state (writes to wrong `.cleo/tasks.db`, signaldock.db, etc.). This is the exact bug class from T9550.

**Count:** 12 `process.cwd()` + 5 raw `join(..., '.cleo', ...)` = 17 vulnerable sites

**Fix Complexity:** Medium (3-4 hour refactor + tests)

**Test Gap:** Zero tests ensure `cleo doctor` works from subdir.

---

### 🔴 HIGH (Fix Week 1-2): `packages/core/src/lifecycle/engine-ops.ts`

**Risk:** Workflow lifecycle operations (start, pause, resume) target wrong project when invoked from subdir.

**Impact:** State machines for orchestration (which rely on lifecycle ops) silently write state to wrong location, causing workflow divergence in monorepo subpackages and worktrees.

**Count:** 12 `process.cwd()` calls, most passed to downstream functions without normalization

**Fix Complexity:** Medium-High (distributed across multiple handler functions)

**Test Gap:** No subdir isolation tests.

---

### 🔴 HIGH (Fix Week 2): `packages/cleo/src/cli/commands/agent.ts` (26 cwd calls)

**Risk:** Agent registry accessor receives raw `process.cwd()` from CLI, doesn't normalize internally, writes agent metadata to wrong `.cleo/agents/` dir.

**Impact:** `cleo agent register`, `cleo agent get`, etc. silently corrupt agent registry when invoked from monorepo subdirectories. This affects the entire agent lifecycle (install, spawn, update).

**Count:** 26 `process.cwd()` → `AgentRegistryAccessor()` call sites

**Fix Complexity:** Low-Medium (uniform pattern across all command handlers; same fix template for all 26)

**Test Gap:** No tests ensure `cleo agent` commands work from subdir. This should be a standard test for ALL CLI commands, not just agent.ts.

---

## Why This Matters

**The T9550 Bug Class (Established June 2026):**

Code that accepts a `cwd` parameter and forwards it raw to downstream functions (without normalizing via `getProjectRoot()`) creates **silent data corruption** when the caller is in a subdirectory or worktree:

```
Caller (in packages/core/): process.cwd() → /mnt/projects/cleocode/packages/core
Downstream expects:          project root → /mnt/projects/cleocode
Result:                      write to /mnt/projects/cleocode/packages/core/.cleo/tasks.db ❌
                            Should be: /mnt/projects/cleocode/.cleo/tasks.db ✓
```

This audit found **120+ sites** with this exact pattern across 5 anti-pattern classes.

---

## Remediation Path (4 Weeks)

| Week | Batch | Files | Effort | Payoff |
|------|-------|-------|--------|--------|
| 1 | Batch 2: Critical (doctor, lifecycle, compliance) | 5 | 3-4 days | Stop orphan .cleo/ creation |
| 2 | Batch 3: CLI Commands (agent, nexus, dispatch) | 5 | 2-3 days | Fix agent/nexus CLI safety |
| 3 | Batch 1: Release/Spawn (orchestration, CI) | 5 | 2-3 days | Secure release pipeline |
| 4 | Batch 4: Cleanup (40+ remaining files, helpers) | 40+ | 2-3 days | Code quality & maintainability |

---

## Key Success Criteria

- ✅ Zero Cat-B findings (unsafe downstream use) in doctor, lifecycle, compliance, agent, nexus
- ✅ All 5 high-risk files have subdir integration tests (requires T9580 test batch)
- ✅ `resolveOrCwd()` helper deployed (eliminates 12+ instances of `opts.root ?? process.cwd()`)
- ✅ Release pipeline verified end-to-end from monorepo subdirs
- ✅ No new orphan `.cleo/` files created in any package subdir

---

## Dependency on This Audit

T9580 output (this file) is the input for a child orchestration task that will:
1. File 5 Batch-1 sub-tasks (doctor, lifecycle, compliance + tests)
2. File 5 Batch-3 sub-tasks (agent, nexus, dispatch + tests)
3. Propose DRY helpers (resolveOrCwd, getCleoPathNormalized)
4. Create project-root-conventions.md (canonical doc)

No code changes made in this audit (read-only); fixes are scoped for follow-up tasks.

---

**Report Generated:** 2026-05-18  
**Audit Type:** Codebase-wide anti-pattern inventory + risk classification  
**Canonical Reference:** `/mnt/projects/cleocode/.cleo/rcasd/T9580/research/project-root-audit.md`
