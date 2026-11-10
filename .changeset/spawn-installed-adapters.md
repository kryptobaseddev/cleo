---
id: spawn-installed-adapters
tasks: [T14449]
kind: fix
summary: "Spawn discovery: resolve installed adapters independently of project layout"
---

Resolve bundled adapter manifests and JavaScript entry points from the installed
`@cleocode/adapters` package, including projects without a `packages/` directory.
Spawn selection refusals now explain `--adapter` choices, missing capabilities,
load failures and environment availability. The packed-install smoke probes
Claude Code selection through the installed CLI dependency graph.
