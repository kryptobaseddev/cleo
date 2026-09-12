---
id: t12123-list-truncation-disclosure
tasks: [T12123]
kind: fix
summary: cleo list discloses truncation on --output id/table/--summary and gains --all, so a page is no longer indistinguishable from the whole set
---

Closes GH #1242.

`cleo list --status pending --output count` reported **1075** while `--output id` returned **10** for the same query, seconds apart, with no `_truncated`, no `hasMore`, no `nextCursor`, and nothing on stderr. The short list was indistinguishable from a complete list of ten.

## What was actually broken — narrower than reported

**Neither number was wrong.** `--output count` prints `data.filtered`, the filter-aware match count, and that is deliberate: the `extractCount` TSDoc (T11481 · DHQ-034) explicitly documents it as "NOT the returned-rows length (which differs from the match count under pagination)". `TASK_LIST_DEFAULT_LIMIT` is 10. And the envelope **already carried the truth** — `page: {mode:"offset", limit:10, offset:0, hasMore:true, total:1075}`.

The defect was that the enumeration render modes **discarded that `page` metadata**, so the caller had no way to learn it had seen a page. The report's ask #1 ("make `--output id` return the same population as `--output count`") is therefore declined on purpose: silently switching a paginated read to unbounded would be a surprising behaviour change for every existing consumer. Disclosure plus a documented escape hatch gives the same guarantee without it.

## What changed

**1. `--all`** — a discoverable spelling of the escape hatch. Core's `options.limit === 0 ? undefined : …` has always meant "no limit" and worked correctly, but it was documented **nowhere**: `--limit`'s help text said only "Maximum number of tasks to return". The one flag that made complete enumeration possible was invisible to anyone who had not read the core source.

`--all` is the idiom this PR **teaches**; `--limit 0` is named only as a compatibility note, and deliberately not as the recommended path. See below.

**2. Truncation disclosure** on `--output id`, `--output table`, and `--summary`:

```
cleo: TRUNCATED — --output id returned 10 of 1075 matching rows. Re-run with
--all (or --limit 0) to enumerate every match, or pass --limit/--offset to
page deliberately.
```

The reporter noted that `--summary` was untested for the same skew. It has it — `--summary` is one line per *returned* record — so it is covered here too.

`--output count` is deliberately **exempt**: it already prints the full match count, so warning there would contradict its own output.

## Why `--all` is taught and `--limit 0` is only a footnote

An earlier draft of this changeset named both spellings as equals. That would have been a
mistake, because **`--limit 0` does not mean "no limit" everywhere in this CLI.** Measured
on the same build (GH #1302):

```
$ cleo find "worktree" --limit 0
{"success":true,"data":{"results":[],"total":260},
 "meta":{…,"message":"No matching tasks found"}}
```

Zero rows, reported as success, with a human-readable line asserting the opposite of the
`total` sitting beside it in the same object. `find` and `list` each hand-roll their own
limit handling (`find.ts:109`, `list.ts:75`), and the registry-driven forward introduced in
GH #1245 covers `list` only.

So documenting `--limit 0` as the recommended path would have converted an *undocumented*
inconsistency into a **taught** one — instructing every agent to use a flag that silently
returns nothing from a sibling command. `--all` is uniform, so it is the spelling in every
help string and registry description here. `find --all` (plus `find --limit 0` meaning
unlimited, and a fix for the self-refuting envelope) follows in its own PR.

## The remedy is named by the command that owns the flag

The warning is emitted from the **generic** `cliOutput`, which every command reaches — `cleo find` included. An earlier revision printed *"Re-run with `--all` (or `--limit 0`)"* unconditionally, which is advice that is wrong for most commands and **actively broken for `find`**: no `all` arg is declared there, and `--limit 0` is `slice(0, 0)` — zero rows.

Composed with the unknown-flag guard (#1276) it degrades further. `assertKnownFlags` runs at the `lazyCommand` chokepoint every manifest command passes through, and `--all` is not a global flag — so the printed remedy becomes a hard `E_UNKNOWN_FLAG` exit 6. **The CLI would refuse the invocation it had just told the caller to run.** Neither PR is wrong alone; the defect exists only in the composition.

There is also a second turn: `cleo find "x" --limit 0 --output id` takes the zero-results branch, which calls `cliOutput` again — so the same bad advice is reprinted immediately after following it produced zero rows.

Fixed by moving the remedy to the command that owns the flag. `CliOutputOptions` gains an optional `enumerateAllFlag`; `list` passes `'--all'`; every other command passes nothing and gets `--limit <n>` / `--offset <n>` advice, which is true everywhere.

Deliberately **not** an allow-list of commands inside the renderer. That would put the same fact in two places and let a command that gains or loses the flag drift out of step with the message. Keeping the spelling with its owner means there is no second list to update.

Two tests pin it, and both fail against the previous revision: a command that declares no flag must never see `--all`, and `--limit 0` must never be suggested at all. The earlier test asserting `--all` unconditionally was **pinning the defect**, and was rewritten rather than kept.

## Two deliberate non-changes

- **Written to stderr, never stdout.** `--output id` exists to be piped; a warning line inside the id stream would corrupt the very consumer it protects (ADR-086 — one clean payload per call on stdout).
- **Exit code stays 0.** Flipping it would break every `set -e` consumer to fix a silent-truncation bug — trading one silent failure for a loud unrelated one.

## Why the warning can never contradict `--output count`

`detectTruncation` prefers the envelope's own `page.hasMore`/`page.total`, then falls back to `data.filtered` — the exact field `extractCount` prints. It deliberately does **not** fall back to `data.total` when `filtered` is present: `total` is every task in the project, so using it would warn on every filtered query that excluded anything, crying wolf until the warning is ignored. A test pins that distinction.

## Why this mattered more than a short list

An agent enumerating tasks bottom-up to diff against a top-down walk received 16 of ~220 rows and reported **"2 orphans"** — a clean, plausible, actionable-looking finding that was entirely an artefact of the truncated enumeration. Both flagged ids turned out to be fine. Worse than the two false positives: the result implied the other 205 had been *verified*. Absent rows read as "these do not exist" rather than "these were not returned".
