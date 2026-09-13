---
id: decision-only-gates-and-pr-inertness
tasks: [T12125]
kind: fix
summary: decision-only tasks can complete without testsPassed/qaPassed, and pr:-atom inertness in CI-less repos is documented (gh#1215, gh#1224)
---

**gh#1215.** ADR-051 lets `implemented` be satisfied by `[decision, files]` or
`[decision, note]` — the shape of a pure audit: read code, record findings,
change nothing. But `testsPassed` accepts only `test-run | tool | pr` and
`qaPassed` only `tool | pr`, so such a task could never complete. Every
remaining escape was unusable by construction: `tool:test` is meaningless for a
task that changed nothing, and `CLEO_OWNER_OVERRIDE` is session-capped and
rejected on critical gates anyway. A correctly-evidenced audit task simply
stayed pending.

A decision-only task has no tests to run and nothing to lint, so those gates
are now satisfied by absence — the same reasoning as the T12083
`notApplicable` tool atom, which records that a gate passed because the
toolchain does not exist rather than passing it silently.

The exemption is deliberately narrow and cannot be reached by choosing weaker
evidence: a `commit:` or `pr:` atom anywhere in the `implemented` evidence
means code DID change and the normal gates apply in full, `implemented` still
had to be satisfied first, and `decision:` is a hard atom validated against the
BRAIN decision-store. An override alone does not qualify.

**gh#1224.** `pr:` atoms are inert in a repo with no required workflows: the
checks they look for never ran, so every atom is refused — and that is exactly
the situation in which an agent reaches for `pr:`. With no project config CLEO
falls back to a built-in list of its OWN gate names (`CI`, `Lockfile Check`,
`Contracts Dep Lint`), which will not match another project. CLEO-INJECTION.md
now says so where the atom is introduced, names both overrides, explains that
an explicit empty `release.prRequiredWorkflows` array means "this repo requires
none", and points at the honest fallback for a CI-less repo.
