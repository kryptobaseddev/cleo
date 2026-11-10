---
id: orchestrate-lead-entrypoint
tasks: [T14363]
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
- **Command runner.** On claude-code the lead gets `--mcp-config` for
  `cleo orchestrate lead-runner` and `--allowedTools mcp__cleo-lead__cleo_run`.
- **Mailbox.** The project lead mailbox is claimed for a pre-assigned
  session id (`claude --session-id`) before the lead starts; a failed claim
  is reported under `data.lead.mailbox` and does not stop the spawn.
- **No worktree, no worker record.** A lead writes nothing, so it runs in the
  project root and is never auto-integrated. Workers it dispatches keep
  fail-closed isolation, durable worker records and the report contract.

ct-lead (1.2.0) and ct-orchestrator (4.4.0) describe the structural policy;
ct-lead no longer names the nonexistent `delegate_task` tool.
