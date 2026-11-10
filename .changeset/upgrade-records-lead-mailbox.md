---
id: upgrade-records-lead-mailbox
tasks: [T14448]
kind: fix
summary: "an initialized project records its lead mailbox with cleo upgrade, and cleo orchestrate lead records or refuses: cleo init refuses there, and only init called ensureLeadMailbox"
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

`cleo orchestrate lead` now records the mailbox itself before any spawn when
the flag is on and none is recorded, claims it before the spawn is dispatched
in both modes, and refuses with `E_LEAD_MAILBOX_MISSING` naming the exact fix
(`cleo upgrade`, the config set, the hand record, or the holder release/wait)
when agentmbx cannot back one, the claim is held elsewhere, or the spawn
throws before its own guard (the pre-taken claim is released) — a lead
workers cannot report to never starts. A recorded name agentmbx has never
heard of (T14477: the recording only wrote config) is registered first with a
lease-free self-addressed `agentmbx send --new-mailbox` and the claim is
retried once before any refusal; agentmbx 0.5.58 has no lease-free
`identity register`, so the role stays unset until a session claims it.

The lead-mailbox warnings now name `cleo upgrade` as the fix — including the
`cleo orchestrate lead` claim refusal — instead of the unreachable
"run `cleo init`".
