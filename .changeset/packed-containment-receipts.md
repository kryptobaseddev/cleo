---
id: packed-containment-receipts
tasks: [T12303]
kind: fix
summary: "Retain packed setup failures and exact process containment receipts"
---

Create the packed smoke manifest before its first Git probe so unavailable
hard limits leave a failed manifest, script and lock hashes, and diagnostics.
The CI artifact also retains each command capture and the runtime scope,
process result and independently observed cleanup under its existing retention
policy.
