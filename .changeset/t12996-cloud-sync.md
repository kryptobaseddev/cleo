---
id: t12996-cloud-sync
tasks: [T12996]
kind: feat
summary: "`cleo cloud sync` - seal, push, pull and apply each attached stream in one call, one result per stream"
---

`cleo cloud sync [--scope project|global]` runs the change journal end to end for each attached stream: the project's and the
account's global store, or just the one `--scope` names (T12996).

- **Per stream:** it seals pending writes, pushes them as segments (`pushSyncStream`), pulls the stream's new segments, and applies
  them (`pullSyncStream`).
- **One LAFS envelope** (`CloudSyncResult`) reports, per stream:
  - `status`: `synced`, `disabled`, `paused` (device clock ahead), `not-attached` or `refused`;
  - sealed, built, sent, duplicates, received, staged, redelivered, applied, held and conflict counts;
  - the staged position against the server's head.
- **`E_SYNC_DISABLED`** is returned, naming `cleo sync enable push`, when no attached stream has `sync.push` or `sync.pull` on. A store
  with `sync.pull` off now refuses its pull before it looks for a pull position.
- **An interrupted run resumes on the next:** a segment is resent with the same bytes, and a transaction is never staged or applied
  twice.
- `sync.push` and `sync.pull` stay unreleased: the CLI never opts in, so stores can't turn them on yet.
