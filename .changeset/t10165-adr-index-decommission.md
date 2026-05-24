---
id: t10165-adr-index-decommission
tasks: [T10165]
kind: feat
summary: backfill adr-index.jsonl into attachments + freeze JSONL writer (T10165 / Saga T9855)
---

Backfill the historical .cleo/adrs/adr-index.jsonl portability export into the attachments table provenance columns shipped by T10158. New manual migration script populates lifecycle_status / supersedes / superseded_by / summary / keywords / topics / related_tasks on a per-ADR row, with two-pass FK resolution and idempotent re-runs. syncAdrsToDb no longer regenerates the JSONL — the file is preserved with a # DEPRECATED header for one deprecation cycle. CI gate lint-adr-index-jsonl-frozen.mjs fails with E_ADR_INDEX_JSONL_FROZEN on newly-appended data lines.
