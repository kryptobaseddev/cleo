---
id: generated-artifact-drift
tasks: [T12150]
kind: fix
summary: assert committed generated artifacts match their source, and regenerate the manifest that had already drifted (gh#1281)
---

`packages/cleo/src/cli/generated/command-manifest.ts` is generated **and
committed**. When two PRs each add a command and each regenerate it, git merges
the generated file *textually* — entries are lost with no conflict, in a defect
that exists in neither PR.

It was unobservable by construction: both `prebuild` and `pretypecheck`
regenerate the manifest, so every build and every typecheck — local or CI —
silently regenerated before doing anything. No command in normal use ever read
the committed file.

**`main` had already drifted.** Two documented commands were registered in
`doctor.ts` and absent from the committed index: `doctor memory-guard` (T12097)
and `doctor superseded-store` (T12095). Both are documented in AGENTS.md. This
regenerates it.

The new check regenerates each registered artifact and fails when the committed
copy differs, naming the exact command to run. It normalises formatting first —
the generator emits unwrapped lines while the committed file is biome-formatted,
so a naive diff reports ~126 lines of noise per run, and a gate that cries wolf
is one somebody disables.

It runs as its own workflow with `--ignore-scripts`, deliberately not dependent
on any step invoking `prebuild`/`pretypecheck`, since that regeneration would
mask the very drift being checked.

Four other generated-and-committed artifacts share this exposure and none had
any drift assertion (there is no `git diff --exit-code` anywhere in CI). The
registry in the script makes coverage explicit so they can be added as their
generators become runnable.
