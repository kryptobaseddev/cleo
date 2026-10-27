---
id: satisfies-alias-exact-match
tasks: [T14029]
kind: fix
summary: "satisfies alias drift compares parsed atom ids exactly, so #AC1 no longer matches a prior #AC10 binding"
---

`cleo verify` refused `satisfies:<task>#AC1` with `E_AC_ALIAS_DRIFTED` once
`#AC10` had been bound on the same task: drift detection matched binding atom
ids by substring, so `T13938#AC1` matched `T13938#AC10` (and source `T1`
matched `T13938`). Binding atom ids are now parsed with an anchored pattern
(`satisfies:<source>-><target>#<alias>[@<pin>]`) and each part compared
exactly; drift still fires when the same alias resolves to a different UUID.
