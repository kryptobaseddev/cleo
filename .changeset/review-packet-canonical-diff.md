---
id: review-packet-canonical-diff
tasks: [T14325]
kind: fix
summary: "the review packet sha no longer flaps: blob ids are dropped from the diff's index lines before hashing"
---

`gh pr diff` abbreviates the blob ids on a diff's `index <a>..<b>` lines to a
length that varies between calls (10 characters on one, 9 on the next), so
`cleo review packet` returned a different `packetSha256` for the same head and
`cleo review verdict` refused about half the time with `E_CLEO_CONTEXT_STALE`.
The packet now drops those ids (`index <mode>` stays) before it hashes or
shows the diff, so one head always yields one packet.
