---
id: t12864-harness-identity
tasks: [T12864]
kind: fix
summary: "Known single-agent harnesses without a terminal key (Kimi, aider, OpenCode, …), CI jobs and ssh logins keep one session across separate bash -c calls"
---

When no provider key identifies the caller, the terminal identity now walks the process tree (`resolveAncestor`). Matching is by program name: the first word of the command line, or the script / `-m` module a `node` / `python` runtime runs. The walk:

- skips wrappers (`env`, `timeout`, `npm exec`, `pnpm`, …);
- skips command-string shells, meaning `-c` / `--command` (including after `-o` / `-O` / `--rcfile` arguments) and pwsh `-Command`;
- stops at a long-lived interactive, login or script shell, which becomes the identity;
- stops at a known single-agent harness (claude, codex, aider, gemini, kimi, opencode, cursor-agent, goose, amp), whose process becomes the identity. A harness runs every tool call in a fresh `bash -c`, so the old per-call key made a session started in one call invisible to the next.

Any other process gives no key, and the caller keeps the single-session guard. That includes a node or python orchestrator, an IDE extension host, and a daemon that spawns `cleo` directly: such a host may run several agents, which must not share a session. `CLEO_AGENT_ID` names the agent and makes such a host an identity, one per agent. Pid 1, launchd, systemd or init, an unreadable command line, or depth exhaustion also give no key.

Env tab keys are inherited by every descendant. A harness, or a `CLEO_AGENT_ID` agent, below one therefore gets its own more specific key, so two harnesses in one ssh login, CI step or tab stay apart.

New environment keys:

- **GitHub Actions:** `GITHUB_RUN_ID`, qualified by `GITHUB_RUN_ATTEMPT` and `GITHUB_JOB`.
- **GitLab CI:** `CI_JOB_ID`.
- **ssh login with a tty:** `SSH_TTY`, qualified by `SSH_CONNECTION`.

`pwsh`, `nu` and `xonsh` join the shell sets.
