---
id: t13813-pull-delivered-files
tasks: [T13813]
kind: fix
summary: cloud pull no longer treats a doc body the journal delivered as a local change, so a peer can pull and then push without --force
---

When another device added a doc, `cloud sync` delivered its body into
`.cleo/blobs/blobs/`, byte for byte the file the other device's snapshot
holds. `cloud pull` then refused ("files or databases changed since its last
cloud sync"), and `cloud push` refused because that snapshot held files this
device lacked. Without `--force` the device could do neither.

A pull now judges each local change against the head snapshot's copy: a file,
or another database, that already equals the head's is not a change to keep.
A new local file the head does not have is not one either: the pull never
touches it, and it travels in this device's next snapshot. So when both devices
add a doc between syncs, the pull still goes through. Only a local change to a
file the head also holds refuses the pull. After the pull, the push goes
through.
