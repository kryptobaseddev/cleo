---
id: qa-run-checkable-coverage
tasks: [T13698]
kind: fix
summary: "a qa-run lint or typecheck receipt only owes coverage for the files its tool reads"
---

A truthful ESLint `qa-run` receipt over a change's TypeScript entry files was
refused because the change also held a generated `scripts/INDEX.md`: every
changed code path had to lie under a lint root, although ESLint never reads
Markdown (axiom T1984). `scripts/` is a CI code root, so the file was not set
aside as documentation either.

A receipt of a kind now owes coverage only for the changed paths its tool
reads: lint for JS/TS-family sources (plus `.svelte` and `.vue`), typecheck
for TS sources (plus `.svelte` and `.vue`). A lintable file the run missed is
refused as before. A changed path neither check reads is never dropped: it
must lie under some qa-run receipt's roots (of either kind), or a
whole-project `tool:lint` / `tool:typecheck` must be in the gate; otherwise
the refusal names it as needing its own evidence.
