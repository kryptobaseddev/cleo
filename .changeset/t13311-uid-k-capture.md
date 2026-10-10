---
id: t13311-uid-k-capture
tasks: [T13311, T13305]
kind: fix
summary: "Sync capture: a row-uid fill never captures a stray K (re-key) op"
---

With row uids on by default (T13305), every insert of a minted row into a
store with `sync.capture` on also captured a K (re-key) op. The per-connection
fill sets `uid` and then `birth_fp` in two UPDATEs, and the re-key trigger
treated the second one (`birth_fp` NULL to a value, with `uid` already set) as
a re-key. The `_sync_cap_<t>_k` trigger now fires on a `birth_fp` change only
when the old value was set; the fill-patch trigger alone records the filled
identity on the insert's I capture, in both trigger orders. A store's capture
triggers are regenerated at the next open. Capture is off by default, so no
shipped default changed. Journal spec v11.4 records the decision.
