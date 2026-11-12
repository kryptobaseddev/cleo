---
id: lead-folder-trust-preflight
tasks: [T14511]
kind: fix
summary: "Claude Code leads refuse before launch when saved folder trust cannot be verified"
---

Before opening an Orca terminal or starting a native lead, CLEO checks the
owner's saved Claude Code trust decision using the lead's HOME and
CLAUDE_CONFIG_DIR. Missing, unreadable or invalid trust state returns
E_LEAD_PROJECT_UNTRUSTED with instructions to run claude in the project,
accept the folder-trust dialog once, exit, and retry the lead command.
The check never writes trust or changes the lead's tool and permission guards.
