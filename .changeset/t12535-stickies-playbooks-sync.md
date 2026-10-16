---
id: t12535-stickies-playbooks-sync
tasks: [T12535]
kind: fix
summary: "Project sticky notes, playbook runs and playbook approvals reach a second device"
---

Project sticky notes and their tags, playbook runs and playbook approvals now
carry row uids, so their writes are captured and reach another device after
`cloud sync`. The Stage C gate found that none of them traveled: the project
sticky tables and both pairs of playbook tables had no row identity.

Playbooks now read and write `tasks_playbook_runs` and
`tasks_playbook_approvals`. The first open on this release copies every row of
the old `playbook_runs` and `playbook_approvals` tables into them (where both
hold a run with different values, the old table's copy wins and the other is
kept under `twin_collapse_archive_rows:playbook_runs`), then freezes the old
tables. An older CLEO that tries to start a playbook run or record an approval
in this project gets a message asking for the upgrade instead of writing rows
this release never reads. Deleting a run now deletes its approvals explicitly.

An approval's resume token travels sealed on the stream, like the credential
tables' secrets, so it is written only by `cloud sync`. Migration
`20261016120000_t12535-playbook-row-uids` adds the uid columns and unique
indexes.
