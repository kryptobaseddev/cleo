---
id: t13468-auto-brain-sync
tasks: [T13468]
kind: feat
summary: "Automatic main-brain sync at session end and while the sentient daemon runs"
---

With `sync.push` or `sync.pull` on, `cloud sync` now runs without the user typing it: in the detached session-end worker after its snapshot, and from the sentient daemon process (polled once a minute, throttled to `CLEO_AUTO_SYNC_INTERVAL_MIN` minutes, default 15; `0` turns it off). No new daemon, server or connection, and it never runs in the process of the command that triggered it. It is single-flight across processes, admitted by the governor as `db-heavy` (skipped under pressure) and bounded to 2 minutes. A store with no sync flag, a signed-out device or an unlinked project is a quiet skip; any other failure is recorded in `<CLEO_HOME>/auto-sync.json` and shown once as `W_AUTO_SYNC_FAILED` in `cleo cloud status` until a sync succeeds.
