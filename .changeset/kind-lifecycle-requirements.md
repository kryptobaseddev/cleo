---
id: kind-lifecycle-requirements
tasks: [T12140]
kind: feat
summary: per-kind lifecycle requirements — the staged pipeline gates only the kinds it describes (gh#494)
---

CLEO's epic pipeline (`research → consensus → architecture_decision →
specification → decomposition → implementation`) was calibrated for
design-bearing code work and applied to every epic regardless of what the epic
is. A documentation epic, a spike, a bug-fix epic or a release epic hit the
same wall: a child task with complete, honest evidence could not complete until
the parent had been walked through five stages that describe nothing about the
work.

The only escape was four `cleo lifecycle skip --reason` calls plus a
`lifecycle start`, per epic. Each skip writes an audit record asserting a
deliberate bypass — so routine work generated routine bypass records, and an
audit trail that is mostly ceremony-avoidance is worse than none, because it
still looks like evidence.

The issue proposed a new `doc` kind whose semantics are "skip the stages". That
encodes an exception rather than answering the question, and the next non-code
work type would need a second one. Instead `KIND_LIFECYCLE_REQUIREMENTS`
answers it on the axis that already exists (ADR-066 `--kind`): each kind
declares whether the staged pipeline gates child completion, with a rationale
surfaced where the rule fires.

`work` keeps the full ceremony — the stages exist for exactly that case and are
not weakened. `bug`, `research`, `spike`, `experiment` and `release` do not: a
fix operates inside an existing design, research IS the antecedent work, a
spike exists to produce what the design stages would consume, an experiment is
run to learn whether an approach holds, and a release ships decisions made
elsewhere.

An absent or unknown kind resolves to `work`, so a missing field can never
become the cheapest way to opt out.

**Evidence gates are unaffected.** Every ADR-051 gate still demands its
programmatic proof. This axis governs ceremony, not rigour.

The table is const data in `@cleocode/contracts`; the predicates live in
`packages/core/src/lifecycle/kind-requirements.ts` because contracts is
types-only (architectural gate 10).
