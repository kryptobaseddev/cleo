---
id: t13868-concurrent-first-doc-update
tasks: [T13868]
kind: fix
summary: concurrent first docs updates on two devices no longer wedge the second device's stream with "FOREIGN KEY constraint failed"; doc version links travel as uids
---

When two devices each made their first `docs update` of the same synced doc,
the second device's project stream failed with "FOREIGN KEY constraint
failed" on every later `cloud sync`. The peer's segment stayed staged and the
doc diverged.

- **The wedge.** To apply the peer's earlier segment, the second device
  rewinds its own local transaction. The rewind undid its INSERT of the doc
  row (`conduit_attachments`), but skips append-only children, so its own
  `conduit_attachment_versions` rows still pointed at the doc and the
  immediate foreign-key check refused the delete. Rewind, apply and replay
  share one transaction, so the rewind now defers foreign keys to COMMIT,
  as the applier already does for a key move. The doc row is back (from the
  stream or the replay) before the check runs.
- **Version links arrived as NULL.** `conduit_attachment_versions` and
  `conduit_attachment_approvals` declared their uid columns
  (`attachment_uid`, `parent_version_uid`, `version_uid`) as references.
  References are translated through the target's LOCAL key (`slug`, `id`),
  so the sealer found no row and sent NULL, and every peer stored versions
  with no doc and no parent. Those columns already hold uids, so they now
  travel verbatim, as `conduit_doc_heads` and the slug aliases already do.
- **A refused apply names the row.** When a deferred foreign key still fails
  at COMMIT, the refusal names the child row's uid and its parent table
  (`E_SYNC_APPLY_FK`) instead of a bare "FOREIGN KEY constraint failed".

A store already wedged retries the staged segment on its next sync and
applies it. Version and approval rows that peers already stored with a NULL
link are not rewritten by this change. The device that wrote them now hashes
its own rows with the link included, so the next migration pass on that
device marks the two tables for repair. The repair then journals each row once
with its real link, and that fills in the NULLs on peers. This is a one-time
update burst on those rows. Their append-only rules are declared but not
enforced, so peers apply it.
