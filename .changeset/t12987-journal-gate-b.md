---
id: t12987-journal-gate-b
tasks: [T12987]
kind: test
summary: "Sync journal S3d: Gate B for the change journal replays every sealed op from genesis and the ops after a checkpoint onto earlier copies, and both must fingerprint equal to the source (fingerprint-store.mjs gains --canon-timestamps); CI runs it on fixtures shaped like cleocode, llmtxt and claude-todo, and scripts/sync-gate-b.mjs runs it on real store snapshots."
---
