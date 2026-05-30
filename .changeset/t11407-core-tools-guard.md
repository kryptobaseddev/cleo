---
id: t11407-core-tools-guard
tasks: [T11407, T11390]
kind: feat
summary: Add single deny-first tool guardrail chokepoint core/src/tools/guard.ts (path allowlist + command denylist, warn-then-enforce)
---

E3 T11407. createToolGuard(policy) wraps every atomic primitive (fs+shell) at ONE chokepoint: fs path allowlist (deny-first when allowedRoots set) + shell command denylist (basename match). Ships warn-then-enforce (default warn logs via pino getLogger + proceeds so no callsite breaks; enforce throws GuardDeniedError before the side effect). 9 unit tests. Boundary lint T11409 later makes the guarded surface the only public one.
