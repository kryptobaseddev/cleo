---
id: t13314-seal-clock-clamp
tasks: [T13314]
kind: feat
summary: "Sealing clamps each op's clock to the server's date plus MAX_DRIFT, so writes stamped while the clock ran ahead never carry future HLCs"
---

A device whose clock ran ahead of the server's pauses push (journal spec §1.3), but its writes are still captured with the
clock's ahead time. Once the clock was put right and push resumed, those captures used to seal with future HLCs. A future HLC
wins every last-writer-wins race on every device.

- Each push now records the server's clock offset and when it was observed (`sync.server_clock` in `_sync_meta`).
- The sealer stamps each op no later than the server's estimated date plus `MAX_DRIFT` (5 minutes) when that observation is
  under 24 hours old. Without a recent observation, sealing is unclamped, as before.
- HLCs stay monotonic. The clamp only bounds the physical candidate, and the counter still orders ops.
