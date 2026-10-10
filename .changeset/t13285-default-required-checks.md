---
id: t13285-default-required-checks
tasks: [T13285]
kind: fix
summary: the built-in required-check list is cleocode's real gates (CI, Contracts Dep Lint); it no longer names Lockfile Check, a check that never reported
---

`PR_REQUIRED_WORKFLOWS` is cleocode's own list of required checks. It is not a default
for other repositories: since gh#1323, `pr:` and `ci:` evidence returns `unknown` when
no environment variable, project-context entry or branch protection names the required
checks, and never applies this list to another repository.

The list now contains cleocode's real check names, `CI` and `Contracts Dep Lint`.
`Lockfile Check` is dropped because no check ever reported under that name; its job is
`Verify pnpm-lock.yaml consistency`, and `CI` covers it (T13279).

Two tests pin this. One checks that every name on the list is a job or workflow name in
cleocode's `.github/workflows/`. The other checks that the async resolver still returns
`unknown` rather than this list.
