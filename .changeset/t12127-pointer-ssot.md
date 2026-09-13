---
id: t12127-pointer-ssot
tasks: [T12127]
kind: fix
summary: documented --field pointers are now gated — gate 14 asserts every pointer in CLEO-INJECTION.md resolves, the read-vs-mutation nesting asymmetry is stated, and the tasks.show contract stops advertising a path that does not exist
---

Closes GH #1225, #1239, #1231.

Three agents independently ran `cleo show <id> --field /data/status`, got `E_FIELD_NOT_FOUND`, and each filed an issue. **All three said the error message was excellent** — it lists every valid pointer, explains the nesting, and offers concrete alternatives. The documentation was the defect.

## One defect wearing three hats

`CLEO-INJECTION.md`'s CLI Output Contract table had exactly **one** `--field` example — `id=$(cleo add 'X' --field /data/created/0)` — a **mutation** envelope, which is flat. Read envelopes nest the record, so `cleo show` needs `/data/task/status`. With no read example to generalise from, `/data/<field>` is the natural guess and it is wrong. As #1225 put it: *"Every agent following the injection will make this mistake once."*

## What changed

**1. The template now documents both shapes.** A read example sits beside the mutation one, plus an explicit paragraph naming the asymmetry as "the single most-guessed-wrong pointer shape": mutation envelopes are flat, read envelopes nest. It also records that `--field` resolves `description`/`acceptance`/`verification` transparently (T12108) with no `--full` needed — which #1231's reporter did not know and which removes the reason they were reaching for `--field /data/task` in the first place.

**2. Gate 14 now gates POINTERS, not just commands.** `scripts/lint-injection-commands.mjs` already asserted that every `cleo <verb>` named in the template exists, and T12077 extended it to "exists **and** is runnable". This is the same rule one level down: every documented `--field` pointer must resolve against that operation's `fieldPointers` contract. Verb → operation is resolved from the command module source (three declaration styles are in use, so all three are matched); contracts are read from **source, never `dist/`**, so the gate still needs no build.

Verified by injecting the exact pointer the three agents guessed — `--field /data/status` — and confirming the gate fails naming every valid pointer for `tasks.show`.

**3. The `tasks.show` contract was itself wrong, and the gate found it.** Adding the read example immediately failed the new check on `/data/task/description` — a pointer that demonstrably **works**. `fieldPointers` listed only the MVI-projection fields, so the remediation shown to a failing agent never mentioned the fields they most often wanted. Measured live and added: `/data/task/description`, `/data/task/acceptance`, `/data/task/verification`, `/data/task/verification/gates`, `/data/task/verification/evidence`.

**4. The contract advertised a pointer that does not exist.** Its `shapeNote` claimed `evidence` resolves transparently. It does not: `--field /data/task/evidence` is `E_FIELD_NOT_FOUND`, because evidence is not a task field — it lives at `/data/task/verification/evidence`, keyed by gate. That `shapeNote` is the text the CLI shows an agent **whose pointer has just failed**, so it was teaching a wrong remedy at the exact moment of failure. Corrected, and a test pins that `/data/task/evidence` is never re-added.

**5. `cleo verify` is self-confirming** (#1231 ask 2). The gate-ritual section now says so: `verify` returns the complete `verification` object, so truncating it to grep for `"success":true` discards the only reliable confirmation available. If a read-back is genuinely needed the pointer is `/data/task/verification`, **not** `--field /data/task` — which returns the MVI projection and made six genuinely-verified tasks look like writes that had silently done nothing.

#1231's remaining half — that a whole-object projection silently omits fields — is fixed by the `_withheld` marker in the T12121 change this PR stacks on.

## Guarding the guard

A pointer parser whose regex silently stopped matching would make the gate pass **vacuously**. So the tests pin a minimum pointer count, assert a read pointer is present, and assert pointers are never attributed across line boundaries.
