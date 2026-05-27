---
id: t10448-spawn-changeset-lint-gate
tasks: [T10448]
kind: feat
summary: "spawn: wire lint-changesets gate into spawn prompt"
---

feat(spawn): wire lint-changesets gate into spawn prompt (T10448)

Adds a pre-spawn hygiene gate (`## Changeset Lint Gate`) to the canonical
spawn prompt builder. The gate instructs every spawned subagent to run
`scripts/lint-changesets.mjs` BEFORE starting implementation work.

- Fails fast on malformed changesets (silent aggregator failures downstream)
- References the absolute script path under `projectRoot`
- Lists canonical kinds: feat|fix|perf|refactor|docs|test|chore|breaking
- Positioned between Evidence Gate and Quality Gates in prompt ordering

Closes T10448
Saga: T10431
