---
id: row-identity-ref-probe-sql
tasks: [T13261, T12341]
kind: fix
summary: "Row identity: the steady-open ref probe runs no JS hash per dangling reference"
---

`rowIdentityFillPending` asks, on every fill-on open, whether a NULL stored
reference (`ac_uid`, `ac_text_hash`) has become resolvable. For
`ac_text_hash` it evaluated the JS AC-text hash on every NULL row, so a store
with many legitimately dangling bindings paid one JS call per row on every
open. The probe now checks the same condition in plain SQL: the hash is
non-NULL exactly when the referenced criterion's `text` is a string,
`typeof(text) = 'text'`. The fill pass itself is unchanged. A reference that
becomes resolvable is still found, and a test pins both behaviours.
