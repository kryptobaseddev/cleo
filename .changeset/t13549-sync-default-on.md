---
id: t13549-sync-default-on
tasks: [T13549]
kind: feat
summary: Sync is released and on by default; cleo login nexus leaves a linked project syncing with no enable step
---

`sync.seal`, `sync.push`, `sync.pull` and `sync.strict` leave `UNRELEASED_FLAGS`. The set is now empty and kept for future unfinished flags.

`cleo login nexus` turns sync on for the project and the account's home stream once the project is linked, whether it was just backed up, restored, or was already linked. A store that already holds data joins an existing stream through the merge join, so nothing local is lost.

`cleo sync enable push` turns capture and sealing on before its genesis cut, and pull once the cut is pushed. It is now a complete enable on its own.

Opt out with `cloud.autoSync: false` or `CLEO_DISABLE_AUTO_SYNC=1`. CI and redirected-stderr logins still only print. A failure to turn sync on warns (`W_NEXUS_FIRST_RUN_SYNC`) and never fails the login.

Background auto-sync (session end, the sentient tick, normal commands) becomes live, because its unreleased guard no longer holds.
