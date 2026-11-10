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
- **Command runner, strict MCP.** On claude-code the lead starts with
  `--mcp-config <file> --strict-mcp-config`: the file names ONLY the runner
  (`cleo orchestrate lead-runner`) and the user's mbx server, resolved like
  Claude Code (local, project `.mcp.json`, user). No other user MCP server
  loads (T14423). `--allowedTools` pre-approves the runner tool and `mcp__mbx`.
  Without mbx the lead gets the runner alone and `data.lead.mcpWarning` says so.
- **Mailbox.** The project lead mailbox is claimed for a pre-assigned
  session id (`claude --session-id`) before the lead starts; a failed claim
  is reported under `data.lead.mailbox` and does not stop the spawn.
- **No worktree, no worker record.** A lead writes nothing, so it runs in the
  project root and is never auto-integrated. Workers it dispatches keep
  fail-closed isolation, durable worker records and the report contract.

ct-lead (1.2.0) and ct-orchestrator (4.4.0) describe the structural policy;
ct-lead no longer names the nonexistent `delegate_task` tool.
