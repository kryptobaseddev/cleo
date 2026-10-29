---
id: embedded-summary-not-counted
tasks: [T14132]
kind: fix
summary: "a typed gate's minCount no longer counts a counter summary found inside its output; only the whole stdout or the gate's report file may be one"
---

The shared test-report reader (T14124) made a typed gate's in-output JSON
search accept any counter summary. A test that printed `{"total":5,"passed":5}`
could therefore satisfy `minCount`. A bare summary (runner summary or node
--test counters with no per-test results) now counts only when it is the whole
stdout or the gate's own report file. When one is found inside other output,
the refusal says it was not counted. A full vitest/jest report embedded in
progress output still counts as before.
