---
id: packed-containment-receipts
tasks: [T12303]
kind: fix
summary: "Bound Git wrapper recursion and retain packed process containment receipts"
---

Create the packed smoke manifest before its first Git probe so unavailable
hard limits leave a failed manifest, script and lock hashes, and diagnostics.
The CI artifact also retains each command capture and the runtime scope,
process result and independently observed cleanup under its existing retention
policy.

An inherited Git-shim hop budget also bounds delegation through non-exec
wrappers that break parent-PID continuity, while preserving identity checks,
Git hook reentry and role policies.
