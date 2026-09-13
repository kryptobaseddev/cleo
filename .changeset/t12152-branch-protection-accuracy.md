---
id: t12152-branch-protection-accuracy
tasks: [T12152]
kind: docs
summary: AGENTS.md states the one deliberate exception to "NO direct pushes to main" — admins bypass the required check by design
---

Outcome of the AGENTS.md enforcement audit (T12152).

"**NO direct pushes to `main`.**" reads absolute. Measured against the live configuration, it has exactly one hole, and it is intentional:

```json
{ "enforce_admins": false, "required_checks": ["CI"], "strict": true,
  "force_push": false, "deletions": false }
```

`enforce_admins: false` is set explicitly by AGENTS.md's own branch-protection snippet further down the same section, so the document and the configuration already agree — an admin can merge without the required `CI` check, by the owner's design.

Everything else is closed: no force pushes, no deletions, and `strict: true` (a branch must be up to date with `main` before it can merge).

The note exists so that an agent reading the absolute phrasing does not treat an admin bypass as evidence the pipeline is broken, or later "discover" it as a vulnerability. **Accuracy about a deliberate exception costs one sentence and prevents a false finding.**

## Audit context

This was the only actionable item from the full sweep. Of 11 enforcement claims checked, **one** named a mechanism that does not exist — the `Skill Drift Check` job (GH #1256, filed separately, with the false claim already downgraded in AGENTS.md).

Two candidate findings were killed by checking rather than filed:

- **forge-ts running under `|| true`** is not drift: `ci.yml` documents the job as `ADVISORY (continue-on-error: true)` and AGENTS.md hedges it as "validate with `forge-ts` **when available**".
- **`noExplicitAny` at `warn` severity** is not drift either: CI runs `biome ci .`, not `biome check`, and `biome ci` exits non-zero on warnings. Measured with an `export function probe(x: any): any` file — `biome ci` exits 1. The enforcement is real; it simply does not live where the severity level suggests, so an audit by reading severities would have concluded the opposite with high confidence.

The short list is itself the result: the four drift instances found earlier in this saga (gate 14's original case, the 10-of-15 runner, the missing skill gate, the stale ADR-057 alias) are **specific lapses, not systemic rot** — which is the argument for fixing them rather than for distrusting the document.
