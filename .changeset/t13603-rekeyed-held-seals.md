---
id: t13603-rekeyed-held-seals
tasks: [T13603]
kind: fix
summary: "A held credential that was re-keyed syncs once its secret is re-entered"
---

A credential row held for an unreadable secret, then re-keyed (its uid moved),
never synced even after the secret was re-entered: phase A sealed only under
the row's new uid while the held insert still carried the old one. Phase A now
also seals under every uid the row's pending captures carry, so the insert,
the re-key and later changes seal in order and the row arrives under its new
uid.
