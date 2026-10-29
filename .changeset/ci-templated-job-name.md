---
id: ci-templated-job-name
tasks: [T14148]
kind: fix
summary: "ci: evidence matches a templated matrix job name by its static prefix, so a scripts- or docs-only PR's skipped Type Check counts as skipped"
---

`cleo done --pr` refused qaPassed on a scripts-only PR with "job Type Check:
not found in .github/workflows/ci.yml". A matrix job skipped before its
matrix expands reports its raw `name:` template as its check name
(`Type Check${{ matrix.node … }}`), so the literal "Type Check" glob missed it,
the job looked missing instead of skipped, and the `scripts/**` covering rule
never applied. A check name containing a GitHub expression now matches a
configured job by its static prefix, the same job its rendered variants run as.
