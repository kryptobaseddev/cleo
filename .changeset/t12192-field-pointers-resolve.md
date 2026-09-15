---
id: t12192-field-pointers-resolve
tasks: [T12192]
kind: fix
summary: Documented --field pointers resolve — complete's double-wrap, check.gate.* contracts, and a gate on the pointer half (gh#1411, gh#1420, gh#1421, gh#1423)
---

`cleo complete --field` failed on every pointer, including the three its own
error message recommended, so an agent following the `fix` field re-ran the
failing command verbatim. The mutate-projection middleware had already reduced
the payload to the flat envelope; `complete.ts` then read `data?.task ?? data`
under a comment describing the pre-T9931 world, found no `task` key, and
re-wrapped the whole envelope under `task`. `cleo update` was unaffected because
it passes `response.data` straight through — `complete` was the only command in
the CLI that rewrapped.

`check.gate.set` and `check.gate.status` — the operations behind `cleo verify` —
had no explicit output contract, so they fell through to the generic one with an
empty pointer list. That is why `cleo verify --describe` returned an empty
contract and why `E_FIELD_NOT_FOUND` listed no valid pointers while
CLEO-INJECTION.md promises it "lists every valid pointer for that op".

With nothing to check the documentation against, CLEO-INJECTION.md had drifted
into teaching `--field /data/task/verification` — the nested READ spelling — for
a verb that returns the FLAT mutate record. Gate 14 was green throughout,
because the verb exists.

New gate 23 closes the structural half: every `--field` pointer in
CLEO-INJECTION.md must resolve against its operation's declared `fieldPointers`.
Verbs whose operation has no explicit contract are skipped and COUNTED in the
output rather than failed, so the remaining gap is visible instead of silent.
