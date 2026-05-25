---
id: adr-082-core-tools-first-class
tasks: [T10384]
kind: adr
status: Reserved
date: 2026-05-25
saga: T10377 (SG-IVTR-AC-BINDING)
epic: T10384 (E-IVTR-CLOSEOUT)
related: T9831 (SG-ARCH-SOLID), T10418 (Agent tools registry)
summary: ADR-082 — RESERVED placeholder for the future Core Tools First-Class decision. Substantive content lives in the T9831 / T10418 follow-on work.
---

# ADR-082: Core Tools as First-Class (RESERVED)

## Status

**Reserved** — placeholder slot, content to be written by the T9831 / T10418
follow-on work.

## Date

2026-05-25

## Context

During SAGA T10377 (SG-IVTR-AC-BINDING) the saga decomposition plan §5
allocated three contiguous ADR numbers (080, 081, 082) for the renumbered
sibling ADRs originally drafted as `adr-079-r1`, `adr-079-r2`, and an
implied `adr-079-r3` covering "core tools as first-class agent surface."

ADRs 080 and 081 were authored by this saga (E-ADR-A-REVISION /
E-ADR-B-REVISION) and renamed at saga close-out. The third slot (082)
was reserved for a downstream ADR scoped outside SG-IVTR-AC-BINDING:
**first-class core tool registration for spawned agents** — the
substantive decision belongs to the in-flight T9831 saga work and the
T10418 epic on the full agent tool registry.

This stub reserves the ADR number so saga-internal references that
already point at `ADR-082` remain stable, while the substantive
content is authored by the appropriate downstream owner.

## Decision

**Deferred.** This ADR is a reserved-name placeholder, not a load-bearing
decision. The full first-class core-tools contract will be written by
T9831 (`SG-ARCH-SOLID`) and T10418 (Agent tools registry) and will
land under this slug when those tasks ship.

## Consequences

- ADR slot 082 is reserved — future authors should `cleo docs update
  adr-082-core-tools-first-class` rather than re-allocating a new
  number.
- Saga-internal references that already point at ADR-082 (planning
  docs, retrospective, closure report) remain stable.
- The substantive contract is not pinned by this ADR; readers should
  follow the cross-references to T9831 / T10418 for the live design.

## Cross-references

- T9831 — SAGA SG-ARCH-SOLID (in-flight architectural SSoT work)
- T10418 — Epic: full agent tools registry
- SAGA T10377 — SG-IVTR-AC-BINDING decomposition plan §5
- ADR-080 — AC Stable IDs (this saga, sibling)
- ADR-081 — `satisfies:` Binding Grammar (this saga, sibling)

---

*End of ADR-082 (reserved). Substantive content will arrive via T9831 /
T10418.*
