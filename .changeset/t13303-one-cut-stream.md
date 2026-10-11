---
id: t13303-one-cut-stream
tasks: [T13303]
kind: fix
summary: A store's genesis cut is refused for a second stream until per-stream routing lands
---

Nothing routes a sealed transaction to a stream yet (T13254). A second stream's genesis cut would fold the first stream's sealed,
unsent transactions into its own checkpoint, so the first stream would never push them.

- **The cut now refuses a second stream** while another is cut ("this store already pushes …; a second stream needs per-stream
  routing (T13254)"), before anything is sealed, cut or snapshotted.
- **The per-cut fold range and the "no other stream is cut" undo stay** as defence in depth, for when routing lands.
