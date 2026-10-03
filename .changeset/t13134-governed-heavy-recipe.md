---
id: t13134-governed-heavy-recipe
tasks: [T13134]
kind: docs
summary: Every agent surface (CLEO-INJECTION.md, ct-cleo, the spawn prompt) now gives one governed path for tests, typechecks and builds: cleo run --wait --class, never a wrapper around cleo run or cleo verify, never a heap or worker override, targeted evidence over whole suites
---

P0 snapshot 2 (2026-10-03) caught agents improvising: private wrapper queues, wrappers nested inside `cleo run` (a deadlock, T13133), explicit `NODE_OPTIONS=--max-old-space-size=8192` overrides, and whole-suite runs as evidence. CLEO's instructions gave no single recipe. Now CLEO-INJECTION.md (Rules), the ct-cleo and ct-orchestrator skills and every spawn prompt (Quality Gates, at every tier) all say the same thing:

- run tests, typechecks and builds one at a time through `cleo run --wait --class <test|build|full-build> -- <cmd>` (exit 75: not admitted yet, wait and retry);
- never wrap `cleo run` or `cleo verify` in another queue, and never put one inside them;
- never set `NODE_OPTIONS` heap or `--maxWorkers` overrides;
- prove with single files, `tool:test-affected` or `ci:<pr>`, never a whole suite.

The spawn prompt's own quality-gate commands now run through `cleo run`, and a test asserts the recipe on every surface. The injection stays under its 14,000-character cap, because two duplicated sentences were removed. ct-cleo, CLEO-INJECTION and CLEO-REFERENCE move to 2.24.5, and ct-orchestrator to 4.0.9.
