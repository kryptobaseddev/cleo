---
id: t11997-atomic-writes-repair
tasks: [T11997]
kind: fix
summary: "atomic JSON config writes + attachment blob tmp-rename ordering + repair routine"
---

Closes the crash-safety gaps identified in T11992 investigation E.

**Config writes — `packages/core/src/config/registry.ts` and `packages/core/src/config.ts`:**

- `registry.ts` `unsetConfigValue`: replaced bare `writeFile` (line 429) with `atomicWriteJson` from `store/atomic.ts`. A kill mid-write can no longer truncate the live config.
- `config.ts` `setConfigValue` and `applyStrictnessPreset`: replaced bare `writeFile(configPath, '{}')` bootstrap calls (lines 392, 491) with `atomicWriteJson`. Both functions already delegated subsequent writes to `saveJson` (which uses `atomicWriteJson` internally); the bootstrap was the only remaining bare write.
- Removed now-unused `mkdir` and `writeFile` imports from both files; added `atomicWriteJson` import from `./store/atomic.js`.

**Attachment store — `packages/core/src/store/attachment-store.ts`:**

- Reordered the `put` method: blob bytes are now written via tmp+rename **before** the SQLite `COMMIT` (previously after). If the file write fails, the transaction rolls back and no orphan row is created. If a crash occurs after the rename but before `COMMIT`, the file exists without a row — the safe direction (unreferenced blob on disk is harmless; row pointing to missing file is not).
- The temp file is cleaned up on write failure so no `.tmp` artifact survives at the final path.

**New files:**

- `packages/core/src/store/attachment-repair.ts`: exported `repairAttachmentStore(opts)` — callable library function with `dryRun` mode and structured `RepairResult`. Scans for (1) rows-without-files (marks row `lifecycleStatus='archived'`, appends audit JSONL — never drops metadata, per Amendment 2) and (2) files-without-rows (checks all three doc storage surfaces before declaring unreferenced per Amendment 3; applies grace period; deletes eligible blobs). Silent by default — no console output.
- `packages/core/src/config/config-repair.ts`: exported `repairConfigFile(configPath, backupDir, cwd)` — per Amendment 1: never silently restores a stale backup; quarantines corrupt file first; picks newest valid candidate (surviving `.tmp` > numbered backups); skips restore when `.tmp` is very new (active write window). Appends structured audit record to `.cleo/audit/config-repair.jsonl`.
- `packages/core/src/store/__tests__/t11997-crash-safety.test.ts`: fault-injected kill-mid-write tests for all four amendments.

**Amendments satisfied:**

1. Config restore safety: quarantine first, pick newest valid candidate, skip active-write window.
2. Attachment repair mark-not-drop: row marked `archived` with `[repair:missing-blob]` summary prefix.
3. Unreferenced-blob sweep: consults all three surfaces (attachments index.db, blobs manifest.db, docs-publications.json) before deleting.
4. Repair as callable library with dry-run, structured result, silent by default.
