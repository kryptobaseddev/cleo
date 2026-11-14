---
'@cleocode/core': patch
'@cleocode/cleo': patch
---

Fix store repair for the full CLEO schema by rebuilding contentless FTS5 from canonical sources, waiting briefly for CLEO teardown, and naming persistent store holders with a shutdown fix.
