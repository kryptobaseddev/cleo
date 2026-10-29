---
id: release-cut
tasks: [T14102]
kind: feat
summary: "cleo release cut releases main's newest commit with green CI in one command: no plan PR, no bump PR, no test rerun"
---

`cleo release cut <version>` picks the newest first-parent commit of
`origin/main` whose required `CI` check run concluded `success` (`--sha` pins
one, which must itself be green). It renders the notes from the changesets
added since the previous release tag, led by `--lead <file>`, and creates the
annotated tag `v<version>` on that commit through the GitHub API. The tag push
starts `release.yml`, which writes the CHANGELOG section
(`cleo release write-changelog`), publishes, and, for a stable release, opens a
`release/v<version>` PR with only the CHANGELOG section and the version bump.
That PR merges itself on green and never blocks the release. No test suite
reruns: main CI already passed that tree.

- Nothing is tagged without `--yes` (owner decision D11212). Without it the
  cut reports and prints the exact confirm command, pinned to the previewed
  commit. With `--yes` it asks on the controlling terminal (`/dev/tty`) and
  tags only when the version is typed exactly; with no terminal it refuses
  with `E_RELEASE_NOT_AUTHORIZED` until a standing release authorization
  exists (T14141). The audit row records which path allowed the cut.
- `--dry-run` shows the commit and its CI state, the notes, the packages with
  their versions, new migrations, and each named task's status, and tags
  nothing.
- Task status is reported, not gated. Green CI on the commit is the gate, and
  a changeset must have arrived through a merged PR
  (`E_RELEASE_UNMERGED_CHANGESET`). With no green commit the cut refuses with
  `E_RELEASE_NO_GREEN_COMMIT`.
- A real stable cut refuses with `E_DOCS_ROT` before tagging while
  `cleo docs rot` reports stale, duplicate or orphaned docs; on a prerelease
  the findings are a warning only. The dry run shows them either way.
- The version must be CalVer for this month and above every release tag and
  main's `package.json`. The commit must be first-parent on `origin/main`
  with every `release.prRequiredWorkflows` check (app-pinned, push run) green,
  judged again right before the tag. Each real cut is audited in
  `.cleo/audit/release-cut.jsonl`. `release.yml` runs
  `cleo release verify-tag` before publishing, so a hand-pushed or dispatched
  tag on an untested tree never ships.
- Rollback: before publish, cancel the release run and delete the tag
  (`git push origin :refs/tags/v<version>`); after publish, fix forward. If
  the CHANGELOG + version PR job fails, re-run it or open the PR by hand with
  `cleo release write-changelog <version> --ref v<version>`.
- `cleo release reconcile` records provenance for a cut release as before; it
  builds its plan from the tag when no plan file exists.
- `cleo release plan`, `open` and `release-prepare.yml` keep working for one
  release as a fallback (T14114 removes them).
