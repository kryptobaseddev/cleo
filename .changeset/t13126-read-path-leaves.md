---
id: t13126-read-path-leaves
tasks: [T13126]
kind: fix
summary: Every cleo command loads less; cleo --version drops to 64 modules and about 55 MB
---

Several always-loaded modules imported heavy code that only a rare branch uses.
Each one now loads that code only when the branch runs:

- **Human renderers.** The CLI renderers loaded all of CORE's human renderers (`render/index`,
  ~57 modules) for every command, including JSON output and `cleo --version`. They now load
  on the first human-format output. The output-contract table, needed only when a `--field`
  pointer fails, loads on that failure.
- **One copy of drizzle.** The store opened databases with drizzle's CommonJS build while the
  schema used its ES module build: two copies of drizzle (~300 extra modules) in every
  command that opened a store. The store now loads the ES module build
  (`store/drizzle-node-sqlite.ts`).
- **Zod-free leaves on the read path:**
  - acceptance-criterion identity hashing (`tasks/ac-identity.ts`)
  - an epic's lifecycle status (`lifecycle/status.ts`, which no longer pulls in stage guidance,
    skill discovery and CAAMP)
  - the docs lifecycle statuses the operation registry reads (`contracts/operations/docs-lifecycle.ts`)
- **CAAMP's Pi harness** loads the cant parser only when it validates or counts a `.cant`
  profile, so every CAAMP import stops loading the cant bundle.
- **The module-resolve fast path** caches each bare specifier per package root, not per
  directory. Node re-parsed a package's whole `exports` map for every directory that
  imported it (nodejs/node#66485).

`cleo --version` loads 64 modules instead of 233 (about 55 MB instead of 80). Read verbs need
the lazy-dispatch change to drop further. Output is unchanged: 38 commands compared, human
output included. Gate 39 lowers the `--version` budget to 80 modules and forbids the
renderer entry point in `--version` and `--help`.
