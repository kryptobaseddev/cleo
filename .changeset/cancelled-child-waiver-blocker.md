---
id: cancelled-child-waiver-blocker
tasks: [T14426]
kind: fix
summary: "done --plan reports an epic's un-waived cancelled child as its own cancelled-child-waiver blocker, not epic-rollup"
---

`cleo done <epic> --plan` labelled a cancelled child that still needs its
audited `--waive-cancelled-children "<reason>"` as an `epic-rollup` blocker,
although the rollup already counts a cancelled child as settled (T14266). The
waiver is still required, through the same guard `cleo complete` applies; it
is now reported under its own `cancelled-child-waiver` code, so `epic-rollup`
means only an unfinished child or an unbound epic criterion. The release
real-store smoke now asserts both: no `epic-rollup` blocker, and the
`cancelled-child-waiver` blocker present.
