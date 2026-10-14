---
id: t13606-autosync-suppress-all-triggers
tasks: [T13606]
kind: fix
summary: "No automatic cloud sync runs under CI or a test runner, from any trigger"
---

The CI / test-runner guard (`CI`, `VITEST`, `NODE_ENV=test`) stopped only the
command piggyback; the session-end worker and the sentient tick still synced.
The guard now sits in the shared automatic-sync entry point, so every
automatic trigger is suppressed, while an explicit `cleo cloud sync` is
unaffected. `cleo cloud status`'s suppression warning says so.
