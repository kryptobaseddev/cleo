---
id: stale-store-freshness
tasks: [T14556]
kind: fix
summary: "Store recovery: detect and merge history hidden by a stale main file"
---

Doctor compares task, session, audit and memory high-water marks with the newest
validated snapshot and a SQLite-validated WAL view, without opening live files.
Repair preserves newer snapshot rows and live-only rows, quarantines originals,
and records ambiguous versions in recovery.json instead of inferring deletions
from a stale checkout. Rejected WAL commits without a newer recovery snapshot
refuse replacement and preserve the originals. A pinned recovery base still
merges newer snapshot history.
