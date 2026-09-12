---
id: t12121-show-withheld-marker
tasks: [T12121]
kind: fix
summary: cleo show no longer hides a populated description behind an absent key — the MVI projection names every field it withholds, with its size
---

Closes GH #1243 (read-path half; the write-path clobber guard is tracked separately).

`cleo show <id>` without `--full` did not return a truncated or empty `description`. **The key was ABSENT from `data.task` entirely** — and so was `verification`. An absent key and an empty value are indistinguishable to every consumer, so the idiomatic, careful read reported a populated field as empty:

```python
desc = task.get('description') or ''    # '' for a 1440-character description
```

**This turned a read defect into a data-loss defect.** On 2026-09-12, one agent filed T289 with a full mechanism description; a second agent ran `cleo show T289` *without* `--full` to check whether the finding had been filed, parsed `task.description`, got nothing, correctly-by-its-own-logic concluded the task was a title-only stub, and **overwrote the description**. It also broke CLEO's own documented recovery for a killed write — "query before retrying" — because querying without `--full` reports the record as empty, so the recommended recovery step is exactly what authorises the clobber.

## Root cause

`pickFields` in `core/src/dispatch/mvi-projection.ts` kept the kind's allow-list and discarded every other key **with no record of having done so**. `description` and `verification` are not on the `task` allow-list, and `PROJECTION_PLANS['tasks.show']` routes `data.task` through it.

A second instance of the same class lived in the same file: `reduceToBudget` drops trailing keys to fit a token budget, and in the last-resort case strips everything but `id` — also silently.

## The invariant restored

**A field that exists on the record is present in the envelope, or is explicitly named as withheld.**

A new `_withheld` key (exported as `WITHHELD_KEY`) maps each withheld field to its content size:

```json
{ "id": "T289", "_withheld": { "description": 1440, "verification": 19 }, "title": "…" }
```

Three deliberate design choices:

- **Sizes, not values.** A withheld field's value is not reproduced, truncated or otherwise. A truncated copy under the real field name would be *worse* than absence: a consumer that read it and wrote it back would silently **corrupt** the record, where absence only risks an overwrite with fresh text. A size is inert.
- **Only fields that had content are listed.** A null/empty/absent field's absence tells no lie, and listing it would bury the fields that do. The consequence is the signal the incident needed: **a record with no `_withheld` key is complete**, so "genuine stub" and "1440 characters hidden" are finally distinguishable — the exact judgement the second agent got wrong.
- **Budget-dropped fields are marked too.** `_withheld` means withheld for *any* reason, not just allow-listing.

## The marker lives inside the token budget

Attaching the marker after budget reduction overshot a 61-token budget by 123 tokens, breaking the budget's documented "hard" guarantee — so that first approach was discarded rather than having its tests relaxed. `projectWithinBudget` now recomputes the marker against the surviving key set each round and sacrifices one more content field when the marked record does not fit. The marker is inserted immediately after `id` so the drop-from-the-end order sacrifices content before the statement of what is missing: a record that admits it is partial is more useful than one extra field with no warning.

At budgets too small to carry any marker the record degrades to `{ id }`. That boundary is acceptable precisely because `{ id }` is self-evidently not a full record — it cannot be mistaken for a complete one, which is the failure mode the marker exists to prevent.

## The injection template was asserting the false claim

`packages/core/templates/CLEO-INJECTION.md` — injected verbatim into every spawned agent — described bare `cleo show {id}` as "**full** task record details" and "Raw task record". That is the documentation that leads an agent into this incident, phrased as instruction. All three references now say `--full`, state that bare `cleo show` withholds `description` and `verification`, and carry the rule: **never read a field's absence as "empty" — check `_withheld` first.**

## Not in this change

The reporter's option 2 — make `cleo update --description` refuse to clobber a non-empty description without `--force`/`--reason` — is a write-path guard sharing machinery with `core/src/tasks/ac-immutability.ts` and is tracked separately. It remains worth having: it is the only remedy that protects a consumer which never reads the field at all.
