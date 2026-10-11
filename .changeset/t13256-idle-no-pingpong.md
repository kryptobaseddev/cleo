---
id: t13256-idle-no-pingpong
tasks: [T13256]
kind: test
summary: "Two idle replicas syncing in a loop exchange no segments after the first round (journal spec §3.5 R7-7)"
---

A new two-device test runs on the fake server. Device B joins the journal device A started, and each device makes one real
write. One round of `cleo cloud sync` carries both writes across. Then four more rounds with no writes run on each device.

- No device sends a segment in those rounds, and the stream's segment count does not move.
- Applying the other device's segment never makes a device seal or send one back: the apply's echo is subtracted (§3.3).
- Both stores end with the same rows.

This test guards the R7-7 rule for when receive watermarks land: a watermark rides on an ordinary segment and is never sent
alone after a pull.
