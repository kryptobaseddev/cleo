---
id: resolve-facts-from-target
tasks: [T12176]
kind: fix
summary: A check that takes a target resolves its facts from that target, or says it cannot — nexus status stops answering about the ambient project, and pr:<n> stops borrowing cleocode's own gate names
---

A check that takes a target resolves its facts from that target, or says it cannot (gh#1329, gh#1323)

Two surfaces had the same defect: given a target, they answered about the
ambient project instead, and the answer was well-formed enough to be believed.

**`cleo nexus status`** reported `indexed: true` with this project's 26,964
nodes for `/definitely/not/a/real/repo`, under a `projectId` correctly derived
from the bogus path — so the command knew it was being asked about somewhere
else and answered about here. It is also the MANDATED first call for the whole
nexus subsystem, written so an agent does not misread `E_NOT_FOUND`, which makes
a confident false `yes` the failure it was meant to prevent. Now: a path that is
not a directory is refused before any id is derived, and a `--project-id` that
differs from the one derived for this project is refused, because the graph DB is
project-scoped (ADR-090 · T11648) and the id cannot select a store.

**The `pr:<n>` evidence atom** resolved its required-workflow names from
*cleocode's own gates* (`CI`, `Lockfile Check`, `Contracts Dep Lint`) whenever no
tier declared them. In any other project those checks do not exist, so every
`pr:` atom was refused with `E_EVIDENCE_TESTS_FAILED` — a code asserting the
checks ran and failed, when the truth is that CLEO looked for another codebase's
gates. Measured on a consuming repo with Actions removed entirely: zero workflow
files, zero check-runs, and 37 tasks blocked on an atom that could never pass.

Required workflows now resolve to an explicit `unknown` tier instead of
borrowing, and the atom refuses with `E_EVIDENCE_INSUFFICIENT` naming every way
to declare them — including the empty array that means "this project requires
none", which then lets a MERGED PR satisfy the atom alone.

**BREAKING for projects that relied on the implicit default.** A repository that
requires checks must now name them (`release.prRequiredWorkflows` in
`.cleo/project-context.json`, `CLEO_PR_REQUIRED_WORKFLOWS`, or branch
protection, which CLEO reads from the target repo). cleocode declares its own
list in this change — a default only one repository can satisfy is that
repository's configuration, not a library default.
