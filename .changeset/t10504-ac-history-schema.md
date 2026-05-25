---
id: t10504-ac-history-schema
tasks: [T10504]
kind: feat
summary: "schema: task_acceptance_criteria_history retention table (T10381 Wave 2a)"
---

Add the dedicated 5-column `task_acceptance_criteria_history` retention table per T10494 decision D013. Append-only log of AC text changes with INTEGER AUTOINCREMENT PK, intentional no-FK on `ac_id` (history must outlive AC deletion for drift forensics), and `(ac_id, recorded_at DESC)` covering index for the dominant 'latest drift event first' query. Drizzle schema in `packages/core/src/store/schema/tasks.ts` + hand-authored migration at `packages/core/migrations/drizzle-tasks/20260524000004_t10504-ac-history/` (timestamp ends in 04 to order cleanly after sibling T10502 and T10503). Independent of attachments / docs_provenance — see research doc `ac-history-model-decision` for the rejected-alternatives analysis.
