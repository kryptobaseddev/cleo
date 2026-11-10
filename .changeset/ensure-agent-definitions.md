---
id: ensure-agent-definitions
tasks: [T14378]
kind: feat
summary: "cleo init and cleo upgrade write the canonical cleo-lead and cleo-worker agent files for every detected provider with project agent-file support (Claude Code, OpenCode) and report the rest as unsupported"
---

`initAgentDefinition` looked for an `agents/cleo-subagent/` directory that no
package ships, so it skipped on every run and no project ever got an agent
definition. It is removed. In its place:

- **Canonical definitions.** `@cleocode/agents` ships `definitions/cleo-lead.cant`
  and `definitions/cleo-worker.cant`. The lead talks to the owner and dispatches
  workers; its tools are `Agent`, `SendMessage`, `AskUserQuestion` and the mbx
  tools, and it is denied `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
  `WebFetch` and `WebSearch`. The worker keeps every tool, runs in the
  background, and returns a three-line report of at most 100 words.
- **Provider facts (CAAMP).** A registry entry may declare `agentDefinitions`
  (`pathProject`, `format`). Only Claude Code (`.claude/agents`) and OpenCode
  (`.opencode/agents`) declare it, both checked against their docs. CAAMP reads
  the definitions without the native CANT parser and renders each provider's
  format (`parseAgentDefinition`, `renderAgentDefinition`).
- **Delivery (core).** `ensureAgentDefinitions` runs from init and upgrade. It
  writes a file only when its content changed, so a second run does nothing. It
  never overwrites a file that lacks CLEO's generated marker, backs up replaced
  files in the upgrade journal, and reports every detected provider without
  agent-file support as unsupported.
