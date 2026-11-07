---
id: t14341-hook-subagent-identity
tasks: [T14341]
kind: fix
summary: "the Claude Code hook gives a subagent's cleo command its own CLEO_AGENT_ID from the hook's agent_id, never past a permission rule"
---

Claude Code exports no per-subagent environment variable, so Agent-tool
teammates (which inherit the lead's `CLAUDE_CODE_SESSION_ID`) all acted as one
CLEO identity. CLEO's PreToolUse hook now reads the call's `agent_id` and, for
a `cleo` command from a subagent that names no identity itself, runs it as
`export CLEO_AGENT_ID='<agent_id>'; <command>`, so per-agent claims and focus
(T14269) work for hand-run teammates too. The main thread is unchanged.

The rewrite follows the heavy-command rules, so permission matching still
judges the original command:
- never past a deny or ask rule in the Claude Code settings that could match
  it (a denied command stays denied);
- in `default`, `acceptEdits`, `dontAsk` and `auto` mode only when the user's
  allow rules already approve the command as written (answering `allow`);
  `bypassPermissions` and `auto` otherwise rewrite;
- otherwise, and in warn mode, the command runs as written and the agent gets
  a context line telling it to export `CLEO_AGENT_ID` itself.
