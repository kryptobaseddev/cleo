---
id: typecheck-evidence-not-vacuous
tasks: [T12633]
kind: fix
summary: tool:typecheck runs the project's own script and rejects runs that provably checked nothing (E_EVIDENCE_TOOL_VACUOUS)
---

In a project-references monorepo, `tool:typecheck` resolved to the node default
`npx tsc --noEmit`. Against a references-only root tsconfig (`"files": []` plus
`references`) TypeScript compiles zero files outside build mode, so the command
exited 0 in 0.34s having checked nothing. Every `qaPassed` gate recorded with
`tool:typecheck` in such a project was validated against a no-op.

Resolution order is now: an explicit `.cleo/project-context.json` command, then
the project's `package.json` script of the canonical name (`test`, `build`,
`lint`, `typecheck`) run through its package manager — so `pre`/`post` hooks
run — then the language default. Scripts and `tsconfig.json` are read from the
tree the tool runs in (the worktree), and a declared `packageManager` that is
not installed falls back to `npm run`. Resolution provenance gains a
`package-script` source.

For a references-only root config the node `typecheck` default is now
`tsc -b`, which EMITS (`dist/`, `.tsbuildinfo`). `tsc -b --noEmit` is not used:
on a chain of composite projects it fails TS6310 ("Referenced project may not
disable emit") on correct code. Untracked build output does not move the
evidence cache key, whose dirty-tree fingerprint is `git diff HEAD`.

The tool runs the project's own script, so a script that writes files (for
example a `lint` script that auto-fixes) edits the checkout; a later
`cleo complete` then fails `E_EVIDENCE_STALE`. Keep verification scripts
read-only, or declare a read-only command in `.cleo/project-context.json`.

A new guard fails a `tool:` atom with `E_EVIDENCE_TOOL_VACUOUS` when a `tsc`
step provably checks nothing: a command with no build-mode `tsc` step whose
`tsc` targets a references-only config (checked before any cache lookup, so a cached vacuous pass is
never served), or a direct `tsc` run whose `--listFilesOnly` probe reports zero
project files. The cache key already covers the resolved command and args, so
the new command never reuses an entry recorded for the old one.
