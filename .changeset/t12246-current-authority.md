---
id: t12246-current-authority
tasks: [T12246]
kind: fix
summary: Retrieve current sourced memory and preserve historical claims without implicit synthesis
---

Memory search applies current eligibility across lexical, fallback, semantic, and graph-expanded retrieval. Explicit history remains available. Obsolete wording can resolve to its explicit successor with the relationship exposed; decision-only filtering is enforced and unsupported types are rejected.

Similarity and contradiction scores identify candidates without establishing authority or invalidating prior records. Calling agents can store sourced decisions and learnings without invoking a background model. ADR dialectic validation is explicit opt-in and remains separately available.

Memory diagnostics separate structural cleanliness, semantic conflict, extraction availability, and coverage. Empty hook traces are no longer generated. Confirmed legacy empty shapes can be reversibly quarantined; substantive short incidents and intentional cross-project references remain available.

Code placed in packages/core/ per Package-Boundary Check — verified against AGENTS.md. Shared wire contracts live in packages/contracts/ and CLI handlers remain thin.
