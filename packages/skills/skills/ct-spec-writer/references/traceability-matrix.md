# Traceability Matrix

Every REQ in a CLEO spec MUST be traceable to (a) the source justifying
its existence and (b) the test that verifies its implementation. The
traceability matrix is the table that makes those links explicit and
machine-readable. Without it, specs decay — requirements survive
implementations they no longer reflect.

## Three-Way Trace

A complete trace links three artifacts:

```
[Source]  ── justifies ──>  [Requirement]  ── verified by ──>  [Test]
```

- **Source.** The research finding, ADR, user need, or upstream spec that
  motivates the requirement.
- **Requirement.** The REQ-NNN entry in this spec.
- **Test.** The test file/case that exercises the requirement.

Each link MUST be a stable identifier — not prose. "REQ-007 was discussed
in a meeting" is not a trace; "REQ-007 derives from ADR-065 §3" is.

## The Matrix Block

Include this block in every spec, immediately before the `## Compliance`
section.

```markdown
## Traceability

| REQ | Source | Verification |
|-----|--------|--------------|
| REQ-001 | ADR-065 §3 | `packages/cleo/__tests__/release-pipeline.test.ts::cuts-from-main-tip` |
| REQ-002 | ADR-065 §3 | `packages/cleo/__tests__/release-pipeline.test.ts::refuses-direct-push` |
| REQ-003 | T9580 acceptance | `packages/cleo/__tests__/release-ship.test.ts::epic-completeness-check` |
| REQ-004 | RFC 7230 §3.2 | `packages/transport/__tests__/http.test.ts::header-canonicalization` |
| REQ-005 | (TODO: assign source) | (TODO: write test) |
```

Rows with `(TODO: ...)` are acceptable in `draft` status, NOT in
`accepted`. A spec cannot move to `accepted` while any TODO row remains.

## Source Token Conventions

The source column accepts these forms:

| Form | Example | When to use |
|------|---------|-------------|
| ADR reference | `ADR-065 §3` | Decision recorded in `.cleo/adrs/` |
| Spec reference | `Spec-foo v1.2 REQ-007` | Inherited from upstream spec |
| Task reference | `T9580 acceptance` | Direct from task acceptance criteria |
| Research reference | `.cleo/agent-outputs/2026-05-19_caching.md §Findings` | From research output |
| External standard | `RFC 7230 §3.2` | IETF / W3C / ISO standard |
| BRAIN reference | `D003` or `O-mpd07uma-0` | Stored decision or observation |
| User mandate | `Owner directive 2026-05-19` | Direct from user/owner |

The form `(meeting notes)` or `(slack thread)` is NOT acceptable — these
are ephemeral and not citable.

## Verification Token Conventions

The verification column accepts these forms:

| Form | Example | Meaning |
|------|---------|---------|
| Test ID | `pkg/__tests__/foo.test.ts::case-name` | Unit/integration test exists |
| Eval ID | `eval-suite-x::scenario-7` | Agent eval covers this REQ |
| Manual procedure | `docs/qa/manual-release-checklist.md §A` | Human verification step |
| Tool gate | `pnpm run typecheck` | Toolchain enforces this REQ |
| Linter rule | `biome.json::rules.style.X` | Linter rule covers this REQ |

A REQ that cannot be verified is not a requirement — it is a wish.
Reject any REQ that lacks a verification plan during draft review.

## Bidirectional Index

Large specs (more than 30 REQs) SHOULD include a reverse index from test
back to REQ, so a failing test can be located against its requirement
quickly.

```markdown
## Test → REQ Reverse Index

- `release-pipeline.test.ts::cuts-from-main-tip` → REQ-001
- `release-pipeline.test.ts::refuses-direct-push` → REQ-002
- `release-ship.test.ts::epic-completeness-check` → REQ-003
- `http.test.ts::header-canonicalization` → REQ-004
```

Generate this manually for small specs; large specs SHOULD include a
script at `scripts/extract-trace.ts` that produces it from the forward
matrix.

## Trace Health Metrics

A healthy spec has these properties — `ct-validator` reports on them.

| Metric | Healthy | Warning | Failure |
|--------|---------|---------|---------|
| REQs without source | 0 | 1-2 | 3+ |
| REQs without verification | 0 | 1-2 | 3+ |
| Tests not linked from any REQ | low | 10-25% | 25%+ |
| External standard refs | present | (n/a) | (n/a) |
| TODO rows in accepted spec | 0 | (cannot be) | any |

## Drift Detection

When the implementation evolves, the matrix drifts. Detect drift with:

```bash
# List tests that exist on disk
find packages -name "*.test.ts" -exec grep -l "REQ-" {} \;

# Compare to REQs claimed in the matrix
grep "^| REQ-" docs/specs/*.md

# Diff yields:
# - tests referencing REQs not in any matrix (orphan tests)
# - matrix REQs whose tests have disappeared (broken trace)
```

This SHOULD run in CI on `pull_request` touching `docs/specs/**`. The
existing CI `skills` job (or a new `spec-trace-check` job) is the right
home — the workflow MUST fail when broken traces appear in `accepted`
specs.

## Inheritance When Specs Refactor

When Spec-A is superseded by Spec-B, copy the matrix forward and add a
`Supersedes` column for the legacy REQ ID. This preserves test trace
across the rename.

```markdown
| REQ (new) | Supersedes | Source | Verification |
|-----------|------------|--------|--------------|
| REQ-001 | Spec-A REQ-007 | ADR-065 §3 | test::cuts-from-main-tip |
| REQ-002 | Spec-A REQ-008 | ADR-065 §3 | test::refuses-direct-push |
| REQ-003 | (new) | T9580 | test::epic-completeness-check |
```

The legacy spec MUST mark itself `deprecated` and link forward to the
successor. Never delete the legacy spec until all tests have been
re-attributed.
