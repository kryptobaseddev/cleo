---
id: guarded-orca-lead-terminal
tasks: [T14500]
kind: feat
summary: "Launch guarded Claude Code leads in verified local Orca terminals."
---

Launch Claude Code leads in local Orca terminals with the native tool, permission, strict MCP and session guards. Verify the owner terminal and record the process before releasing the first-turn gate; keep refusing unsupported harnesses and hosts.

Orca refusals preserve their error code, repair instruction and nonzero CLI exit. Admission waits for the gated owner terminal, and refused terminals are closed before returning.
