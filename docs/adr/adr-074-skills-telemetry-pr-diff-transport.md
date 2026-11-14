---
id: ADR-074
title: Skills telemetry transport — scrubbed PR diff (no HTTPS endpoint)
status: Accepted
date: 2026-05-19
task: T9674
linkedTasks: [T9572, T9662, T9666, T9667, T9673, T9678, T9679]
supersedes: null
supersededBy: null
---

# ADR-074: Skills telemetry transport — scrubbed PR diff (no HTTPS endpoint)

**Status:** Accepted
**Date:** 2026-05-19
**Task:** T9674 (this ADR)
**Linked Tasks:** T9572 (epic), T9662 (council cron), T9666 (CLI), T9667 (grade cron), T9673 (wizard step), T9678 (top-N consumer), T9679 (privacy doc)

---

## §1 Context

The SG-CLEO-SKILLS architecture (`docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §5) defines a Sphere A → owner-CI top-N council loop: operator machines surface anonymous `loadCount` signals against canonical skills, and the owner-CI workflows (`.github/workflows/skills-council.yml`, `.github/workflows/skills-grade.yml`) consume those signals to rank which skills the council reviews each week.

The v3 architecture left the transport open with `"phones home to owner-side ingestion endpoint OR scrubbed PR diff to cleocode repo (TBD in T9572)"`. T9674 chooses one.

## §2 Decision

**The telemetry transport is a scrubbed PR diff against `docs/skills/telemetry-aggregate.json` in the cleocode repo.**

There is **no HTTPS endpoint**. There is **no server**. There is **no cloud database**. The only sink is a public GitHub PR that the owner (or the operator) opens against the cleocode upstream repository.

### §2.1 Wire format

A submission is a JSON document with the locked schema:

```typescript
{
  installId: string,          // anonymous UUID v4, per machine
  period: string,             // ISO date (YYYY-MM-DD), reporting window start
  skills: {
    canonicalSkillName: string,
    loadCount: number
  }[]
}
```

**Hard prohibition:** the payload MUST NOT contain user identity, session IDs, paths, hostnames, project names, IP addresses, skill content, or any field not listed above. The CLI and CI gates validate the wire shape against this contract before any submission is written to disk.

### §2.2 Submission flow

1. Operator opts in (default-on; opt-out via `cleo telemetry disable`, T9666).
2. `cleo telemetry submit` (deferred to a later sphere) constructs the payload, validates against the locked schema, and writes the scrubbed JSON to a local file under the operator's clone of cleocode.
3. The operator opens a PR against `cleocode/docs/skills/telemetry-aggregate.json` containing only that diff. No other paths may be modified in the same PR.
4. A CI gate on the cleocode repo (deferred to a later sphere) re-validates the diff against the locked schema and rejects anything that contains additional fields or modifies any path outside `docs/skills/telemetry-aggregate.json`.
5. Once merged, the aggregate file becomes the input to T9678's top-N consumer inside `skills-council.yml`.

### §2.3 Why not HTTPS

| Concern | HTTPS endpoint | Scrubbed PR diff |
|---|---|---|
| Server cost | non-zero (forever) | zero |
| Server uptime | owner is on the hook | n/a |
| Server credentials | secret rotation, IAM | n/a |
| Schema enforcement | runtime (server) | CI gate (auditable) |
| Audit trail | private logs | public git history |
| Operator trust model | "trust the server" | "read the diff" |
| Fork-friendly | downstream needs new endpoint | downstream forks inherit transport |

The PR-diff transport is **public, auditable, zero-cost, and fork-friendly** — properties the HTTPS path cannot match. The cost is throughput (operators only submit when they open a PR), which is acceptable for a weekly council cadence.

## §3 Consequences

### §3.1 Wins

- Zero infrastructure to operate, monitor, or pay for.
- Every submission is publicly auditable (the PR diff is the receipt).
- Schema enforcement lives in CI, not in a server the owner cannot inspect from outside.
- Forks of cleocode inherit the transport with zero changes — they just point at their own aggregate file.
- The `installId` (UUID v4) is generated locally and never leaves the operator's machine in any form that could be correlated to identity by the upstream owner.

### §3.2 Trade-offs

- Submission cadence is human-paced (operator opens a PR), not real-time.
- The first run after the workflows land will see an empty `docs/skills/telemetry-aggregate.json`; the top-N consumer (T9678) tolerates this and exits 0 with an empty selection.
- An adversary who submits a malicious PR could in principle poison the aggregate; CI schema validation + the existing PR review gate handle this.

### §3.3 Anti-patterns this ADR locks out

- ❌ Adding a `telemetry.endpoint` config key (no endpoint exists by design).
- ❌ Spawning a background daemon to ship telemetry without operator action.
- ❌ Including any field beyond the §2.1 schema in any submission.
- ❌ Modifying multiple paths in a telemetry-submission PR.
- ❌ Auto-merging telemetry PRs (preserve owner-review gate).

## §4 Implementation surface (T9572 epic — this saga)

| Task | Surface | ADR section |
|---|---|---|
| T9662 | `.github/workflows/skills-council.yml` | §2.2 step 5 |
| T9666 | `cleo telemetry enable/disable/status` CLI + locked schema types | §2.1 |
| T9667 | `.github/workflows/skills-grade.yml` | §2.2 step 5 |
| T9673 | Wizard `telemetry` section (default-on) | §2.2 step 1 |
| T9674 | This ADR | n/a |
| T9678 | Top-N consumer in `skills-council.yml` reading `telemetry-aggregate.json` | §2.2 step 5 |
| T9679 | Privacy doc at `docs/owner-ci/skills-pipeline.md` | §2.1 + §2.2 |

Future spheres (B/C/D/E in `SG-CLEO-SKILLS-architecture-v3.md` §3) MAY add a `cleo telemetry submit` command that writes the scrubbed JSON to disk + a `gh pr create` step; that command is deliberately NOT part of T9572 so the schema + transport contract are reviewed independently before any submission tooling ships.

## §5 References

- `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §5 (Telemetry & opt-out)
- `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §7 (Anti-patterns — workflow-bundling prohibition)
- `packages/cleo/src/cli/commands/telemetry.ts` (T9666 — locked schema source)
- `docs/owner-ci/skills-pipeline.md` (T9679 — operator-facing privacy doc)
