---
id: t12168-find-all-and-limit-semantics
tasks: [T12168]
kind: fix
summary: cleo find gains --all, --limit 0 means unlimited as it does on list, and the zero-results message stops contradicting its own total
---

Closes the `find` half of GH #1302.

## `--limit 0` meant opposite things on two sibling commands

```ts
// packages/core/src/tasks/find.ts — before
const limit = options.limit ?? 20;
results = results.slice(offset, offset + limit);   // limit 0 → slice(o, o) → ZERO rows
```

On `cleo list`, `--limit 0` has always meant **no limit**. On `cleo find` the same flag, spelled the same way, returned **nothing** — and did so as a success:

```json
{"success":true,"data":{"results":[],"total":260},
 "meta":{…,"message":"No matching tasks found"}}
```

Zero rows, reported as success, with a human-readable line asserting the opposite of the `total` sitting beside it in the same object. **The envelope carried its own refutation, and the sentence a reader actually reads was the wrong half.**

`limit === 0` now means no limit, matching `listTasks`.

## `find` had no way to enumerate at all

No `all` arg was declared, so a caller who wanted every match had two options: guess a large `--limit`, or use `--limit 0` and get nothing. `--all` is added with the same semantics as `cleo list --all`.

This was not only ergonomic. The truncation disclosure added for GH #1242 is emitted from the **generic** `cliOutput`, so it reached `find` too and named `--all` and `--limit 0` as the remedies — on the one command where neither worked. Composed with the unknown-flag guard, the suggested `--all` would have become a hard `E_UNKNOWN_FLAG` exit: the CLI refusing the invocation it had just printed. That half is fixed in #1260 by making the remedy command-owned; this PR makes the remedy *true* for `find` as well.

## The message no longer contradicts the total

The zero-results branch always said `No matching tasks found`. That is false whenever matches exist but the requested page is empty — an offset past the end, or the old `--limit 0`. It now distinguishes the two:

```
matched > 0  →  "No results on this page — 260 task(s) matched. Re-run with --all
                 to enumerate every match, or adjust --limit/--offset."
matched = 0  →  "No matching tasks found"
```

## Tests

Five in `find-limit-semantics.test.ts`. Three fail against `main`:

```
AssertionError: expected [] to have a length of 45 but got +0     (limit 0 returned zero rows)
AssertionError: expected [] to have a length of 35 but got +0     (limit 0 with offset)
AssertionError: expected true to be false                          (empty page beside a non-zero total)
```

The last one is deliberately shaped as an invariant rather than a value: *results may not be empty while total is non-zero*, which is the property that made the original defect invisible rather than the specific number that exposed it.

## Ordering note

`find` now genuinely declares `--all`, so once **both** this and #1260 have landed it should pass `enumerateAllFlag: '--all'` to `cliOutput` — a one-line change that cannot be made here, because that option only exists on #1260's branch. Deliberately left out so this PR merges in either order; flagged rather than assumed.
