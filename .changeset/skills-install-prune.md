---
id: skills-install-prune
tasks: [T12678]
kind: fix
summary: Skill install quarantines bundled skills CLEO no longer installs, only when its install ledger proves CLEO wrote them unmodified; restore with cleo skills doctor restore
---

`initCoreSkills` installed skills but never removed any, so a skill later
declared `internal` (ct-grade) or retired (the manifest's new
`retiredSkills`) stayed in every harness.

Ownership comes only from CLEO's bundled-install ledger. On every install,
CLEO writes `<skills root>/.cleo-bundled.json` with a SHA-256 of each file it
wrote. The canonical skills root is shared with every CAAMP user install, so
neither location nor a link into the root proves anything. A skill is
quarantined only when all of these hold:

- the ledger records it;
- its CAAMP lock entry, if any, has source `library:<name>`;
- its skills.db row, if any, is `canonical`;
- its files still match the recorded hashes.

For such a skill, harness links that point exactly at its canonical copy, and
copies that match the recorded hashes (Pi), are quarantined with it. User
installs, edited copies, links pointing elsewhere, and skills installed before
the ledger existed are kept and reported.

Nothing is deleted:

- Owned paths move to `<CLEO home>/skills-quarantine/<id>/` with a
  `quarantine.json`.
- The library lock entry is removed and the skills.db row is archived, both
  recorded for restore.
- A receipt line is appended to `<skills root>/.prune-receipts.jsonl`.

New commands:

- `cleo skills doctor prune [--dry-run]` runs the prune on demand.
- `cleo skills doctor restore [<id>]` lists quarantines or reverses one: files,
  links, lock entries, skills.db state and ledger records. If a path has been
  re-created since, it is reported as a conflict and left alone.

`cleo install-global --dry-run` previews the prune.
