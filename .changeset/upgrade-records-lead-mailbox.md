---
id: upgrade-records-lead-mailbox
tasks: [T14448]
kind: fix
summary: "an initialized project records its lead mailbox with cleo upgrade, with failures surfaced: cleo init refuses there, and only init called ensureLeadMailbox"
---

Turning `orchestrate.leadWorker.v1` on in an already-initialized project left
the lead mailbox unrecorded: `cleo init` refuses with "Project already
initialized" (and `--force` resets the very config that holds the flag), and
`init.ts` held the only `ensureLeadMailbox` call.

`cleo upgrade` now runs the same idempotent, non-destructive
`ensureLeadMailbox` pass in its structural-maintenance step: with the flag on
and no record it records `orchestrate.leadMailbox.{name,projectId,cli}`, it
keeps an existing record without re-probing agentmbx, without agentmbx it
surfaces a `skipped` action instead of writing anything, and a failure
(readonly config, missing project info) surfaces as an `error` action instead
of being swallowed as success.

The lead-mailbox warnings name `cleo upgrade` as the fix — including the
`cleo orchestrate lead` claim warning — instead of the unreachable
"run `cleo init`". `cleo orchestrate lead`'s claim behaviour itself is
unchanged from main; registering the recorded identity and refusing on a
failed claim moved to T14477, where the design is recorded.
