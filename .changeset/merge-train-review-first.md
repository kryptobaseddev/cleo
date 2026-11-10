---
id: merge-train-review-first
tasks: [T14389]
kind: fix
summary: "cleo merge train judges review state before an infra rerun: an unreviewed head gets at most one rerun, a review-ready head up to 3"
---

The train read `cleo review check` only after CI went green, so it spent
saturated runner slots rerunning infra reds on PRs that could not merge yet.
It now judges the review first. Each decision carries a `review` field
(`ready` or `gaps: ...`) and its reason starts with the review state. A head
whose review check has gaps gets at most one infra rerun
(`MERGE_TRAIN_MAX_UNREVIEWED_RERUNS`); once reviewed, the same head gets the
rest of the 3-rerun budget.
