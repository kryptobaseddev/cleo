---
id: orca-stop-reserved-key
tasks: [T14493]
kind: fix
summary: "Orca execution: a stop whose reply was lost is settled by its reserved key instead of blocking retry forever"
---

A stop reserved `stop_pending` before the send and learned its request id only
from the reply. When that reply was lost without an issued id, the record kept
`stop_pending` with `stopRequestId: null`: `worker-show` left it untouched,
`recover-stop` required an id that never existed, and `retry` accepts only a
resource-free `failed` or `stopped` predecessor. Custody was held with no
remaining path forward.

The stop key is now reserved and persisted in the same write as `stop_pending`
and sent as `--retry-request` on the first attempt, exactly like a retry key.
Every replay reuses that key, so Orca atomically refuses a second cancellation
even when the original receipt was pruned; a replay is never an unkeyed guess.

`worker-show` also settles the reservation: exact exited and released resource
proof moves a `stop_pending` or `stop_unknown` record to `stopped`, and anything
less moves it to `stop_unknown` rather than leaving it pending. A retry then
proceeds on the release proof, or refuses naming `cleo orchestrate worker show`
and `cleo orchestrate worker recover-stop` for the exact record.
