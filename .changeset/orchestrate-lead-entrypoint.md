---
id: orchestrate-lead-entrypoint
tasks: [T14363, T14423]
kind: feat
summary: "cleo orchestrate lead <epic> spawns the no-hands lead behind orchestrate.leadWorker.v1: no Bash, Edit or Write, and the lead runner as its one command tool"
---

`cleo orchestrate lead <epicId>` composes the lead/worker pieces of epic
T14351. It refuses with `E_LEAD_WORKER_DISABLED` unless
`orchestrate.leadWorker.v1` is on, and with `E_VALIDATION` for a non-epic.

- **Tool strip.** `orchestrateSpawnExecute` takes a `lead` option and sets
  `CLEOSpawnContext.leadDeniedTools` to `LEAD_DENIED_TOOLS`, so the spawn
  bridge strips them or refuses the provider (`E_LEAD_TOOLS_UNSTRIPPED`,
  now kept as the envelope code instead of `E_SPAWN_FAILED`).
- **Allow list, not a deny list.** On claude-code the lead gets no built-in
  tool (`--restricted --tools ""`), `--permission-mode dontAsk` and
  `--setting-sources ""` (a user's `bypassPermissions` cannot apply), with
  `LEAD_DENIED_TOOLS` still in `--disallowedTools` as a second layer. Its
  prompt is the appended system prompt (`--append-system-prompt-file`).
- **Strict MCP.** `--mcp-config <file> --strict-mcp-config`: the file names
  ONLY the runner (`cleo orchestrate lead-runner`, carrying the lead's CLEO
  identity) and the user-level mbx server. mbx is read only from
  `~/.claude.json` user scope, never a repo's `.mcp.json` or project entry,
  and must be the `agentmbx` binary on an absolute path outside the project
  with args `mcp`; otherwise it is refused with `data.lead.mcpWarning` (T14423).
- **Role and session.** The lead's prompt is composed with role `lead`, which
  now reaches the prompt builder, so the ct-lead excerpts load; the lead runs
  under its own allocated CLEO session (`CLEO_SESSION_ID` in its env).
- **Mailbox.** Claimed for the lead's pre-assigned session (`claude
  --session-id`) only after the spawn is admitted; a second lead on a held epic
  is refused (`E_LEAD_RUNNING`). The lead's `SessionStart` hook deletes the MCP
  config file (it may hold mbx env secrets); its `SessionEnd` hook removes the
  temp dir, ends its CLEO session and releases the mailbox.
- **No worktree, no worker record.** A lead writes nothing, so it runs in the
  project root and is never auto-integrated. Workers it dispatches keep
  fail-closed isolation, durable worker records and the report contract.

ct-lead (1.2.0) and ct-orchestrator (4.4.0) describe the structural policy;
ct-lead no longer names the nonexistent `delegate_task` tool.
