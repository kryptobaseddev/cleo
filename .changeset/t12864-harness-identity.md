---
id: t12864-harness-identity
tasks: [T12864]
kind: fix
summary: "Harnesses without a terminal key (Kimi, aider, OpenCode, Gemini CLI, CI, cron) keep one session across separate bash -c calls"
---

When no provider, pane or tab variable identifies the caller, the terminal identity now falls back to the nearest long-lived ancestor process, not the immediate parent. That ancestor is one of:

- an interactive, login or script shell;
- past per-call `sh -c` / `bash -c` shells and thin wrappers, the first other process, which for an agent harness is the harness itself (even a `node` or `python` one).

Such harnesses run every command in a fresh `bash -c`. The old fallback keyed on that throwaway shell, so a session started in one call was invisible to the next. The new key (`proc:<pid>@<start>`) is stable across calls from one harness process and differs between harness processes.

The walk returns no key, so the caller keeps the single-session guard, when it:

- reaches pid 1, launchd, systemd or init (a daemon or service job);
- cannot read a shell's command line;
- runs past the depth limit.

New environment keys:

- **GitHub Actions:** `GITHUB_RUN_ID`, qualified by `GITHUB_RUN_ATTEMPT` and `GITHUB_JOB`, so each job has one identity.
- **GitLab CI:** `CI_JOB_ID`.
- **ssh logins with a tty:** `SSH_TTY`, qualified by `SSH_CONNECTION`.

Separate one-shot `ssh host 'cleo …'` calls are separate callers and still need `CLEO_SESSION_ID`.
