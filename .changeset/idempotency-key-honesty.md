---
id: idempotency-key-honesty
tasks: [T12162]
kind: fix
summary: --idempotency-key is refused where it cannot be honoured, instead of being silently ignored (gh#1229, gh#1244)
---

`cleo add --idempotency-key k` parsed cleanly, reported success, recorded the
key in `audit_log.idempotency_key` — and did not apply it. A retry with the
same key created a duplicate, exactly as a retry without one would.

Three layers combined to make the flag look honoured on the verbs where it is
not:

- `extractIdempotencyKeyArg` (`cli/index.ts`) removes `--idempotency-key` from
  argv **before citty validates the leaf command**, so unknown-flag rejection
  (gh#1276) structurally cannot catch it.
- `mergeIdempotencyParam` (`dispatch/adapters/cli.ts`) then injects the key into
  params for **every** mutate dispatch.
- `createIdempotency` bailed with a bare `return next()` whenever the resolved
  operation was not `idempotent: true` — which is the case for `tasks.add`,
  `tasks.add-batch`, `tasks.update`, `docs.add`, `memory.observe` and
  `relates.add`.

The audit middleware still wrote the key against the row, so even the audit
trail asserted the request had been keyed.

This matters because of who reaches for the flag. A caller uses
`--idempotency-key` when a mutation was killed and they cannot tell whether it
committed (gh#1229) — and a blind retry is how duplicate tasks get created
(gh#1244, where a consecutive-ID pair *proves* the first write committed, since
the second ID could not follow an ID the first write never consumed). A flag
that looks like the remedy and is inert is worse than no flag at all: it turns
a retry the caller knew was unsafe into one they believe is safe.

The middleware now returns `E_IDEMPOTENCY_UNSUPPORTED` naming the operation,
stating plainly that the key was NOT applied, and pointing at the read commands
that establish the truth. It cannot produce a false positive: the key reaches
params only when the caller passed the flag explicitly, so an ordinary
`cleo add` is untouched, and a blank key is ignored rather than refused.

`CLEO-INJECTION.md` gains the matching row plus a short section on killed
writes — that a 143/137 exit carries **no** information about whether the
mutation committed, that the commit is fast while the teardown is what hangs,
and that the two obvious ways to check are both booby-trapped by silent
defaults (`cleo find` excludes archived rows, `cleo list` truncates at 10).
Both need an explicit flag, or the check that was supposed to prevent the
duplicate reports the row as absent and causes one.

This does NOT make those verbs idempotent. Flipping them to `idempotent: true`
requires a pre-write intent record: the replay ledger is written by the audit
middleware AFTER the handler commits, so a kill inside the commit→ledger window
still re-executes on retry. That, and the unused `tasks_tasks.idempotency_key`
column whose UNIQUE constraint currently guards nothing (SQLite ignores NULLs,
and no production code populates it), are tracked on gh#1229.
