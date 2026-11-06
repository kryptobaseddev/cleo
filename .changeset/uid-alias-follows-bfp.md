---
id: uid-alias-follows-bfp
tasks: [T14335]
kind: fix
summary: "a sync re-key that moves a row's birth fingerprint is now followed with it, and conduit doc versions and approvals follow a re-keyed doc"
---

When one device re-keyed a row to another device's uid, the peer that had
already staged changes against the old uid remapped them to the new uid but
kept the old birth fingerprint. The remapped row then collided with the
winner and collision-settle forked it to a random uid, leaving two rows.

- The local `_sync_uid_alias` journal records the re-key's new birth
  fingerprint (`new_bfp`), and `followUidAliases` carries it with the uid on
  every hop, so the staged change lands on the winner's row.
- Row identity gains `uidRefs`: columns that hold another table's uid
  verbatim. `conduit_attachment_versions.attachment_uid` and
  `conduit_attachment_approvals.attachment_uid` declare it, so a staged
  version or approval follows a re-keyed conduit doc instead of pointing at a
  uid that no longer exists.
- The wire format is unchanged. A peer that has not upgraded keeps today's
  behaviour until it does.
