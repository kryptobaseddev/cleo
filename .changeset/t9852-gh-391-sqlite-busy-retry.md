---
id: t9852-gh-391-sqlite-busy-retry
tasks: [T9852, T9839]
kind: fix
summary: "SQLITE_BUSY retry on parallel task writes (CORE SDK with-retry primitive)"
prs: [413]
---

Closes #391. Extracts isSqliteBusy + new withWriteRetry helper into shared core/store/with-retry.ts. Wraps 8 BEGIN IMMEDIATE call sites in sqlite-data-accessor.ts (saveArchive, upsertSingleTask, addRelation, removeRelation, archiveSingleTask, removeSingleTask, updateTaskFields, appendLog) with 4-attempt 100/200/400/800ms +/- 50ms jitter backoff. New E_WRITE_CONTENTION exit code distinct from E_VALIDATION.
