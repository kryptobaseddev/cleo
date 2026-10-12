---
id: t13567-test-run-content-staleness
tasks: [T13567, T13569]
kind: fix
summary: "A test-run or qa-run receipt is no longer stale when a checkout or merge after the run rewrote an input with identical bytes"
---

Receipt freshness compared mtimes alone. When a checkout or integration merge after the run rewrote a changed file with identical bytes, the receipt was refused with `E_EVIDENCE_STALE`. A path whose mtime is newer than the run is now left out only when HEAD moved after the run (per the reflog) and the file's blob equals its blob both at the new HEAD and at HEAD as of the run: the move rewrote it without changing it.

Nothing else is exempt (T13569). A bare `touch` cannot be told apart from reverting an edit made during the run, because the receipt carries no run-time content fingerprint, so its newer mtime still stales the receipt; a false pass is worse than a needless re-run. A checkout to different content, or any edit, also stales it and names the file. T13571 tracks a CLEO-made run-time fingerprint that would let a touch keep the receipt.
