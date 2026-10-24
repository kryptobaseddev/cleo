---
id: nexus-registry-dead-rows
tasks: [T14011]
kind: fix
summary: "`cleo nexus status` reports unreachable registry rows; `projects clean --unhealthy` matches them"
---

`cleo nexus status` now carries a `registry` block: registry rows (vault
placeholders excluded) by recorded health, the unreachable count, and the
`cleo nexus projects clean --orphans --dry-run` command that classifies them
when any exist. Nothing is probed or removed by the status.

`cleo nexus projects clean --unhealthy` matched `health_status = 'unhealthy'`, a
value the registry never stores, so it never matched. It now matches rows
recorded unreachable whose path no longer answers; a row whose path still
answers, has moved, or cannot be read is kept, as with `--orphans`.

**Upgrade warning:** `projects clean --unhealthy` was a no-op until now. A
script that already passes it will start removing registry rows after this
upgrade. Run it with `--dry-run` first: registry rows record no host yet, so a
row for a project that lives only on another machine can match.
