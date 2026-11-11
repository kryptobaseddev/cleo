---
id: t14455-orca-lead-guard-refusal
tasks: [T14455]
kind: fix
summary: Refuse Orca lead launches without enforceable tool, MCP and owner-channel guards
---

Orca launch APIs cannot carry the native restricted tool and permission argv, strict user-only MCP allowlist, or verified owner channel and provider-session settings. Refuse before admission while keeping leadWorker.v1 enabled; guarded native leads outside Orca are unchanged.
