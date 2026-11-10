---
id: orchestrate-lead-entrypoint
tasks: [T14363, T14423]
kind: feat
summary: "cleo orchestrate lead <epic> [--detached] starts the no-hands lead behind orchestrate.leadWorker.v1: interactive in the terminal by default, an allow list of the runner, mbx and AskUserQuestion"
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
- **Two modes.** Interactive (default): the lead opens in the caller's
  terminal (no `--print`, stdio inherited, not detached) with
  `AskUserQuestion` as its only built-in tool. `--detached`: a background run
  with no built-in tool; owner decisions go to the `owner` AgentMBX mailbox
  as a `hitl.request` `{question, options[{label, description}], recommended}`;
  it acts only on a reply whose mbx header shows `authority: OWNER`. Without
  a loaded mbx server `--detached` refuses (`E_LEAD_NO_OWNER_CHANNEL`).
- **Mailbox and one lead per epic.** The mailbox is claimed once the spawn is
  admitted (claude `--session-id`) and released when the lead exits. A lead
  record (`.cleo/leads/<epic>.json`) names the `cleo` CLI and the `claude`
  lead process, each with its start time; a second lead gets `E_LEAD_RUNNING`
  while either lives (not a 30-minute lease), and a reused pid never counts. A lead killed by SIGKILL or OOM is reaped by the next
  `cleo orchestrate lead` or `cleo orchestrate status`: mailbox released, CLEO
  session ended, temp dir removed. The lead's `SessionStart` hook deletes the
  MCP config file; `SessionEnd` removes the temp dir, ends its session and
  releases the mailbox, with `cleo` and `agentmbx` as absolute paths resolved
  at spawn time from absolute PATH entries.
- **No worktree, no worker record.** A lead writes nothing, so it runs in the
  project root and is never auto-integrated. Workers it dispatches keep
  fail-closed isolation, durable worker records and the report contract.

ct-lead (1.3.1) and ct-orchestrator (4.5.1) describe the structural policy;
ct-lead no longer names the nonexistent `delegate_task` tool.
