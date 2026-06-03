---
id: t11672-interactive-output-class
tasks: [T11672]
kind: feat
summary: cleo llm login and llm refresh-catalog now emit a friendly line on a terminal and a JSON envelope when piped or under --json (interactive-output class)
---

Adds an interactive-output command class (SG-PROVIDER-AUTH-UNIFICATION E7). startCli feeds the LAFS resolver TTY->human fallback ONLY for human-facing command paths (llm login, llm add, llm refresh-catalog, setup, init, and the forthcoming cleo login/auth login), gated on stdout.isTTY so piped/CI/agent invocations keep the agent-first JSON default. cleo llm login and llm refresh-catalog migrated off hand-rolled stdout writes to the shared cliOutput/humanLine path, so they are now agent-parseable when piped. New module packages/cleo/src/cli/lib/interactive-commands.ts + unit tests. No behavior change for non-interactive commands or non-TTY contexts.
