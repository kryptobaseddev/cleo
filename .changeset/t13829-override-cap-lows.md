---
id: t13829-override-cap-lows
tasks: [T13829]
kind: fix
summary: "An unconfirmed owner enrollment no longer sets the override cap, and any committed owner-settings.json in git history marks a re-enrollment unconfirmed"
---

These are follow-ups from the round-4 review of #2296.

An enrollment that replaced another without proof of the previous owner
(`resetFrom`) now leaves `evidence.overrideCapPerSession` at 10, with a warning
and an audit line, until `cleo config owner-enroll --confirm`. Before, a value
sealed by the new key took effect at once.

The git signal for an earlier enrollment now reads the whole history
(`git log --all`), not only HEAD. Deleting `.cleo/owner-settings.json` in a
commit, then removing the global record, no longer re-enrolls as a clean
`enrolled`.
