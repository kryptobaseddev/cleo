---
id: t12943-release-status-absorbing
tasks: [T12943]
kind: feat
summary: "Sync merges never move a shipped release back to an earlier status"
---

When two devices sync release records, a release that one device committed,
tagged, pushed, published, reconciled or rolled back keeps that status: a later
re-plan of the same version on another device (which writes `planned`) no
longer regresses it. A release's status and its timestamps travel together,
so they always agree. Moves among the shipped statuses resolve by the newest
write.
