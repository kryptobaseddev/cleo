---
id: vault-docs-bytes-test
tasks: [T13704]
kind: test
summary: "Prove cloud vault snapshots carry the docs databases and bytes, so docs fetch works after cloud restore onto a new device"
---

`cleo cloud push` already snapshots the whole project `.cleo/` section except
`backups/`, `cache/`, `logs/` and `locks/`. That covers `blobs/manifest.db`
and `attachments/index.db` (taken with VACUUM INTO) and the byte trees
`blobs/blobs/<sha>` and `attachments/...`, which travel as plain files. A
restore checks each file's size and SHA-256 before it places anything. If any
check fails, the restore places nothing, so it can never report success with
missing bytes.

Two new tests run against the fake Nexus server. In the first, device A adds
a doc and pushes; a fresh device restores and the blob store returns
byte-identical content. In the second, a snapshot with one blob byte flipped
is refused with `E_BUNDLE_INTEGRITY` and nothing is placed.
