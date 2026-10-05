---
id: t13184-hotfix-metadata
tasks: [T13184]
kind: feat
summary: A hotfix is flagged in @cleocode/cleo's published manifest by release.yml, from the plan's releaseKind, instead of a manual npm dist-tag
---

Releases are tokenless: npm Trusted Publishing (OIDC) can publish but cannot move dist-tags. The update
notice therefore no longer reads a `hotfix` dist-tag.

For a release planned with `cleo release plan <v> --hotfix`, release.yml writes
`"cleo": { "hotfix": true }` into `@cleocode/cleo`'s package.json before the tarball gates, using
`scripts/mark-hotfix-release.mjs` to read the committed plan's `releaseKind`. The ordinary publish
ships it. A regular release has any stale flag removed. A missing plan, as in a break-glass dispatch,
counts as regular. A malformed plan fails the step.

The daily background check now also reads the `latest` version's registry manifest. It remembers the
highest flagged version it has seen, so a regular release that follows a hotfix does not hide that
hotfix from an install still missing it. The manual dist-tag step is gone from the release runbook and
the verb matrix.
