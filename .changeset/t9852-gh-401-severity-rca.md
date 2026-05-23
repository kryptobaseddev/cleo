---
id: t9852-gh-401-severity-rca
tasks: [T9852, T9839]
kind: fix
summary: "RCA + persist severity/kind/scope on task UPDATE"
prs: [425]
---

Closes #401. RCA: bug was write-side defect in upsertTask onConflictDoUpdate({set}) — kind/scope/severity columns were enumerated for INSERT but not UPDATE, so cleo add --severity P0 worked but cleo update silently dropped them. Three layers of success signal with no DB write. Fix: added the 3 columns to the set object in db-helpers.ts + load-bearing comment for future additions.
