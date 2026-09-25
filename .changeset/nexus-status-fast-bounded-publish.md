---
id: nexus-status-fast-bounded-publish
tasks: [T12348]
kind: perf
summary: "`cleo nexus status` no longer shells out to git for every indexed file, and graph publication writes a third of the pages without locking the global store"
---

**`cleo nexus status` took 107–148 s on this repository.** A CPU profile of
one 107 s run put 60.9 s in `spawnSync` (`git check-ignore`, asked again about
every one of 5,691 already-indexed files, in 23 batches), 10 s in a synchronous
`existsSync` per directory inside `fs.glob`'s `exclude` callback, and 33 s idle
waiting on serial filesystem calls on the FUSE mount.

- The freshness walk (`walkRepositoryPaths` with `knownFiles`) reads
  directories in parallel instead of through `fs.glob`, answers the
  nested-repository probe from the directory listing, and asks git only about
  files the manifest does not already know. In-repository ignore files are
  still evaluated for every path. A test proves it yields exactly the index
  walk's files, sizes and hashes.
- The CLI shim sets `UV_THREADPOOL_SIZE=64` unless the operator set one, so
  more than four `stat`s are in flight at once. On the FUSE mount the status
  check measured 5.7–6.5 s with 4 threads and 1.4–1.9 s with 64.

**Publishing a generation rewrote 1.6 M pages' worth of syscalls.**

- The retained reference list (453 MB of JSON) is stored gzip-compressed
  (28 MB). Plain-text lists written before this change are still read.
- The FTS shadow is cleared before the node rows, so the delete trigger does not
  re-tokenize every old node, and the write transaction raises its page cache
  (restored afterwards) so SQLite stops spilling and re-reading dirty pages.
  Together: 766k read and 848k write syscalls per publish become 267k and 241k,
  and the WAL shrinks from 723 MB to 316 MB.
- Publication used `BEGIN IMMEDIATE`, which write-locks every ATTACHed database,
  including the global `cleo.db` mounted as `nexus_global`. That is why
  `cleo nexus projects clean` failed with "database is locked" while an
  analysis ran. It now locks the project store only.
