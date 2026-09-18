---
id: t12249-instruction-delivery
tasks: [T12249]
kind: fix
summary: Deliver self-contained knowledge protocols and diagnose broken instruction references
---

Managed agent instructions now deliver a compact orient, inspect authority and coverage, act, verify, and record protocol. Providers with unverified reference expansion receive self-contained managed content. User-authored content is preserved.

Instruction diagnostics expose missing references, cycles, duplicate injection, stale delivery, and expansion limits. Repository instructions explain source ownership, loading paths, precedence, provider differences, and verification duties. Static delivery checks explicitly leave unavailable live provider evaluations unverified.

The canonical docs registry now exposes already implemented operations used by these instructions, including status and publication routes. Behavioral dispatch regressions protect runtime reachability rather than relying only on command help.

Code placed in packages/caamp/ for instruction packaging, packages/core/ for shared delivery, packages/contracts/ for types and operation metadata, and packages/cleo/ for dispatch per Package-Boundary Check — verified against AGENTS.md.
