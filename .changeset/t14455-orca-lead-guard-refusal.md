---
id: t14455-orca-lead-guard-refusal
tasks: [T14455]
kind: fix
summary: Keep guarded lead launches native inside Orca and refuse unsupported Orca backend requests
---

A lead always uses its enforced native launch, including inside Orca terminals, without querying Orca accounts. Explicit Orca lead preflight/start refuses before inventory or process calls because its APIs cannot carry restricted tool and permission argv, strict user-only MCP configuration or verified owner/session settings. Keep leadWorker.v1 enabled.
