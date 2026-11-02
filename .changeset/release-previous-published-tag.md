---
id: release-previous-published-tag
tasks: [T14173]
kind: fix
summary: "cleo release cut, write-changelog and reconcile skip a previous tag whose release never published"
---

A tag whose `release.yml` run failed before creating its GitHub Release
(v2026.11.1-canary.1) became the base of the next release, so canary.2's notes,
CHANGELOG section and reconcile range dropped its 76 changesets and tasks.

- `cleo release cut` and `cleo release write-changelog` pick the newest
  reachable lower tag with a published (non-draft) GitHub Release, and refuse
  when `gh` cannot read one. A stable cut still skips every prerelease tag.
- `cleo release reconcile` skips such a tag when inferring its previous tag;
  a tag `gh` cannot judge is kept.
- release.yml's write-changelog step gets `GH_TOKEN` to read the releases.
