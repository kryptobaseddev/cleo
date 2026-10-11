---
id: t13521-cache-only-gate-writes
tasks: [T13521]
kind: breaking
summary: "evidence writes, cleo done, cleo verify --auto and cleo complete no longer execute typed gates; they read passes cached by cleo verify --run, and --run-typed opts a write back into executing"
breaking: "Run typed gates with cleo verify <id> --run (or --run --req <REQ-IDs>) before recording evidence; a write that links a typed gate with no cached pass now refuses with E_GATE_NOT_CACHED. To keep executing typed gates during a write, cleo done or cleo verify --auto, add --run-typed. Projects with evidence.allowCachedGates false must pass --run-typed on writes for tasks with typed gates."
---

Owner decision. Typed acceptance gates now execute only through
`cleo verify <id> --run` (optionally `--req REQ-A,REQ-B`).

- **Cache-only by default:** an evidence write (`cleo verify <id> --gate …
  --evidence …`), `cleo done` and `cleo verify --auto` read the cached passes
  and execute no typed gate command. `cleo complete` already never executed
  one (T13515).
- **Missing pass:** a typed gate the write links (`satisfies:`) with no cached
  pass for the current HEAD, working tree and inputs refuses the write with
  `E_GATE_NOT_CACHED`. The message names
  `cleo verify <id> --run --req <REQ-ID>`. A gate the write does not link is
  recorded as not run, and `cleo complete` still requires it.
- **`--run-typed`** on a write, on `cleo done` or on `cleo verify --auto`
  restores the old behaviour of executing uncached typed gates there. It
  cannot be combined with `--no-run`, which now only states the default.
- **`evidence.allowCachedGates: false`:** writes on tasks with typed gates now
  need `--run-typed`, because nothing can be read from the cache.

The documentation is updated: CLEO-INJECTION, the CLEO-REFERENCE evidence
section, ct-cleo 2.24.11 and ct-task-executor 2.7.10.
