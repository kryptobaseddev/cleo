---
id: duplicate-test-filename-gate
tasks: [T12154]
kind: fix
summary: Gate against new duplicate test filenames — a basename shared by several files is not an identifier
---

**gh#1286.** 71 test filenames are shared by two or more files out of ~1600, and
`registry.test.ts` exists eleven times. A basename *looks* like an identifier,
so any discussion that names "the prune test" begins from an unstated
assumption about which file is meant — and nothing in the exchange reveals the
mismatch.

Measured 2026-09-12: two agents debugged a failing `worktree-prune.test.ts` for
an extended exchange while reasoning about **different files**
(`packages/core/src/__tests__/`, `packages/worktree/src/__tests__/` and
`packages/core/src/spawn/__tests__/` all carry that name). One produced a
correct module-graph analysis proving the failure was impossible — of the file
that was never failing. The other read the test-count mismatch (3 vs 5) as
evidence about how the tests were *run* rather than about which file was meant.
The mismatch was visible in both messages and neither noticed. A developer
holds the path open in an editor; agents exchange names in prose, which is why
this bites hardest in exactly the workflow this repo provisions.

`scripts/lint-duplicate-test-filenames.mjs` groups every git-tracked
`*.test.ts`/`*.test.tsx` by basename and compares against
`scripts/.lint-duplicate-test-filenames-baseline.json`. Baselined and
forward-only: a per-name count may only go DOWN. A newly duplicated name fails,
and an existing duplicate gaining another file fails. Renaming the 71 today is
not required — stopping the 72nd is. `--update-baseline` regenerates after a
deliberate improvement; `--strict` is zero-tolerance for when the backlog is
gone.

A gate rather than a fix, deliberately: today's argument is that gates outlive
reflexes. The rename backlog is a judgement call with 71 instances and no
deadline; the 72nd instance is mechanical and can be stopped today.

The workflow is checkout + node with no `pnpm install` — the script uses only
`git ls-files` and node builtins — so it adds no meaningful load while runner
capacity is the constraint.
