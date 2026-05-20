# Citation and Evidence

Research is only useful if it is verifiable. This reference defines the
evidence ladder, citation format, and confidence labels that every research
finding in CLEO MUST carry. The downstream consumers — `ct-spec-writer`,
`ct-consensus-voter`, the orchestrator's HITL gates — rely on these signals
to weight findings correctly.

## Evidence Ladder

Findings sit on a five-rung ladder. Each finding in the output file MUST be
marked with the strongest rung that applies.

| Rung | Label | Meaning | Citable? |
|------|-------|---------|----------|
| 5 | `verified` | Reproduced locally or confirmed in two independent canonical sources | Yes |
| 4 | `documented` | Confirmed in one canonical source (official docs, RFC, source code) | Yes |
| 3 | `reported` | Stated in a credible community source (named blog, conference talk, well-cited GitHub issue) | Yes, with caveat |
| 2 | `anecdotal` | Stated in an uncredentialed source (random blog, forum post) | No — needs corroboration |
| 1 | `hypothesis` | Inferred but not verified | Never |

Findings at rung 1-2 MUST live in a separate `## Hypotheses` section, never
mixed with verified findings. The spec writer downstream will silently treat
all findings as verified facts unless the rung labels are explicit.

## Canonical Sources by Domain

| Domain | Canonical source |
|--------|------------------|
| HTTP/REST semantics | IETF RFCs (RFC 7230-7235, RFC 9110) |
| TLS/crypto | RFC + IANA registries + NIST publications |
| JavaScript language | ECMAScript spec (tc39.es) + MDN |
| TypeScript | typescript-go source or microsoft/TypeScript |
| Node.js APIs | nodejs.org/api/* + Node source code |
| Library X | github.com/<owner>/<repo> README + docs + release notes |
| CLEO architecture | `.cleo/adrs/ADR-*.md` (project-internal canon) |
| CLEO past decisions | `cleo memory find` + `.cleo/agent-outputs/` |
| Cloud platforms (AWS/GCP/Azure) | Vendor's "what's new" page + product docs |

Blog posts and Medium articles are NOT canonical — they are interpretive
layer that may have drifted from the source.

## Citation Format Standards

Every citable finding includes at minimum: source identifier, retrieval
location, and (where relevant) retrieval date.

### Web Source

```markdown
According to the [Next.js 15 caching docs](https://nextjs.org/docs/app/building-your-application/caching),
the default fetch cache behavior changed from `force-cache` to `no-store`.
Retrieved 2026-05-19.
```

### Official Repository

```markdown
The `defineRelations` API was introduced in
[drizzle-team/drizzle-orm@e2b9c1a](https://github.com/drizzle-team/drizzle-orm/commit/e2b9c1a)
and replaces the legacy `relations()` helper.
```

### Project-Internal (ADR)

```markdown
ADR-065 §3 establishes the PR-gated release pipeline — direct pushes to
`main` are prohibited (`.cleo/adrs/ADR-065-release-pipeline.md`).
```

### Project-Internal (Code)

```markdown
The current implementation in `packages/core/src/store/openCleoDb.ts:42-78`
routes all DB opens through a single chokepoint per Decision D003.
```

### Project-Internal (BRAIN)

```markdown
BRAIN observation `O-mpd07uma-0` records that pub1-diagnoser correctly
refused under broken dispatcher — confirming the protocol-correct refusal
pattern is exercising at agent-level.
```

### Context7 Fetch

```markdown
Context7 query `/vercel/next.js/v15` against the question "how do I set
revalidation interval" returns the `revalidate` segment-config option as
the canonical mechanism.
```

## Conflict Handling

When two canonical sources disagree, the research output MUST surface the
conflict rather than silently picking one. Recommended pattern:

```markdown
### Finding: Default cache behavior in Next.js 15

- The [official caching docs](https://nextjs.org/docs/app/.../caching)
  state the default is `no-store`.
- The [release notes for 15.0](https://nextjs.org/blog/next-15) describe
  the change but also mention a `staleTimes` config that softens it.
- Resolution: the default IS `no-store`, but `staleTimes` can restore
  per-segment caching when explicitly configured.
```

Conflict surfaces are the most valuable research output — they prevent
downstream consumers from making decisions on partial information.

## Confidence Labels

In addition to the evidence rung, each `key_findings` entry in the manifest
SHOULD carry a confidence band when the rung is below 4. The orchestrator
uses this for HITL gating in `ct-consensus-voter`.

| Confidence | Meaning |
|------------|---------|
| 0.9–1.0 | Verified — multiple canonical sources agree |
| 0.7–0.9 | High — one canonical source, no conflicts |
| 0.5–0.7 | Medium — community sources agree, no canonical |
| 0.3–0.5 | Low — single source or conflicting evidence |
| 0.0–0.3 | Speculation — hypothesis only, not citable |

The manifest entry MUST reflect these in `key_findings`:

```json
{
  "key_findings": [
    "Next.js 15 default cache is no-store (verified, 0.95)",
    "staleTimes config can restore caching (documented, 0.85)",
    "Migration path for existing apps requires per-route audit (reported, 0.6)"
  ]
}
```

Downstream skills filter by confidence — `ct-spec-writer` ignores findings
below 0.5 unless the user explicitly opts in.
