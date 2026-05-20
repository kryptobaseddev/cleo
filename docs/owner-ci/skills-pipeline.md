# Skills owner-CI pipeline — operator privacy notes

**Task:** T9679
**Epic:** T9572 (E-SKILLS-OWNER-CI)
**Status:** Locked at v2026.5.82 / SG-CLEO-SKILLS Sphere A

This doc is the **operator-facing** privacy summary for the skills owner-CI
pipeline. It complements the technical contract in
[ADR-074](../../.cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md)
and the architecture in
[`docs/architecture/SG-CLEO-SKILLS-architecture-v3.md`](../architecture/SG-CLEO-SKILLS-architecture-v3.md).

---

## What the pipeline does

1. CLEO ships with anonymous skills-usage telemetry **default-on** for new installs.
2. Each operator machine accumulates a per-skill `loadCount` over a monthly reporting period.
3. When the operator chooses to share, the local telemetry payload is written out as a JSON diff against `docs/skills/telemetry-aggregate.json` in the cleocode repo and submitted as a PR.
4. A weekly owner-CI cron (`skills-council.yml`, Sunday 06:00 UTC) reads the aggregate, picks the top-N skills by aggregated `loadCount`, and runs the multi-advisor council against them.
5. A second owner-CI cron (`skills-grade.yml`, Monday 07:00 UTC) grades every canonical skill against the ct-grade rubric and stores a scorecard per skill.

Both crons are gated by `if: github.repository == 'kryptobaseddev/cleo'` so forks **never** run the schedule.

---

## What the telemetry payload contains

The payload schema is **locked**. Any field outside this list is rejected by both the CLI (T9666) and the owner-CI selector (T9678):

```jsonc
{
  "installId": "string (anonymous UUID v4)",
  "period": "string (ISO date, reporting window start)",
  "skills": [
    {
      "canonicalSkillName": "string (manifest-canonical)",
      "loadCount": "number (non-negative integer)"
    }
  ]
}
```

## What the telemetry payload **does not** contain

- ❌ User identity (no email, no GitHub handle, no username)
- ❌ Session IDs (no `cleo session` correlation)
- ❌ Paths (no `cwd`, no project root, no skill install path)
- ❌ Hostnames or machine names
- ❌ IP addresses (no network identifier is ever serialised)
- ❌ Project names or repo names
- ❌ Skill content (only canonical names + counts)
- ❌ Telemetry endpoint URLs (there is **no endpoint** — see ADR-074)

The CLI source (`packages/cleo/src/cli/commands/telemetry.ts`) enforces the
shape on construction. The owner-CI selector
(`scripts/skills/select-top-n.mjs`) re-validates on ingestion and **drops**
any submission carrying extra top-level fields.

---

## How to opt out

A single command, anywhere:

```bash
cleo telemetry disable
```

That writes `telemetry.enabled = false` to your **global** config (so the
opt-out survives `cleo init` in any new project). To re-enable later:

```bash
cleo telemetry enable
```

Your anonymous `installId` is **preserved** across disable → enable so the
owner-CI can deduplicate periodic submissions without ever re-identifying
you. To inspect what is set:

```bash
cleo telemetry status
```

---

## How submissions reach the owner CI

There is **no HTTPS endpoint and no server.** The transport is a public,
auditable GitHub PR:

1. You opt in (default-on; opt-out anytime).
2. A future `cleo telemetry submit` command (Sphere B+) constructs the JSON payload, validates it against the locked schema, and writes it to disk.
3. You open a PR against `cleocode/docs/skills/telemetry-aggregate.json` containing **only** that diff.
4. A CI gate on the cleocode repo re-validates the diff against the locked schema and rejects PRs that modify any other path.
5. Once the owner reviews and merges, the aggregate becomes input to the next council pass.

The PR is the receipt. Anyone can read it. Anyone can audit what was sent.

---

## Why this design

We picked the scrubbed-PR-diff transport over an HTTPS endpoint for five reasons:

| Property | HTTPS endpoint | Scrubbed PR diff |
|---|---|---|
| Operator trust model | "trust the server" | "read the diff" |
| Server cost / uptime | non-zero, forever | zero |
| Schema enforcement | private (server-side) | public (CI gate) |
| Audit trail | private logs | public git history |
| Fork-friendly | needs new endpoint | inherits unchanged |

The full rationale (including the locked anti-patterns) is in
[ADR-074 §3](../../.cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md).

---

## Pipeline file map

| File | Purpose | Task |
|---|---|---|
| `.github/workflows/skills-council.yml` | Sunday 06:00 UTC council cron, owner-CI only | T9662 |
| `.github/workflows/skills-grade.yml` | Monday 07:00 UTC grade cron, owner-CI only | T9667 |
| `packages/cleo/src/cli/commands/telemetry.ts` | `cleo telemetry enable/disable/status` | T9666 |
| `packages/core/src/setup/sections/telemetry.ts` | Default-on wizard step | T9673 |
| `.cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md` | Transport ADR + schema lock | T9674 |
| `scripts/skills/select-top-n.mjs` | Top-N consumer used by council cron | T9678 |
| `docs/owner-ci/skills-pipeline.md` | This doc | T9679 |
| `docs/skills/telemetry-aggregate.json` | Aggregate sink (created by first operator PR) | — |
| `docs/skills/council-reports/<skill>.md` | Per-skill council output | T9662 |
| `docs/skills/grade-reports/<skill>.md` | Per-skill grade output | T9667 |

---

## Anti-patterns the pipeline rejects

- Bundling these workflows in the npm package (`@cleocode/cleo` excludes `.github/`).
- Auto-modifying canonical skills on operator machines (council/grade reports stay in `docs/skills/`).
- Multi-path PRs that combine telemetry with other changes (CI gate rejects).
- Squash-merging skill PRs (preserve task ↔ commit traceability per ADR-062).
- Adding telemetry endpoints or background ship-on-tick daemons (ADR-074 §3.3).

If you find a violation of any of the above in the codebase, **please open
an issue** — they are intentional invariants and any regression should be
fixed at the source, not worked around.
