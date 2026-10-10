---
id: t13375-seal-merge-marker
tasks: [T13375]
kind: fix
summary: cleo exodus seal merges into an existing completion marker instead of rebuilding it
---

Re-sealing a scope rewrote its exodus completion marker from scratch, dropping the cutover's databaseIdentity, targetDbPath, completedAt and cleoVersion (and, before #1986, its verifyIssues). Without databaseIdentity, the on-open check that certifies the marker against the opened database refuses with "does not certify this database generation". Seal now keeps every field of an existing version-1 marker for its scope, including fields it does not know, and adds the sources it archived to archivedSources; a missing or unreadable marker is written fresh as before.
