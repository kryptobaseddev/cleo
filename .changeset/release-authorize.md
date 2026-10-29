---
id: release-authorize
tasks: [T14141]
kind: feat
summary: "cleo release authorize lets the owner grant agents a signed, expiring standing authorization for cleo release cut --yes"
---

`cleo release authorize --scope <canary|prerelease|stable|version> --expires
<30m|24h|7d> --reason <why> [--uses <n>]` grants a standing release
authorization (owner decision D11215). Only the owner can grant one: the
command needs a terminal and the owner-auth password of an `--owner-auth`
session, and the project must be owner-enrolled (`cleo config owner-enroll`).
The grant is signed with the enrolled owner key, kept in
`.cleo/release-authorizations.json` and the global store, recorded as an owner
decision, and audited in `.cleo/audit/release-authorizations.jsonl`.

- With an active grant covering the version, a non-interactive
  `cleo release cut --yes` (an agent) tags without a typed confirmation. The
  cut audit row records `allowedBy: authorization:<id>` and the tag message
  carries `Authorized-by: <id>`.
- Expiry is required, at most 30 days. There is no use limit unless `--uses`
  sets one; uses are counted from the cut audit rows and the tags.
- `--revoke <id>` ends a grant now; restoring an old copy of the project file
  does not revive it. `--list` shows each grant as active, expired, used up or
  tampered.
- A grant edited by hand, missing from one of its two files, or not signed by
  the enrolled key is ignored, audited, and reported by `cleo doctor`.
- Without a grant or a terminal, `cut --yes` refuses and names the scope to
  grant.
