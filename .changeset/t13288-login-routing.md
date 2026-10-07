---
id: t13288-login-routing
tasks: [T13288]
kind: fix
summary: cleo login alone signs an agent in to Cleo Nexus and links the project; it no longer falls into the LLM-provider error without a terminal
---

Two changes make `cleo login` the only setup step, including for agents.

**A bare `cleo login` without a terminal now runs the Cleo Nexus device sign-in.** Before,
it fell into the LLM-provider error "No --provider supplied". It keeps the LLM front door
in two cases:

- the command is `cleo llm login`;
- an LLM-only flag (`--api-key`, `--api-key-stdin`, `--model`, `--role`, `--auth`,
  `--label`) shows an LLM provider was meant.

**After a Cleo Nexus sign-in, a non-interactive run outside CI completes the guided first
run unattended.** Before, it only printed the next command. Now, inside a CLEO project
this machine hasn't linked, it links the project and takes the first encrypted backup.
Three cases are unchanged:

- it never restores over this copy without asking; when the cloud already holds a backup
  this copy never synced, it prints the restore command instead;
- a terminal is still asked;
- under CI it only prints the next command.
