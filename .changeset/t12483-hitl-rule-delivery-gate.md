---
id: t12483-hitl-rule-delivery-gate
tasks: [T12483, T12481]
kind: chore
summary: arch gate 27 fails CI when the owner ask-tool HITL rule is missing from any agent delivery surface
---

New `scripts/lint-hitl-rule-delivery.mjs`, bundled in `cleo check arch` as
gate-27 and documented as AGENTS.md row 27. It checks short, stable marker
phrases of the owner rule (every owner decision goes through the harness ask
tool with options, never prose; subagents relay to the orchestrator;
`hitl.request` when no ask tool exists) on every surface an agent reads: the
CLEO-INJECTION.md template, the ct-cleo and ct-orchestrator skills, and the
spawn-prompt Return Format Contract emitted at tiers 0-2.
