# ADR Examples

Full, realistic ADR artifact. Use as a copy-paste starting point; replace every field before committing.

## Example: ADR-0042 (Adopt Drizzle ORM v1 beta)

```markdown
---
id: ADR-0042
title: "Adopt Drizzle ORM v1 beta for all SQLite access"
status: proposed
date: 2026-04-06
consensus_manifest_id: CONS-2026-04-06-0017
supersedes: []
superseded_by: []
---

# ADR-0042: Adopt Drizzle ORM v1 beta for all SQLite access

## 1. Context and Problem Statement

The CLEO monorepo currently pins `drizzle-orm@0.29.x`. That line diverges from
the v1 beta schema introspection model and no longer supports the `defineRelations`
primitive we need for the `decision_evidence` cascade query. Backporting patches
is feasible but compounds tech debt for every new migration. The consensus skill
(T4797) produced a PROVEN verdict at 0.82 confidence recommending immediate
migration to the v1 beta line.

## 2. Options Evaluated

The consensus skill evaluated three options:

* **Option A**: Stay on `drizzle-orm@0.29` and backport v1 schema fixes into a
  fork. Low risk in the short term; high tech debt curve.
* **Option B**: Move the project to `drizzle-orm@1.0.0-beta` pinned to a single
  beta tag per release, accept API churn, migrate one package per wave.
* **Option C**: Drop Drizzle entirely and move all SQLite access to Kysely.
  Cleanest long-term abstraction but invalidates the entire migrations
  directory and loses eight months of tooling.

## 3. Decision

Adopt `drizzle-orm@1.0.0-beta` across every package that touches SQLite. Each
release pins exactly one beta tag. Rollbacks happen per package, never per
release.

## 4. Rationale

Derived from CONS-2026-04-06-0017 (verdict PROVEN, 0.82 confidence). Three
agents voted Option B with high confidence, one voted Option A, none voted
Option C. The deciding evidence was the `defineRelations` primitive's ability
to express the `decision_evidence` cascade in a single declarative pass, which
the 0.29 line cannot do. The dissenting Option-A vote flagged API churn risk,
which is mitigated by the per-release pin in the Decision section.

## 5. Consequences

### Positive

* Single ORM path across the monorepo; no per-package downgrades.
* `defineRelations` unblocks the cascade query this ADR depends on.
* Migrations directory stays canonical.

### Negative

* Every beta release requires a compatibility review before pin bump.
* Type surface changes per beta; downstream packages must rebuild.
* No long-term stability guarantee from upstream until the beta closes.

## 6. Downstream Impact (Traceability)

The following artifacts are flagged as directly dependent on this ADR and MUST
be updated or re-validated when the decision lands:

| Artifact | Type | Reason |
|----------|------|--------|
| T4776 | specification | Defines the `decisions` table schema; must adopt v1 primitives |
| T4781 | specification | Defines the `decision_evidence` relation |
| T4772 | decomposition | Epic that owns the migration waves |
| T4790 | implementation | Live work on the decisions migration path |

Rejected alternatives remain in the manifest for institutional memory but MUST
NOT be cited by any downstream artifact.
```

## Example: ADR-0043 (Deprecate ADR-0042)

A deprecation ADR removes a decision from canon without replacing it. No downstream cascade runs; the `decision_evidence` rows stay live because nothing supersedes them.

```markdown
---
id: ADR-0043
title: "Deprecate Drizzle v1 adoption decision"
status: deprecated
date: 2026-05-12
consensus_manifest_id: CONS-2026-05-12-0003
supersedes: []
superseded_by: []
---

# ADR-0043: Deprecate Drizzle v1 adoption decision

## 1. Context and Problem Statement

Upstream has frozen the v1 beta line without a GA date. The migration planned
in ADR-0042 is paused pending a new decision path.

## 2. Options Evaluated

* Option A: Supersede ADR-0042 with a new ORM choice.
* Option B: Deprecate ADR-0042 without replacement and defer the decision.

## 3. Decision

Deprecate ADR-0042 without replacement. Downstream specs remain stable; no
cascade fires.

## 4. Rationale

Derived from CONS-2026-05-12-0003. No replacement is ready; forcing a
supersession would produce a contested cascade.

## 5. Consequences

### Positive
* Downstream work on v0.29 is not invalidated.

### Negative
* `defineRelations` work stays blocked until a future ADR is authored.

## 6. Downstream Impact (Traceability)

None. Deprecation is a canon-only operation.
```

## Things to Notice

- Frontmatter `supersedes` and `superseded_by` are always arrays, even when empty.
- The `consensus_manifest_id` in the frontmatter MUST match the id in the manifest entry; the validator cross-checks.
- Section 6 is the only section that links to tasks by id. Sections 1-5 stay prose-only.
- Rejected alternatives live in section 2, not in a separate "rejected" section, so they travel with the options list forever.
