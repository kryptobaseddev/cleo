---
id: t12516-typed-gate-tool-deadline
tasks: [T12516]
kind: fix
summary: typed acceptance gates run under the ADR-061 tool deadline, not the 2 s shared operation budget
---

`cleo verify` on a task with a typed gate (`cleo req add <id> --gate '{"kind":"test",...}'`)
created its operation lifetime at admission with a fixed two-second deadline.
Evidence tools (`tool:test`) and the typed gates ran inside that lifetime, so any
suite longer than two seconds failed with `E_OPERATION_DEADLINE` ("Shared
operation deadline reached"), even when the suite itself passed.

The owned lifetime is now admitted just before the typed gates run. Its budget
is each gate's tool deadline (the gate's `timeoutMs`, else `CLEO_GATE_TIMEOUT_MS`,
else `CLEO_TOOL_TIMEOUT_<KIND>`, else 1,800,000 ms for `test` and 300,000 ms for
other kinds) plus two seconds for the bookkeeping. `cleo verify --run` uses the
same admission. A lifetime that the caller already owns is still respected.
