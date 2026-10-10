---
id: t13447-docs-doctor
tasks: [T13447]
kind: feat
summary: cleo docs doctor — docs store health diagnostics (dangling local-file pointers, docVersion skew, empty provenance, wikilinks drift, legacy surfaces, stale drafts) with backup-gated repairs.
---

`runDocsDoctor` in `@cleocode/core/docs/doctor` audits the CleoDocs store for six drift classes and, with `--apply`, repairs the ones that are safe in place: docVersion is restored from the audit log (revisions + 1, the T13351 semantics), topics/related_tasks are backfilled via the T13357 derive-links rules, missing local-file rows are archived, and docs_wikilinks is fully re-derived. Repairs refuse to run without a backup receipt younger than 10 minutes; the `docs.doctor` dispatch handler creates that backup itself through the same `createBackup` core function `cleo backup add` uses, so `cleo docs doctor --apply` is one safe command. Dry-run is the default and writes nothing.
