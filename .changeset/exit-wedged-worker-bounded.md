---
id: exit-wedged-worker-bounded
tasks: [T14670]
kind: fix
summary: "a CLI command no longer hangs at exit behind a worker thread stuck in native code, and SIGTERM ends it"
---

`cleo review verdict` printed its envelope and then stayed resident for 7 days,
ignoring SIGTERM, with two defunct children. `process.exit` joins every live
worker thread (`Worker::JoinThread`, a `pthread_join` with no timeout); a worker
blocked in native code never stops, so the main thread waited in exit forever.
A thread blocked there runs no libuv loop, so finished children are never
reaped and JS signal listeners never run. The listeners still replace each
signal's default action, so SIGTERM did nothing.

- The CLI's error exit (`settleThenExit`), the teardown backstop and the
  sentient daemon's shutdown now exit through core `exitProcess`. With a
  tracked worker alive, it restores the default SIGTERM/SIGINT/SIGHUP action,
  terminates the tracked workers within 2 s, and kills itself (status 137) if
  one is still running, instead of joining it forever.
- Every worker thread is tracked: the BRAIN writer, the embedding queue, the
  census prune worker, the background skill-review worker and the nexus parser
  pool. Nexus registers its workers through a `globalThis` set keyed by
  `EXIT_WORKER_REGISTRY_KEY` in contracts `exit-codes`.
- Core installs no process-lifetime SIGTERM/SIGINT listener (`bounded-git` and
  `run-governed` keep scoped ones only while a child call is live). Telemetry's listener only started
  a flush, so a command that recorded telemetry ignored SIGTERM. The BRAIN
  writer's and the embedding queue's listeners exited any host that loaded
  them, cutting short the daemon's own shutdown (the Studio stop and the lock
  release). The host now owns its signals.
- Post-build Checks runs `scripts/smoke-review-verdict-exit.mjs`. It runs the
  built `cleo review verdict` in a sandbox store with a stub `gh` and a valid
  packet, and fails unless each verdict exits 0 within its bound, calls
  `gh pr view` and `gh pr diff`, writes its verdict row and leaves no defunct
  child.
