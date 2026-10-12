---
id: t13556-piggyback-sync-lows
tasks: [T13556]
kind: fix
summary: "Command piggyback sync: per-project throttle, debug line on failure, verb after global options"
---

The background sync that piggybacks on ordinary commands now throttles each
linked project separately, so a busy project no longer starves another's
sync. A worker that cannot start logs one `CLEO_DEBUG` line instead of failing
silently, and the command's verb is read as the first token naming a root
command, so a leading global option's value is never mistaken for it.
