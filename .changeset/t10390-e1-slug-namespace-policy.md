---
id: t10390-e1-slug-namespace-policy
tasks: [T10390]
kind: docs
summary: "T10390 E1.5: global slug namespace decision + ADR-076 amendment AMD-001"
---

Records the decision to keep slug uniqueness GLOBAL across all DocKinds (no migration to per-(kind, slug) index). Adds amendment AMD-001 to ADR-076 §6 with three-point evidence + counterfactual analysis. Updates slug-allocator.ts docblock + ct-documentor SKILL.md (v3.3.0).
