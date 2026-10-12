---
id: t13031-sealer-chash-kmove-tests
tasks: [T13031]
kind: test
summary: "Sealer tests pin two-replica chash equality and fhlc kept across a re-key"
---

Two sealer tests close the gaps the Stage C audit found in T13031: two stores
holding the same logical rows under different display ids (and a reference
column pointing at a differently-numbered parent) compute the same row
`chash`, and a re-key (K) moves row meta keeping a non-null per-field `fhlc`
together with `hlc`, `version` and `chash`. No behaviour change.
