---
id: merge-sweep-followups
tasks: [T14139]
kind: fix
summary: "Merge sweep: age-out skips a task already done elsewhere; the sweep lock re-checks it holds its own token"
---

Two follow-ups from the review of the merge sweep (T14101):

- A PR that waited 14 days was refused with a final "waited 14 days"
  comment even when its task had meanwhile been completed by another route.
  The age-out now reports such a task as `already`, with no refusal and no
  comment.
- After creating (or stealing) the sweep lock, the sweep re-reads the lock
  file and runs only if it still holds its own token, closing a three-party
  race on a stale lock. Release likewise removes the lock only when it is
  still ours.
