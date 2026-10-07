---
id: t13281-changeset-lint-in-ci
tasks: [T13281]
kind: fix
summary: every changeset is parsed inside required CI, so a broken one fails the PR instead of the release
---

Release Readiness was the only pull-request check that ran `scripts/lint-changesets.mjs`,
and nothing requires it. A changeset with invalid frontmatter, such as an unquoted `: `
in the summary (#1879, #1907), could merge green and then break the release.

The new `Changeset Lint (T13281)` job in `ci.yml` runs the lint on every PR, and the `CI`
aggregate needs it, so a broken changeset fails the required `CI` check. The job reuses
the shared build output when the build ran. When the build was skipped, as on a
changeset-only or docs-only PR, it runs the build itself.
