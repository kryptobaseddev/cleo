---
id: t13463-review-lows
tasks: [T13463]
kind: fix
summary: a research or spike task's own-branch PR still implements it ahead of its review doc, and checkout-required names the merge it switches to and offers ci:<pr> only when evidence.ciSatisfies is set
---

Follow-ups from the reviews of T13428 and T13429:

- **Research and spike tasks.** The review document comes first only when no
  merged PR came from the task's own branch (`task/<id>` or `task/<id>-…`). A
  PR merged from that branch implements the task, so its change set is used.
  A PR that merely cites the task still yields to the review document.
- **`checkout-required`:**
  - The message says `ci:<pr>` needs no local run only when
    `evidence.ciSatisfies` is set; otherwise it says that setting it would let
    merged CI stand in.
  - When the missing commit is an earlier PR's, the message names the latest
    merge the command switches to.
