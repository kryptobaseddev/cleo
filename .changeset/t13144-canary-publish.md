---
id: t13144-canary-publish
tasks: [T13144]
kind: feat
summary: Stable releases publish under the npm dist-tag canary; latest moves only through the approval-gated release-promote workflow after a sandbox soak, and rolls back by the same workflow with the previous version
---

A bad release used to reach every user at once, because `release.yml`
published each stable version straight to `latest`. It now publishes under
`canary`, so `npm i -g @cleocode/cleo` keeps resolving the previous release
until the new one is promoted. Prereleases keep `beta` and `dev`.

`release-promote.yml` (manual dispatch, input `version`) moves `latest`:

- The `plan` job holds no secrets. It checks that every package resolves at the
  version (metadata and tarball), that every package's `canary` is the version,
  and that the release's installability verdict is green. The verdict is read
  only from the release run on the tag (its `Release Verdict` job, or a
  successful `Publish` with a `pending` deploy summary in the run's own
  artifact, after which the live check decides). The run must have run the
  tag's own commit; a run on another ref, a branch named like the tag, and the
  editable tracking issue never count. Then it installs the version into a
  sandbox and runs health checks (`scripts/release-canary-soak.mjs`). Both
  block; nothing continues on error.
- The `promote` job runs in the `npm-promote` environment, which waits for the
  owner's approval and alone holds `NPM_TOKEN` (trusted publishing cannot move
  a dist-tag). It re-checks the plan, runs `npm dist-tag add` per package in
  publish order with `@cleocode/cleo` last, and waits until `latest` resolves
  everywhere. A re-run skips packages already moved and finishes a promotion
  already under way even after a newer canary arrived.
- A version older than `latest` is a rollback: the canary requirement does not
  apply, everything else does, and nothing is republished.

`scripts/release-canary-soak.mjs` installs `@cleocode/cleo@<version>`
globally into a throwaway prefix with throwaway stores, checks that every
installed @cleocode package is at that version, then runs `--version`, `init`,
`session start`, a saga and epic write, `show`, `find` and `doctor`. Run it
locally before approving: `node scripts/release-canary-soak.mjs`.

The installability watcher's manual dispatch defaults to the `canary` tag. The
isolated environment shared by the packed-install smoke and the soak moved to
`scripts/lib/sandbox-env.mjs`, unchanged.

Owner setup and the procedure: `docs/release/merge-queue-runbook.md`,
"Canary soak and promotion".
