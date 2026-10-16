---
id: t12914-release-sync-coverage
tasks: [T12914]
kind: feat
summary: "Releases, lifecycle stages, PRs and commits reach a second device: their 16 tables get row uids and sync"
---

The lifecycle (pipelines, stages, gate results, evidence, transitions), release
(releases, release commits, changes, changesets, artifacts), PR (pull requests,
PR commits, PR tasks) and commit (commits, commit files, task commits) tables
now carry row uids, so they are captured and travel on `cloud sync`. Before
this none of them had a uid, so a release planned on one device never reached
another, and the typed `release.status.absorbing` merge rule never fired across
devices (Stage C gate). It now does: a release pushed on one device stays
pushed when another device concurrently cancels or re-plans it.

A release's uid comes from its version, so the same release planned on two
devices is one row instead of one device losing its row to the UNIQUE version
index. A release id embeds the path-derived project hash, so each device keeps
its own local id, and a received release takes its uid as its id; releases are
always found by version. A child row added on one device while another device
deletes its parent is recorded as a revivable dangling-ref conflict on both
devices, never dropped silently or left as an orphan. `cleo release cancel` now
deletes a release's children before the release, and `cleo release plan` writes
its changesets under the stored release id. The migration
`20261015100000_t12914-lifecycle-release-row-uids` adds the columns and unique
indexes.

Known gaps, filed under T12323: a raw cascade delete of a release with children
can still stop a pull on rewind (T13762); the same PR reconciled on two devices
with different project hashes is two rows (T13763); brain release links name a
device-local release id (T13764); lifecycle ids embed task display ids
(T13765).
