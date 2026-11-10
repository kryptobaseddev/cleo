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
`config.json` once. A value already under `orchestrate.contextThresholds` wins,
and any other key left under `orchestrator` is kept, so nothing is lost.
