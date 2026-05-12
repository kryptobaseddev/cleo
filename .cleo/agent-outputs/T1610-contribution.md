# T1610 Contribution: Physical Guard Against Deprecated Markdown Handoff

**Task**: T1610 — T-FOUND-V2-7: physically prevent reading deprecated markdown handoff as canonical state
**Status**: Completed
**Branch**: task/T1610
**Commit**: 90e2bd0f98d526769f56101b25ba71a7847beb0c

## What Shipped

### 1. Redirect Stub Installation (Core)

Added `installHandoffRedirectStubs()` to `packages/core/src/init.ts`:
- Detects `NEXT-SESSION-HANDOFF.md` and `HONEST-HANDOFF-*.md` files in `.cleo/agent-outputs/`
- Replaces any that still contain narrative state with a pure redirect stub
- Stub contains only "run cleo briefing" instruction — no state
- Idempotent: files already stubbed are left alone

Wired into:
- `initProject()` in `packages/core/src/init.ts` — runs on `cleo init`
- `runUpgrade()` in `packages/core/src/upgrade.ts` — runs on `cleo upgrade`
- Exported via `packages/core/src/internal.ts`

### 2. Template for Redirect Stub

Created `packages/cleo/templates/HANDOFF-REDIRECT-STUB.md` — the canonical redirect stub
template that documents the pattern for future projects.

### 3. CLEO-INJECTION.md — HARD PROHIBITION

Updated `packages/core/templates/CLEO-INJECTION.md` and `~/.cleo/templates/CLEO-INJECTION.md`:

Added new section before Session Start:
```
## MANDATORY: Run `cleo briefing` BEFORE Any Other Tool

**HARD PROHIBITION**: BEFORE any tool use other than `cleo briefing`, the orchestrator
MUST run `cleo briefing` first.
```

Also reordered Session Start to put `cleo briefing` as step 1 with label:
```
**FIRST COMMAND IS ALWAYS `cleo briefing`** — no exceptions.
```

### 4. HONEST-HANDOFF-2026-04-28.md Replaced

Replaced `.cleo/agent-outputs/HONEST-HANDOFF-2026-04-28.md` with a redirect stub.
The original file contained 200+ lines of historical architectural audit data that
was causing fresh agents to read it as canonical state.

## Acceptance Criteria Verification

1. **Deprecated handoff files are redirect-stubs** — NEXT-SESSION-HANDOFF.md was already a
   stub (verified); HONEST-HANDOFF-2026-04-28.md replaced with stub in this task.

2. **cleo init/upgrade auto-installs redirect-stubs** — `installHandoffRedirectStubs()` is
   called from both `initProject()` and `runUpgrade()`.

3. **CLEO-INJECTION.md updated with HARD prohibition** — Added "MANDATORY: Run cleo briefing
   BEFORE Any Other Tool" section with explicit prohibition on reading markdown files.
   Session Start reordered to list `cleo briefing` as step 1.

4. **Sibling task T1616 compatibility** — Changes are additive: `installHandoffRedirectStubs()`
   is a new standalone function, `computeBriefing()` in `briefing.ts` is untouched.

## Files Changed

- `.cleo/agent-outputs/HONEST-HANDOFF-2026-04-28.md` — replaced with redirect stub
- `packages/core/src/init.ts` — added `installHandoffRedirectStubs()`, `HANDOFF_REDIRECT_STUB`, `DEPRECATED_HANDOFF_PATTERNS`; wired into `initProject()`
- `packages/core/src/upgrade.ts` — imported and wired `installHandoffRedirectStubs()`
- `packages/core/src/internal.ts` — exported `installHandoffRedirectStubs`
- `packages/core/templates/CLEO-INJECTION.md` — HARD prohibition section + Session Start reorder
- `packages/cleo/templates/HANDOFF-REDIRECT-STUB.md` — new redirect stub template

## Quality Gates

- biome ci: passed on all 3 modified TS files (0 errors, 1 info-level message)
- Pre-existing build failures in lafs/validation packages are unrelated to T1610
- Pre-existing test failures (3 of 11882) are pre-existing, not introduced by T1610
