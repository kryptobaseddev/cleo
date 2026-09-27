---
id: t12455-startup-barrel-entrypoint-gate
tasks: [T12455]
kind: chore
summary: Wire the orphaned CLI entrypoint barrel gate into `cleo check arch`, CI and the AGENTS.md gate table (arch gate 25)
---

`scripts/lint-cli-startup-barrel.mjs` (T12138 · gh#1207) shipped as a gate
nothing ran: it was absent from the `cleo check arch` bundle, from CI and from
the AGENTS.md gate table. It is renamed `lint-cli-startup-barrel-entrypoint.mjs`
so its name distinguishes it from gate 19 (`lint-cli-startup-barrel-imports.mjs`),
and registered as arch gate 25 in all three places.

The two gates are complementary: gate 19 ratchets the repo-wide count of static
core-barrel imports in the CLI, while gate 25 permits ZERO across the modules
reachable from `cli/index.ts`'s static import graph, which every invocation pays
for, `cleo --version` included.
