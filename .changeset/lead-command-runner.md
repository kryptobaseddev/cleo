---
id: lead-command-runner
tasks: [T14374]
kind: feat
summary: "A lead command runner: one MCP tool (cleo_run, served by cleo orchestrate lead-runner) runs allow-listed cleo and gh argv arrays, never a shell string"
---

A lead has no Bash (`LEAD_DENIED_TOOLS`), yet it dispatches and reviews
through `cleo` and `gh`. This adds its narrow command route:

- **Allow-list (contracts).** `LEAD_COMMAND_ALLOWLIST` names the verbs a lead
  may run: `cleo orchestrate` (except `worktree-complete`, `approve`, `reject`
  and `lead-runner`), `show`, `find`, `list`, `review packet|check|verdict`,
  `done --from-merge --dry-run`, `memory find|fetch`, `briefing`,
  `session status`, `decide ask` and `merge train`; `gh pr
  view|list|checks|diff|comment` and `gh run list|view`. `LEAD_RUNNER_TOOL`
  is the tool's provider name.
- **Runner (core).** `runLeadCommand` checks argv against the allow-list,
  refuses any other binary, verb or shell metacharacter before a process
  starts, and runs the rest with `execFile` (no shell, no stdin).
  `serveLeadCommandRunner` serves it as a one-tool MCP stdio server.
- **Entry (CLI).** `cleo orchestrate lead-runner` starts that server.

Wiring the runner into the delivered lead agent definition follows once the
agent-definition installer (T14378) lands.
