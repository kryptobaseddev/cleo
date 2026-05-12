# T777 SKILL-01: ct-cleo/SKILL.md Preamble Rewrite

**Task**: Rewrite ct-cleo skill preamble with decision tree as first H2 section.
**Status**: complete
**Worker**: T777 (SKILL-01)
**Epic**: T767 Guidance Surface Hardening

## Change Made

**File**: `/mnt/projects/cleocode/packages/skills/skills/ct-cleo/SKILL.md`

Inserted `## Decision Tree` as the first H2 section immediately after the skill header and intro paragraph. The previous first H2 (`## CLI-First Workflow`) was preserved and remains intact after the new section.

## Decision Tree Content

The 6-step decision tree covers:
1. Session state check (start/resume flow)
2. Task count threshold (≥5 children → orchestrate)
3. Work phase mapping (research/implementation/bug fix paths)
4. Pre-complete gate ritual (show → verify → observe → complete)
5. Failure handling (retry max 2, then HITL escalation)
6. Multi-agent coordination (orchestrator vs worker roles)

## Verification

- First H2 is `## Decision Tree`: PASS
- Decision tree includes session state check: PASS
- Decision tree includes task count threshold: PASS
- Decision tree includes coordination mode: PASS
- Preamble references T763 gate contract (via T781 placeholder): PASS (T781 referenced in step 4)
- Skill file line count: 514 lines (< 3000): PASS
- All existing content preserved below Decision Tree section: PASS

## Files Modified

- `/mnt/projects/cleocode/packages/skills/skills/ct-cleo/SKILL.md` (514 lines, +32 lines inserted)
