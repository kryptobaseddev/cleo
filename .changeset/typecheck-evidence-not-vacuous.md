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
run — then the language default. The node `typecheck` default switches to
`tsc -b --noEmit` (or `tsc -b` before TypeScript 5.6) for a references-only root
config. Resolution provenance gains a `package-script` source.

A new guard fails a `tool:` atom with `E_EVIDENCE_TOOL_VACUOUS` when a `tsc`
step provably checks nothing: a non-build `tsc` whose config is
references-only (checked before any cache lookup, so a cached vacuous pass is
never served), or a direct `tsc` run whose `--listFilesOnly` probe reports zero
project files. The cache key already covers the resolved command and args, so
the new command never reuses an entry recorded for the old one.
