---
id: review-author-release
tasks: [T14213]
kind: fix
summary: "a task's author stays an author after its claim is released or refocused, so cleo review verdict keeps refusing them; session start --agent sets the agent identifier"
---

`reviewAuthors` read only the current claim and the hand-off, force and
take-over rows. A fresh claim and the holder's own release (`cleo stop`, or
`cleo start` on another task in the same session) logged nothing, so once a
claim was released the task had "no recorded author" and review independence
fell back to whoever held the claim now.

The task store now logs `task_claimed` on a fresh claim and
`task_claim_released` on the holder's own release, and review authorship
reads them along with the hand-off, take-over and forced-release rows. A
forced release's releaser is not counted as an author.

`cleo session start --agent <id>` now sets the session's agent identifier;
`CLEO_AGENT_ID` is the fallback when no `--agent` is given.
