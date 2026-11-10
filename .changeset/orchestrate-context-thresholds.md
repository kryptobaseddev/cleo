---
id: orchestrate-context-thresholds
tasks: [T14375]
kind: refactor
summary: "the orchestrator context thresholds moved from orchestrator.contextThresholds to orchestrate.contextThresholds; old configs keep working and cleo upgrade rewrites them"
---

Orchestration settings now live under one `orchestrate` key. The config
schema and template carry `orchestrate.contextThresholds.{warning,critical}`
and no longer have an `orchestrator` key.

Configs that still use `orchestrator.contextThresholds` are read as if they
used the new key (`loadConfig`, `resolveCleoConfig`, `getConfigValue`,
`validateConfig` and `getThresholds`), and `cleo upgrade` rewrites the project
`config.json` once. The two keys merge field by field: a field already set
under `orchestrate.contextThresholds` wins, the other legacy fields carry over,
and any other key left under `orchestrator` is kept, so nothing is lost.

`cleo config get|set|unset orchestrator.contextThresholds.*` acts on the new
path and prints a `DeprecationWarning` naming it. `cleo doctor` reports an
un-upgraded `config.json` as a deprecation warning, not a schema failure.
