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

**1. `--all`** — a discoverable spelling of `--limit 0`. Core's `options.limit === 0 ? undefined : …` has always meant "no limit" and worked correctly, but it was documented **nowhere**: `--limit`'s help text said only "Maximum number of tasks to return". The one flag that made complete enumeration possible was invisible to anyone who had not read the core source. Both spellings are now named in the registry description.

**2. Truncation disclosure** on `--output id`, `--output table`, and `--summary`:

```
cleo: TRUNCATED — --output id returned 10 of 1075 matching rows. Re-run with
--all (or --limit 0) to enumerate every match, or pass --limit/--offset to
page deliberately.
```

The reporter noted that `--summary` was untested for the same skew. It has it — `--summary` is one line per *returned* record — so it is covered here too.

`--output count` is deliberately **exempt**: it already prints the full match count, so warning there would contradict its own output.

## Two deliberate non-changes

- **Written to stderr, never stdout.** `--output id` exists to be piped; a warning line inside the id stream would corrupt the very consumer it protects (ADR-086 — one clean payload per call on stdout).
- **Exit code stays 0.** Flipping it would break every `set -e` consumer to fix a silent-truncation bug — trading one silent failure for a loud unrelated one.

## Why the warning can never contradict `--output count`

`detectTruncation` prefers the envelope's own `page.hasMore`/`page.total`, then falls back to `data.filtered` — the exact field `extractCount` prints. It deliberately does **not** fall back to `data.total` when `filtered` is present: `total` is every task in the project, so using it would warn on every filtered query that excluded anything, crying wolf until the warning is ignored. A test pins that distinction.

## Why this mattered more than a short list

An agent enumerating tasks bottom-up to diff against a top-down walk received 16 of ~220 rows and reported **"2 orphans"** — a clean, plausible, actionable-looking finding that was entirely an artefact of the truncated enumeration. Both flagged ids turned out to be fine. Worse than the two false positives: the result implied the other 205 had been *verified*. Absent rows read as "these do not exist" rather than "these were not returned".
