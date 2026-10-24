---
id: briefing-lessons-index
tasks: [T13949]
kind: feat
summary: "`cleo briefing` lists current lessons as one-line rules; the injection tells agents to record rules as `--type lesson`"
---

The briefing now carries a `lessons` index: up to eight current lessons from the
project and global brains, newest first, each with its rule, scope, date and a
`cleo memory fetch <id>` pointer for the why. The key is left out when there are
no lessons, and a failed read becomes a briefing warning instead of an error.
The injection's Learn step tells agents to record rules with `--type lesson`.
