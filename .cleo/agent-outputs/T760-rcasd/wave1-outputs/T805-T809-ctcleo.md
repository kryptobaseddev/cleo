# T805-T809 ct-cleo SKILL.md Rewrite — Wave 1 Output

**Tasks**: T805 (SKILL-10), T806 (SKILL-11), T807 (SKILL-12), T808 (SKILL-14), T809 (SKILL-13)
**Date**: 2026-04-15
**Status**: complete

## Files Modified

- `/home/keatonhoskins/.local/share/agents/skills/ct-cleo/SKILL.md` — primary skill file, full rewrite
- `/mnt/projects/cleocode/packages/skills/skills/ct-cleo/SKILL.md` — synced copy in monorepo

## Files Created

- `/mnt/projects/cleocode/packages/skills/skills/ct-cleo/__tests__/ct-cleo-skill.test.ts` — regression test (SKILL-14)

## Changes Applied

### SKILL-10: Decision Tree as First H2

- Moved `## Canonical Decision Tree` to be the first H2 (line 12)
- Moved prior content (`## CLI-First Workflow` and all operation tables) to a `## Reference` section at the bottom
- Added `### Phase Mapping (RCASD-IVTR+C)` table mapping each pipeline phase to commands

### SKILL-11: Pre-Complete Gate Ritual

- Added `## Pre-Complete Gate Ritual` block after the Decision Tree goals
- Five-step ritual: show -> run acceptance criteria -> verify --run -> memory observe -> complete
- Anti-patterns documented inline

### SKILL-12: Multi-Agent Coordination Tree

- Added `## Multi-Agent Coordination` section with >= 5 tasks threshold as root node
- Wave computation sub-tree: orchestrate ready -> spawn -> manifest show
- Gate-failure (IVTR) loop with `cleo orchestrate ivtr --loop-back` and max 2 retry then HITL escalation

### SKILL-13: Greenfield Bootstrap

- Added `## Greenfield Bootstrap (new project)` with copy-paste bash sequence
- Covers: cleo init -> session start -> add epic --lifecycle auto -> docs add -> req add with typed gate -> orchestrate start -> orchestrate ivtr

### SKILL-14: Regression Test

- Created `packages/skills/skills/ct-cleo/__tests__/ct-cleo-skill.test.ts`
- 13 test assertions across 4 describe blocks
- Asserts all 4 required markers present
- Asserts Decision Tree is the first H2
- Asserts `cleo memory observe` used correctly (not bare `cleo observe` in instructions)
- Asserts `cleo orchestrate ivtr` referenced
- Asserts >= 4 distinct `cleo <verb>` patterns
- Asserts all 5 RCASD phases covered

## Proof

```
$ grep -c "Decision Tree\|Pre-Complete Gate Ritual\|Multi-Agent Coordination\|Greenfield Bootstrap" packages/skills/skills/ct-cleo/SKILL.md
5

$ pnpm exec vitest run packages/skills/skills/ct-cleo/__tests__/ct-cleo-skill.test.ts 2>&1 | tail -3
      Tests  13 passed (13)
   Start at  09:29:02
   Duration  727ms (transform 58ms, setup 0ms, import 388ms, tests 4ms, environment 0ms)
```

Note: grep count is 5 because "Decision Tree" appears in both the `## Canonical Decision Tree` H2 and the `- **Decision Tree source**` reference line at the bottom. All 4 unique required markers are present as section headers.
