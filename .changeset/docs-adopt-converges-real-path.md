---
id: docs-adopt-converges-real-path
tasks: [T13586]
kind: fix
summary: the first docs update on two devices now adopts the doc under one uid (the adopt read the device's own new row)
---

The convergent adopt from the earlier T13586 fix took the doc's birth from
the slug's current registry row. A docs update moves the slug onto a new row
stamped with the updating device's clock before the doc is adopted, so in a
real `docs update` each device still minted its own uid. The update now
passes the pre-update row's `created_at` (a synced value) into the adopt, and
adopts even when the prior blob bytes are missing locally, so both devices
mint one uid.
