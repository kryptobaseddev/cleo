---
id: t10120-saga-core-module
tasks: [T10120]
kind: feat
summary: "extract saga ops to packages/core/src/sagas/"
---

refactor(T10120): extract saga ops to packages/core/src/sagas/

Move saga business logic out of CLI dispatch into packages/core/src/sagas/
(constants, storage, create/add/list/members/rollup). Dispatch becomes thin
3-5-line pass-throughs that wrap the core EngineResult in a LAFS envelope.
Fixes AGENTS.md Package-Boundary Check violation. Foundation for T10113 saga
first-class promotion / E-SAGAS-CORE-MODULE (T10208).

Adds new CI gate `Saga Symbol Leakage Lint (T10120)` to prevent regression.

Subtasks: T10123 (constants + resolver), T10124 (ops extraction),
T10125 (dispatch shrink).
Saga: T10113. Epic: T10208.
