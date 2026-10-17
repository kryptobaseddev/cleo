---
id: docs-adopt-converges
tasks: [T13586]
kind: fix
summary: two devices adopting the same legacy doc into the conduit store now mint one doc uid instead of two
---

`ensureConduitDoc` gave an adopted identity shell a random uid and the
adopting device's author and clock, so a second device adopting the same
legacy doc minted another uid and the peer shell was held as a key collision.
The shell now takes the legacy registry birth and a `cleodocs` sentinel
author; its uid and birth fingerprint follow the standard minted recipe, so
both devices converge and the receiver places the peer copy as a duplicate.
The `docs.doc.adopt-once` sync invariant is reclassified as `identity-layer`.
