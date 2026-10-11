---
id: t13336-sync-mode-off
tasks: [T13336, T12753]
kind: fix
summary: "Sync: only canonical store opens run the sync open pass; copies, backups and exodus handles stay off"
---

Every chokepoint open used to run the capture open pass, and nothing ran the replica bind (journal spec §1.5,
T13336). Now each open has a sync mode:

- **`live`:** a canonical, non-dedicated open (`<root>/.cleo/cleo.db`, or `<cleoHome>/cleo.db` for the global store).
  Capture triggers match `sync.capture`, and once any `sync.*` flag is on the store is bound to its replica. A copy at
  another canonical path rebinds.
- **`off`:** every dedicated handle (exodus migrate, on-open rollback and seal, reconcile scratch) and every other
  path, plus the real-store Gate B opener. No capture trigger is installed, verified or dropped, and the store is
  never bound or rebound.

Backups, snapshots, bundle staging and credential-transfer handles open raw files, never through the chokepoint, so
no open pass runs on them. A test pins every one of these paths.
