---
id: release-changelog-tag-fetch
tasks: [T14171]
kind: fix
summary: "release.yml's write-changelog step no longer fails silently on a cleo release cut tag"
---

The checkout in release.yml leaves the release tag as a lightweight ref, so
the step's `git fetch --tags` rejected the annotated tag (`would clobber
existing tag`) and exited 1 with no output, before `cleo release write-changelog`
ran (v2026.11.1-canary.1). The step now fetches tags with `--force` and prints
an error when the fetch still fails.
