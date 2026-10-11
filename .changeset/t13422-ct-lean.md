---
id: t13422-ct-lean
tasks: [T13422]
kind: feat
summary: new core skill ct-lean (smallest complete change), adapted from Ponytail 5.1.0 (MIT), with protocol pointer and spawn-prompt block
---

`ct-lean` turns the core rules of Ponytail 5.1.0 (DietrichGebert, MIT; the
license ships beside the skill) into a CLEO core skill: take the first option
that fully works (skip it, reuse the repo's own helper or chokepoint, stdlib,
installed dependency, one line, minimum code), finish every caller and test
the change breaks, and leave one test for new logic. Its never-cut list adds
CLEO's own: evidence gates, type safety, the package boundary and the
`cleo check arch` gates, and store safety. Ponytail's levels, statusline and
plugin hooks are not carried over.

Every session gets a one-line pointer in CLEO-INJECTION.md's Rules, and every
spawn prompt (tiers 0-2) carries a `## Lean Change (ct-lean)` block from
`packages/core/src/orchestration/lean-change.ts`. ct-lean joins the core
profile (seven core skills). Protocol 2.24.9.
