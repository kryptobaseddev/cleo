---
id: t13446-docs-triage-jev
tasks: [T13446]
kind: feat
summary: "cleo docs triage: batch Jev (System One) keep/update/supersede/archive verdicts over draft docs via the new docs.triage decide site (shadow mode, proposals only, --record persists proposed D#### decisions)"
---

Adds the `docs.triage` decision site (T13446, saga T13339): a registered
gate-35 row in `packages/core/src/decide/sites/registry.ts` (choice verdict +
staleness score, primary rung `system-one`, rule fallback, `defaultMode:
'shadow'` — `on` awaits go-live evidence) and the batch triage engine in
`packages/core/src/docs/triage.ts`.

`cleo docs triage [--limit N] [--status draft] [--record]` scans docs oldest
first (default: drafts) and asks two System One questions per doc through
`decideBatch` — a keep/update/supersede/archive choice and a 5-level staleness
score. Every string field is redacted then clipped before it leaves the
machine; an unconfigured provider resolves the site to `off` (zero network,
rule-fallback verdicts); provider `unauthorized`/`insufficient_credits`
answers abort the run before the next batch goes out.

The command NEVER mutates a doc. Default output is a dry report of proposals;
`--record` persists each verdict as a typed D#### decision with
`confirmationState: 'proposed'` via `storeDecision`, so the pilot run over the
repo's 2,152 draft docs stays reviewable and reversible.

Touches `@cleocode/core` (site + engine) and `@cleocode/cleo` (dispatch domain
op + CLI subcommand).
