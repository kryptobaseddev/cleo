---
id: t13553-piggyback-sync
tasks: [T13553]
kind: feat
summary: Normal commands in a linked project start a detached cloud sync at most once per window, with no daemon
---

A command in a project linked to Cleo Nexus now starts a detached
`autoCloudSync` child (reason `command`) when the window has elapsed: at most
once per `CLEO_AUTO_SYNC_INTERVAL_MIN` (default 15 minutes), the same way the
presence refresh piggybacks. The command's own path costs one `stat` of
`<CLEO_HOME>/auto-sync-command.stamp` and never waits for the child. The child
shares `autoCloudSync`'s throttle and cross-process lock, so session end, the
sentient tick and commands never sync twice; offline, signed out, unlinked or
no store syncing is a quiet skip with no network call.

Turn it off with `cleo config set cloud.autoSync false`, per shell with
`CLEO_DISABLE_AUTO_SYNC=1`, or entirely with `CLEO_AUTO_SYNC_INTERVAL_MIN=0`.
It never starts inside a governed heavy or evidence run (`CLEO_RUN_CLASS`), or
for `cleo run`, `cleo verify` and `cleo cloud`.
