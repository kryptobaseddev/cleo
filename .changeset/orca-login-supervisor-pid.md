---
id: orca-login-supervisor-pid
tasks: [T14510]
kind: fix
summary: "Prove guarded Orca lead supervisors beneath macOS login processes and retain PID refusal details."
---

Accept a guarded shell only when an OS probe proves it is Orca's reported process or its direct child. Record the verified owner terminal and actual shell PID before releasing the first turn, and preserve terminal/PID diagnostics through the CLI refusal envelope.

Preserve coded refusals structurally across separately bundled adapter entries. Resolve ps from absolute PATH entries with a system fallback, and require a stable-locale OS snapshot proving the reported terminal process started no later than its guarded shell.
