---
id: t13106-reads-record-no-token-usage
tasks: [T13106]
kind: fix
summary: Dispatch token telemetry no longer writes a token_usage row when a command only reads
---

After every successful dispatch, `cleo` recorded the command's token cost in `token_usage`, reads
included. `token_usage` is portable-personal (cost history that syncs, journal spec Q9), so a read
such as `cleo show` added a synced row. On a freshly restored device, `cleo cloud verify` then turned
from `match` to `ahead` (found by the T12340 two-device test).

Token cost is now recorded for mutations only. A mutation changes synced state anyway, so its cost
row travels with that change. A query, or any other gateway, records nothing. `token_usage` stays
portable.

This fix covers token usage only:

- Read cost is no longer recorded for now. T13114 brings it back through a device-local ledger that
  folds into `token_usage` at push.
- Memory reads (`cleo memory find` / `fetch`, and the brain search in briefing and focus) still change
  synced brain rows (citation counters, the retrieval log), so `cloud verify` can still turn `ahead`
  after them. That is tracked as T13113.
- `cleo list` and `cleo find` never recorded a token row: they go through a dispatch path without the
  recorder.
- Token rows that name a bound session are lost to a foreign-key mismatch, fixed by T13111.
