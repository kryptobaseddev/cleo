---
id: manifest-scoped-stand-in
tasks: [T14163]
kind: fix
summary: "a merged change whose only workspace-wide paths are the root package.json dependencies and the pnpm lockfile is scoped by the lockfile importers it touched"
---

A dependency bump touches `pnpm-lock.yaml`, a path outside every workspace
package, so a targeted `test-run:` could not speak for the change and only
the whole suite (or merged CI with `evidence.ciSatisfies`) could. A project
with no required CI (`release.prRequiredWorkflows: []`) could not close such
merged work without a whole-suite run.

After the merge, the T13673 stand-in (a targeted test-run on the default
branch after the merge) now scopes such a change by the lockfile importers
the merge changed: a passing test file is owed in each importer's package
(the root importer counts as every package), its dependents and the change's
own packages. `cleo complete` records why on the stored testsPassed
evidence (`standIn: {kind: 'manifest-scoped', mergeCommit, importers,
recordedAt}`), so the reason outlives the command. Any
other root `package.json` field (such as `scripts`), any lockfile change no
changed importer accounts for (settings, overrides, catalogs, an unreachable
package or snapshot) and other lockfiles keep the change workspace-wide.

CLEO-REFERENCE now states that `pr:<n>` proves provenance only and never
satisfies `testsPassed` or `qaPassed`.
