---
id: sync-exec-sigkill-bound
tasks: [T14670]
kind: fix
summary: "a synchronous gh, git or ps call can no longer block the CLI past its timeout"
---

`execFileSync` and `spawnSync` send their timeout signal (SIGTERM by default)
to the direct child only, then wait for that child to exit. A `gh` or `git`
that ignores or outlives SIGTERM (a shim that traps it, a credential helper,
a pager grandchild holding stdout) kept the main thread blocked for as long as
it lived. While blocked, the CLI reaped no finished children and ran no signal
listener, which is the state the 7-day `cleo review verdict` was found in.

Every synchronous `gh`, `git` and `ps` call (198 call sites) now passes its
options through `boundedExecOptions` from `@cleocode/paths`:

- `killSignal: 'SIGKILL'`, which cannot be ignored. Once the child is gone the
  sync runner closes its pipes and returns, even when a grandchild still holds
  stdout.
- A 10-minute timeout for a call that names none.
- `GH_PAGER`, `GIT_PAGER` and `PAGER` set to `cat`, `NO_COLOR`,
  `GH_PROMPT_DISABLED` and `GIT_TERMINAL_PROMPT=0`.

The CLI hook's `ps` call and the two nexus `git` probes set SIGKILL inline,
because those modules do not load `@cleocode/paths`.
