---
id: logger-sync-writes-quiet
tasks: [T14644]
kind: fix
summary: "@cleocode/core: Ctrl-C ends the CLI at once during synchronous waits again, and --quiet hides the file logger's start-up warnings"
---
- The file logger writes each line synchronously, so it needs no
  SIGINT/SIGTERM listener to flush on exit; the listener had delayed Ctrl-C
  until synchronous work (`Atomics.wait`, long SQLite calls) ended.
- `--quiet` is applied before the file logger starts, so the unknown-level
  and "File logger not started" warnings stay off stderr, and the logger
  starts at `silent`.
