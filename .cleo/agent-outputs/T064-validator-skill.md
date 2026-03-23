# T064: ct-validator Skill for Gate Enforcement

## Summary

Created a focused ct-validator skill that enforces the mandatory CLEO workflow gates (WF-001 through WF-005). The skill replaces the prior general-purpose compliance validator with four targeted validation modes: pre-flight checks, gate status inspection, gate suggestion, and full compliance reporting.

## Deliverables

### ct-validator SKILL.md

Rewrote `packages/skills/skills/ct-validator/SKILL.md` from a general schema/code/document validator into a gate enforcement skill scoped to CLEO task workflow rules.

**File affected:**
- `packages/skills/skills/ct-validator/SKILL.md`

**Key changes from prior version:**
- Bumped version from 2.0.0 to 3.0.0
- Changed tier from 2 to 1 (gate enforcement is core workflow, not advanced)
- Changed `core: false` to `core: true`
- Replaced general validation capabilities with four targeted modes
- Added trigger keywords in the description for provider auto-loading
- References `@skills/_shared/task-system-integration.md` as the WF rule SSoT
- Removed subagent-protocol-base dependency (skill is loaded directly, not spawned as subagent)

## Acceptance Criteria Verification

| Criterion | Status | Notes |
|-----------|--------|-------|
| ct-validator skill file created with proper frontmatter | PASS | Frontmatter includes name, description, version, tier, core, category, protocol, dependencies, sharedResources, compatibility, license |
| Pre-flight, gate check, gate suggestion, and compliance sections | PASS | Four named modes: Mode 1 (Pre-Flight), Mode 2 (Gate Status), Mode 3 (Gate Suggestion), Mode 4 (Full Compliance Report) |
| References WF rules from _shared/task-system-integration.md | PASS | `@skills/_shared/task-system-integration.md` reference at top of skill body |
| Trigger keywords defined for auto-loading | PASS | Trigger keywords listed in description and in dedicated "When to Load" section |

## Implementation Notes

- The existing SKILL.md had a description focused on schema/code/document/protocol validation. The new description is rewritten to reflect gate enforcement and includes explicit trigger phrases that provider auto-loading systems can match against user intents.
- The four validation modes mirror the natural workflow checkpoints: before starting (pre-flight), during implementation (gate status + suggestion), and after completion attempt (compliance report).
- CLI commands reference `cleo verify {{TASK_ID}} --gate <name>` as documented in the _shared/task-system-integration.md SSoT.
- The anti-patterns table maps each pattern to the specific WF rule it violates, making remediation self-evident.

## Linked Tasks

- Epic: T056 (Task System Hardening)
- Task: T064
- Dependencies: T063 (task-system-integration.md WF rules), T058 (AC Enforcement Layer), T061 (Verification Gate auto-initialization)
