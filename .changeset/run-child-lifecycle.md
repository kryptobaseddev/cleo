---
id: run-child-lifecycle
tasks: [T14080, T13002, T12994]
kind: fix
summary: "cleo run stops its child when its own parent dies, delivers a group signal to a nested child once, and re-checks nesting on each queue poll after a ps failure"
---

- **Parent death (T14080).** When the shell wrapping `cleo run` was SIGKILLed
  (a harness TaskStop), the runner was orphaned and its detached child group
  kept running. On each supervision poll the runner now compares its parent
  pid with the one it started under. Once the parent is gone it sends the
  child group SIGCONT then SIGTERM, and SIGKILL after 10 s. The exit path then
  releases the ledger charge and removes the job record.
- **Single delivery (T13002).** A runner that forwards a signal to its
  child's whole group records it in its job record. A nested runner in that
  group skips forwarding the same signal if it arrived within 2 s, and skips a
  SIGINT its enclosing foreground (terminal) group already delivered. A
  signal sent to the nested runner alone is still forwarded, so a nested
  child no longer gets a second SIGINT (force-quit for some runners).
- **Nesting re-check (T12994).** When the first nested-run detection fails
  because `ps` failed, it is retried on every queue poll, in both the ledger
  queue and the governor (db-heavy) queue. A nested run then rides its parent
  instead of waiting on it until its own timeout.
