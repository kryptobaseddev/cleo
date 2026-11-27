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

- The CLI's error exit (`settleThenExit`) and the teardown backstop now exit
  through core `exitProcess`. With a tracked worker alive it restores the
  default SIGTERM/SIGINT/SIGHUP action, terminates the BRAIN writer and
  embedding workers within 2 s, and kills itself (status 137) if one is still
  running, instead of joining it forever.
- Telemetry no longer installs SIGINT/SIGTERM listeners. They only started a
  flush, so a command that recorded telemetry ignored SIGTERM.
- The BRAIN writer's signal handler now exits (143/130) after its flush.
  Before, it cleared its own deadline and returned.
