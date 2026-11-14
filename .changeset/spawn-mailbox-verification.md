---
id: spawn-mailbox-verification
tasks: [T14559]
kind: fix
summary: "spawn mailbox verification: skip unused defaults during atomicity prechecks and report exact failed checks"
---

Atomicity prechecks no longer probe the configured default mailbox before the
explicit lead mailbox is applied. Dispatch still verifies the registered holder
and its exact provider session, including MCP-held project and epic mailboxes.
Refusals and fallback warnings now include the failed command, observed result
and registration or claim recovery instructions. Read-only live verification
covers a Claude MCP holder without changing its lease or sending mail as it.
