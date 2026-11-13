---
id: lead-mailbox-live-holder
tasks: [T14477]
kind: fix
summary: "Lead mailboxes: register through the running provider and verify holders before dispatch"
---

No-hands leads claim or register their epic mailbox through their own AgentMBX
tools after launch, with role `lead`. The guarded runner refuses worker dispatch
until AgentMBX confirms that exact provider session holds the mailbox, and worker
prompts omit unheld defaults or refuse an unheld explicit destination. Each epic
uses its own coordinator mailbox; AgentMBX's owner-designated project lead stays
separate. Fresh projects record the default mailbox when starting a lead, without
requiring another upgrade.
