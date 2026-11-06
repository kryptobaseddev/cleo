---
id: spawn-prompt-project-context
tasks: [T14303]
kind: fix
summary: "the spawn prompt names the project's own commands from project-context.json and teaches ADR-099 closure"
---

Every spawned agent was told to run cleocode's own commands (`pnpm biome ci`,
`pnpm run build`, `node scripts/lint-changesets.mjs`) and the pre-ADR-099
verify-then-complete ritual, whatever project it worked in.

The Quality Gates block now renders from `.cleo/project-context.json`: the
project's `build.command` through `cleo run`, its lint and typecheck through
`tool:lint;tool:typecheck`, and its `testing.command` (or, without one, a
pointer to `cleo done <id> --plan`). The closure block leads with PR work
(`Closes: <id> AC…` / `Refs:`, a non-author verdict per criterion, the merge
sweep closes it) and keeps `cleo done <id> --plan` for no-PR work. The stage
guidance and the tier-0 protocol pointer no longer name cleocode paths,
packages or URLs.
