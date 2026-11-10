---
id: review-dispatch-secret
tasks: [T14403]
kind: fix
summary: "A dispatched reviewer's verdict needs the per-dispatch secret, not just the dispatch's session id, which audit rows expose"
---

Session ids are readable from audit rows, so `CLEO_SESSION_ID=<dispatch
session>` could record a verdict as that reviewer.

- `cleo review dispatch --execute` mints a secret per dispatch, stores only its
  SHA-256 in the `review.dispatch` row (`reviewerSecretSha256`), and returns
  the secret once as `reviewerSecret`. The dispatcher hands it to the reviewer
  process only in `CLEO_REVIEW_SECRET`; the brief never carries it.
- `cleo review verdict` under a dispatch is refused without the secret or with
  a wrong one, compared in constant time. The secret is never written to an
  audit row or a log.
