---
id: t13229-write-actor
tasks: [T13229]
kind: fix
summary: Local write frames record the dispatching command as actor.op, so a reopen or restore applies on every replica instead of being voided
---

Local write frames used to carry no actor, so sealed transactions said `actor: null`. The typed merge rules decide on `actor.op`. A
local `tasks.restore` (reopen, uncancel, unarchive) therefore reached every other replica as a plain write. There it was voided as a
typed-rule conflict, and the reopen diverged.

- **`runWithWriteActor` / `currentWriteActorJson`** (`store/sync/write-actor.ts`): an async-local actor scope.
- **The data accessor** opens each write frame with the current actor.
- **A new dispatch middleware, `createWriteActor`,** runs every mutate operation with `{ op: '<domain>.<operation>', session }`. It sits
  right after the session resolver.
- **Core's leave entry points** (`taskRestore`, `taskReopen`, `taskUnarchive`) name their own command with `runWithWriteActorOp`. That
  keeps the enclosing session. A reopen through the SDK, Studio or a daemon host then carries `tasks.reopen` exactly like one from the CLI.
- **`TASK_STATUS_LEAVE_OPS`** drops the never-emitted `tasks.uncancel`. A test checks that every leave and restore op in the merge rules
  is emitted by core.
- **An end-to-end test** drives the real accessor:
  - a done task is reopened under `tasks.restore`;
  - the sealed transaction names the command, and the sealer records the leave;
  - a second store applies both sealed transactions, and the reopen is applied, with no conflict.
- **A second end-to-end test** reopens through core's `taskReopen` with no dispatcher; the sealed transaction carries `tasks.reopen`.
