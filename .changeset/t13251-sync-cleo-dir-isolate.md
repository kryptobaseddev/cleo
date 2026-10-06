---
id: t13251-sync-cleo-dir-isolate
tasks: [T13251, T13246]
kind: fix
summary: only the brain writer isolate re-points CLEO_DIR to each op's project; other worker threads keep their own
---

`handleWriteOp` re-pointed `CLEO_DIR` to `<op.projectRoot>/.cleo` in **any** worker thread
(`!isMainThread`). A non-writer worker, such as embedding-queue or background-review, can run
the inline fallback. When it did, its `CLEO_DIR` stayed pinned to the last op's project, and
anything it later resolved from `CLEO_DIR` targeted that project. The re-point now runs only in
the brain writer isolate (`isBrainWriterIsolate()`, the flag from T13246).
