---
id: t13510-validate-before-provision
tasks: [T13510]
kind: fix
summary: "orchestrate spawn refuses an atomicity violation before allocating a session, claiming the task or provisioning a worktree"
---
A worker task with no file scope used to get a per-agent session, a claim, an XDG worktree with its lock, and a `pnpm install` before the spawn refused it with `E_ATOMICITY_NO_SCOPE`. The locked worktree was left behind.

The prompt spawn path now composes once without a session or worktree (no memory retrieval), straight after readiness validation. It refuses an atomicity violation there, before anything is allocated or provisioned, and a refused spawn leaves nothing behind. The real prompt is still composed after provisioning, and its atomicity check stays as a guard against a task edited in between.
