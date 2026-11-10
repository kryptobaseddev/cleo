---
id: review-dispatch-secret
tasks: [T14403]
kind: fix
summary: "A dispatched reviewer's verdict needs its per-dispatch secret, not just the session id audit rows expose; review.workers.counted is owner-only and sealed"
---

Session ids are readable from audit rows, so `CLEO_SESSION_ID=<dispatch
session>` could record a verdict as that reviewer.

- `cleo review dispatch --execute` mints a secret per dispatch, stores only its
  SHA-256 in the `review.dispatch` row (`reviewerSecretSha256`), and writes the
  secret to a 0600 file under `.cleo/review-secrets/`. The envelope returns only
  the path (`reviewerSecretFile`), so the secret stays out of the dispatcher's
  transcript, argv, audit rows and logs. The reviewer runs with
  `CLEO_REVIEW_SECRET_FILE=<path>` (or a spawner sets `CLEO_REVIEW_SECRET`).
- `cleo review verdict` under a dispatch is refused without the secret or with
  a wrong one, compared in constant time.
- `review.workers.counted` is owner-only, sealed like
  `evidence.overrideCapPerSession`: `cleo config set review.workers.counted
  true` succeeds only for the owner (owner-auth session, TTY, enrolled key), is
  sealed in `.cleo/owner-settings.json` rather than config.json, and every set
  or refusal is audited in `.cleo/audit/force-bypass.jsonl` with the session
  and agent id. An agent session's set is refused.
- Limit: an author running as the same OS user can still read the secret file
  or a process environment. The secret raises the bar; it does not isolate.
