---
id: skills-cleanup-t12679
tasks: [T12679]
kind: fix
summary: Skills record agent output with cleo docs add instead of raw .cleo/agent-outputs writes; provider-skills-map.json removed; gate 30 resolves camelCase constants and ignores tripwires inside strings
---

The LOOM, executor, orchestrator and shared protocol skills told agents to
write findings to `{{OUTPUT_DIR}}/<date>_<slug>.md`, meaning
`.cleo/agent-outputs`. The CLEO protocol forbids raw writes there. They now
record output with
`cleo docs add {{TASK_ID}} --content - --type <kind> --slug <slug>`, using
`research`, `plan` or `note` as the skill fits. Token tables keep the
`{{OUTPUT_DIR}}` row, marked legacy.

`packages/skills/provider-skills-map.json` is deleted. Nothing read it, and
`dispatch-config.json` was removed in T12649. The ct-skill-author docs now say
the validator's `--dispatch-config` and `--provider-map` tiers apply only to
external libraries.

Gate 30 changes:

- **Constants:** it resolves any identifier passed as a skill name to a
  same-file `const`/`let` string, so `const leadSkill = 'ct-ghost'` no longer
  slips through. An unbound CONSTANT_CASE name still fails; an unbound
  camelCase parameter is not judged.
- **Tripwires:** its install tripwires must appear as code, so a tripwire
  quoted inside a string literal no longer passes.
