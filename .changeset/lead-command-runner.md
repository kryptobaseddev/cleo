---
id: lead-command-runner
tasks: [T14374]
kind: feat
summary: "A lead command runner: one MCP tool (cleo_run, served by cleo orchestrate lead-runner) runs allow-listed cleo and gh argv arrays, never a shell string"
---

A lead has no Bash (`LEAD_DENIED_TOOLS`), yet it dispatches and reviews
through `cleo` and `gh`. This adds its narrow command route:

- **Allow-list (contracts).** `LEAD_COMMAND_ALLOWLIST` is allow-only at
  every level: each rule names a leaf command (`cleo orchestrate` read, plan
  and dispatch sub-verbs; `show`, `find`, `list`, `review packet|check|verdict`,
  `done --from-merge --dry-run`, `memory find|fetch`,
  `session status`, `decide ask`, `merge train`; `gh pr
  view|list|checks|diff|comment` and `gh run list|view`), its flags with
  arity, its positional count and its required flags; `gh` takes only a
  numeric PR or run id. A test checks every `cleo` rule against the CLI
  command manifest: a leaf command, flags of matching arity.
  `LEAD_CLEO_GLOBAL_FLAGS` lists the output flags any cleo command may add.
  `LEAD_RUNNER_TOOL` is the tool's provider name.
- **Runner (core).** `runLeadCommand` checks argv against the allow-list,
  parses the rest against the rule (a flag before the subcommand, an unknown
  flag, any `--no-*` form, or a missing or swallowed value is refused), refuses
  command separators and redirection in the binary and command words (values
  pass verbatim) before a process starts, and runs the
  rest with `execFile` (no shell, no stdin).
  `serveLeadCommandRunner` serves it as a one-tool MCP stdio server.
- **Entry (CLI).** `cleo orchestrate lead-runner` starts that server.

Wiring the runner into the delivered lead agent definition follows once the
agent-definition installer (T14378) lands.
