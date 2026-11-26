---
id: docs-doctor-archive-ambiguous
tasks: [T14634]
kind: fix
summary: "docs doctor archive-publication audits only after the import commits and refuses an archive target two docs share"
---

- **Audit after commit.** The `archive-publication` audit line is written only
  after the conduit import commits, so a failed import leaves no record of a
  write that never happened. If the append itself fails, the archive stays in the
  report, a `W_DOCS_DOCTOR_ARCHIVE_AUDIT_FAILED` warning names it, and the
  remaining archives and prunes still run.
- **Ambiguous targets are refused.** When two or more live docs share the head the
  stream publishes, the finding stays `republish-or-prune`, names every doc, and
  says to supersede the duplicates with `cleo docs supersede <duplicate> <kept>`.
  A superseded doc is no longer an archive target, so the next `--apply` archives
  the blob into the kept doc.
