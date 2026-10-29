---
id: main-rerun-own-group
tasks: [T14136]
kind: fix
summary: "a rerun of an older main CI run gets its own concurrency group, so it never cancels or is cancelled by the live main push group"
---

T14103 put main push runs in one shared concurrency group: the running run
finishes, and a newer push cancels the run still waiting. A rerun of an older
main run (`run_attempt` > 1), started to give a cancelled merge commit its own
green result, joined that same group. It then cancelled the waiting run for
the newest commit, or was cancelled by the next push. Such a rerun now gets
the group `-push-rerun-<sha>`, and a first-attempt run keeps the shared group
unchanged.
