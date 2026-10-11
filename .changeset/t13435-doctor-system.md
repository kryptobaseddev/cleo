---
id: t13435-doctor-system
tasks: [T13435]
kind: feat
summary: "`cleo doctor system`: machine and project health in one ranked, read-only report, with the exact remedy for each finding"
---
On 2026-10-10 one Mac sat at 24 of 25 GB swap with load 24. The causes were one stdio MCP set per harness session (49 playwright-mcp, 33 mcpvault, about 60 agentmbx), 475 dangling docker volumes and long-running throwaway Postgres containers, and typechecks started outside `cleo run`. No single command could see any of it.

`cleo doctor system` returns a LAFS envelope with `findings[]`, ranked by severity and then by memory impact. Each finding carries `severity`, `evidence`, a `remedy` (the exact command, or a manual step) and `needsOwnerChoice`, so the running agent knows when to ask the owner before acting. `coverage[]` marks every check `ok`, `skipped` or `error`, so a missing finding is not mistaken for a healthy check.

The checks:
- memory pressure, using the governor's own classifier; swap; load per core
- MCP servers per name, with counts and RSS
- heavy jobs whose ancestry has no `cleo run` and that are not in the admission ledger
- dangling docker volumes, build cache, and database containers outside compose running over 12 hours
- agent sessions and their idle RSS
- indexer CPU, plus Spotlight and Time Machine over the project's node_modules (macOS)
- the cgroup memory guard (Linux)

The command is read-only and never signals a process. It exits 1 when a finding is critical.
