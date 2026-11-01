---
id: t14169-detached-stdin
tasks: [T14169]
kind: fix
summary: "cleo run no longer hands a detached child the terminal on stdin, which aborted Node 26 at startup"
---

A `cleo run` child runs in its own session (setsid) unless `--foreground` is
given. It inherited the runner's stdin, so a terminal there (VidaPeps had
`/dev/tty`) reached a session with no controlling terminal. There `tcgetattr`
fails with EIO, and Node 26 aborts in PlatformInit (`node.cc:621`, "Assertion
failed: (err) == (0)").

A detached child now gets /dev/null on stdin when the runner's stdin is a
terminal, and the run says so. A pipe or file on stdin is still passed on, so
`--passthrough` keeps piping input. `--foreground` keeps the terminal as before.
