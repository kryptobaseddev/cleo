---
id: t12864-harness-identity
tasks: [T12864]
kind: fix
summary: "Known single-agent harnesses without a terminal key (Kimi, aider, …), CI jobs and ssh logins keep one session across separate bash -c calls"
---

When no provider key identifies the caller, the terminal identity now walks the process tree (`resolveAncestor`). Matching is by program name: the first word of the command line, or the script or `-m` module that a `node` / `python` runtime runs. The walk:

- skips wrappers (`env`, `timeout`, `npm exec`, `pnpm`, …);
- skips command-string shells, meaning `-c` / `--command` (including after `-o` / `-O` / `--rcfile` arguments) and pwsh `-Command`;
- stops at a long-lived interactive, login or script shell, which becomes the identity;
- stops at a known single-agent harness (claude, codex, aider, gemini, kimi, cursor-agent, amp), whose process becomes the identity. A harness runs every tool call in a fresh `bash -c`, so the old per-call key made a session started in one call invisible to the next.

Two names are left out on purpose. `opencode` serves many sessions and clients from one process (`opencode serve` / `attach`). `goose` is also pressly/goose, the database migration tool.

Any other process gives no key, and the caller keeps the single-session guard. That includes a node or python orchestrator, an IDE extension host, and a daemon that spawns `cleo` directly: such a host may run several agents, which must not share a session. Pid 1, launchd, systemd or init, an unreadable command line, and depth exhaustion also give no key.

**`CLEO_AGENT_ID`:** it names one agent and turns such a host into an identity, one per agent. Set it only in a long-lived host process. With it set, the first non-harness ancestor becomes the anchor, even a short-lived `make`, and the key then changes on every call.

**Behaviour change:** a known harness without a provider key (aider, Kimi, Codex without `CODEX_THREAD_ID`) running in a human's tab or pane no longer shares the human's session. Env tab keys are inherited by every descendant, so the harness now gets its own, more specific pane-tier key and must run `cleo session start` itself. With #1749, its `cleo start` is refused until it does. The same keeps two harnesses in one ssh login or CI step apart.

New environment keys:

- **GitHub Actions:** `GITHUB_RUN_ID`, qualified by `GITHUB_RUN_ATTEMPT` and `GITHUB_JOB`.
- **GitLab CI:** `CI_JOB_ID`.
- **ssh login with a tty:** `SSH_TTY`, qualified by `SSH_CONNECTION`.

`pwsh`, `nu` and `xonsh` join the shell sets.
