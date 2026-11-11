---
id: t14455-orca-worker-recovery-cli
tasks: [T14455]
kind: feat
summary: "Orca worker recovery: inspect and replay exact saved attempts through the CLI"
---

Adds cleo orchestrate worker <action> <recordId> for show, paged read, recover-start, recover-stop, retry and guarded stop. The command reloads durable dispatch bindings and preserves unknown-outcome fencing, circuit breakers, claims and dirty checkouts. Automatic launch routing and harness rotation remain separate work; no real worker is launched by fixtures.
