---
id: t14394-remove-infra-touch
tasks: [T14394]
kind: chore
summary: "the unused lifecycle/infra-touch.ts module and its tests are removed (its only caller, the IVTR loop, went in T14311)"
---

`packages/core/src/lifecycle/infra-touch.ts` lost its last runtime caller when
the IVTR loop was deleted (T14311). It was never exported from a core barrel,
so no public API changes. The `ct-validator` skill now says the
infrastructure-path rule is applied by the reviewer, with no code behind it.
