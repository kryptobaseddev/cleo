---
id: t13030-bfp-after-rekey-test
tasks: [T13030]
kind: test
summary: "Sealer test pins bfp on a U whose row was re-keyed before sealing"
---

The Stage C audit found T13030's re-key case untested: a U written before its
row was re-keyed must still carry the row's original birth fingerprint
(`bfp`) when sealed, whether the re-key is sealed in the same batch or not
read yet. A test now covers both. No behaviour change.
