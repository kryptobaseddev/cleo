---
id: t10493-satisfies-binding
tasks: [T10493]
kind: docs
summary: ADR-079-r2 — cross-task satisfies binding grammar (saga T10377 council action #2)
---

Files ADR-079-r2 (slug `adr-079-r2-satisfies-binding`) pinning the formal grammar for `satisfies:<task-id>#<ac-id>` evidence atoms: RFC 5234 ABNF, same-saga scope rule, five-check validator semantics, and seven explicit error codes (`E_AC_BINDING_MALFORMED`, `E_AC_BINDING_TARGET_NOT_FOUND`, `E_AC_BINDING_TARGET_TERMINAL`, `E_AC_BINDING_TARGET_AC_NOT_FOUND`, `E_AC_BINDING_OUT_OF_SCOPE`, `E_AC_ALIAS_DRIFTED`, plus `W_AC_ALIAS_DRIFTED` / `W_AC_DRIFTED` warnings). Extends ADR-079-r1 §2.4 (basic shape contract) without superseding it. Closes Council §3.1 action item #2 — every sibling ADR in SG-IVTR-AC-BINDING can now consume the binding format. Scope choice (SAME SAGA) is documented with explicit rationale against unrestricted and same-epic-only alternatives.
