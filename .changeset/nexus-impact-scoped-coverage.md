---
id: nexus-impact-scoped-coverage
tasks: [T14365]
kind: fix
summary: "`cleo nexus impact` judges coverage by the target's and callers' files, so one failed file elsewhere no longer empties every answer; the reply's coverage block is bounded"
---

- **Scoped coverage.** Each coverage gap that belongs to one file is now
  attributed to that file. `nexus impact` reports the strongest of the
  project-level status and the status of the target's file and each traversed
  caller's file. Before this fix, one file that failed extraction anywhere
  (123 `E_PARSE_SYNTAX` files in this repo) marked the whole project `failed`,
  and every impact answer came back empty with `UNKNOWN`. Now gaps in
  unrelated files make the answer `partial`, with one reason that counts those
  files and how many failed. A failed target or caller file still gives
  `failed` and its reason. Anything short of `current` stays `UNKNOWN`, never
  `NONE`.
- **Bounded reply.** The default reply carries a coverage sample (10 reasons,
  3 limitations, `reasonCount`, `detailsCommand`) instead of the full project
  assessment, which was about 891 KB here. `--coverage-detail` returns every
  reason and limitation, including those of unrelated files.
