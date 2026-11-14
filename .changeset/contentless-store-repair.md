---
id: contentless-store-repair
tasks: [T14558]
kind: fix
summary: "Store repair: rebuild contentless FTS and wait for CLEO teardown"
---

Fix store repair for the full CLEO schema by rebuilding contentless FTS5 from canonical sources, waiting briefly for CLEO teardown, and naming persistent store holders with a shutdown fix.
