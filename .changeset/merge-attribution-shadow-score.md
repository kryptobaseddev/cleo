---
id: merge-attribution-shadow-score
tasks: [T14256]
kind: feat
summary: "scoreMergeAttributions scores shadow merge-attribution receipts against the current closure path: the decidable share against the 80% bar, every missing receipt and disagreement, and any receipt that would close a failure new at the merge"
---

The Phase 3 deletions wait on this score (D11224). They unblock only when at
least 80% of the scored PRs have a decidable receipt and no receipt would
close a failure that is new at the merge. "Would close" is judged from the
receipt's claim (plus a T14255 resolution or a D11225 budget crossing), never
from its failures, so a receipt that claims to hold while carrying a
`pr-caused` failure is caught and blocks. `claimOf` is the one mapping from a
verdict to its claim.
