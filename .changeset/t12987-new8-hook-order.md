---
id: t12987-new8-hook-order
tasks: [T12987]
kind: feat
summary: "Sync journal S3d: before the first pending migration, the open seals pending captures and runs the repair diff for every suspect table, then takes the chash snapshot (NEW-8), so a re-baseline never hides an earlier uncaptured write."
---
