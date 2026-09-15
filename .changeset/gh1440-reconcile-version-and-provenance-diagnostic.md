---
id: gh1440-reconcile-version-and-provenance-diagnostic
tasks: [T12195]
kind: fix
summary: "release reconcile normalises its version like plan does, and a provenance failure now carries the driver's reason instead of an empty fix (gh#1440)"
---

Two defects on the reconcile path, found cutting v2026.9.4. Neither blocks a
release — which is why they went unnoticed. Together they meant provenance was
never backfilled, silently: the release published, installed and verified
working, and nothing reported the gap.

## 1. The writer and the reader disagreed about the `v`

`cleo release plan 2026.9.4` normalises to `v`-prefixed and writes
`.cleo/release/v2026.9.4.plan.json`. `cleo release reconcile 2026.9.4` — the
same string — took its argument verbatim and looked for `2026.9.4.plan.json`.

The `fix` was the worst part: it said to run `cleo release plan 2026.9.4`, the
command that had just succeeded and produced the file reconcile could not see.
Following it loops forever, and `AGENTS.md`'s runbook uses the bare form for
both verbs, so the runbook as written could not work.

The cause was not a missing call so much as a duplicated rule. `normalizeVersion`
existed as **two byte-identical private copies** — one in `plan.ts`, one in
`release-manifest.ts` — and `reconcile.ts` had neither. Two copies of a rule is
how a third callsite comes to not have it.

Both copies are now deleted in favour of one exported `release/version.ts`, and
`reconcile` normalises **once at its entry boundary**, so the plan path, the tag
lookup and the DB primary key all see the same spelling.

## 2. A provenance failure that did not say what failed

`E_PROVENANCE_FAILED` carried an **empty `fix`** and a message that truncated
before the reason: drizzle wraps a driver failure in an error whose `message` is
the query and its 31 parameters, while SQLite's actual sentence — the NOT NULL /
CHECK / FK text — sits further down the `cause` chain and was dropped.

`ProvenanceTableError` now walks that chain (cycle-guarded, depth-limited) and
leads with the root cause, retaining the query text after it for context. The
envelope carries `rootCause` and the full `causeChain` in `details`, and a `fix`
that names the rejecting table, states that nothing was committed (the whole
reconcile is one transaction), and points at the dry-run.

## Verified

Against the built CLI, without mutating any release:

```
release reconcile 9999.1.1   -> "...release/v9999.1.1.plan.json"   (was 9999.1.1.plan.json)
release reconcile v9999.1.1  -> identical message                  (idempotent)
fix                          -> "Run 'cleo release plan v9999.1.1'" (same spelling the reader uses)
```

`v2026.9.4.plan.json` is the only file matching that version on disk, so the
bare form now resolves to it. The real reconcile was deliberately NOT run — it
writes to the project DB, and that is the release owner's call.

Cause-chain walking verified against the built module: 7/7, including the cyclic
`cause` and depth-limit guards.

## Not addressed

The issue's item 3 — whether an empty `merge_commit_sha` is legitimate for a
tag-triggered reconcile — is **not** resolved here, and deliberately so. It
cannot be answered without the diagnostic this change adds; the next time the
insert is rejected the envelope will name the constraint, and that is the input
that decision needs.
