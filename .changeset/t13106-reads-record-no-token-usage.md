---
id: t13106-reads-record-no-token-usage
tasks: [T13106]
kind: fix
summary: Read-only commands no longer write a token_usage row, so cloud verify stays "match" after a read
---

After every successful dispatch, `cleo` recorded the command's token cost in `token_usage`, reads
included. `token_usage` is portable-personal (cost history that syncs, journal spec Q9), so a read such
as `cleo show` changed the store's synced content. On a freshly restored device, `cleo cloud verify`
then turned from `match` to `ahead` (found by the T12340 two-device test).

Token cost is now recorded for mutations only. A mutation changes synced state anyway, so its cost row
travels with that change. A query, or any other gateway, records nothing. `token_usage` stays portable:
moving it to local-only would contradict the Q9 ruling.

`cleo list` and `cleo find` never recorded a row, because they go through a dispatch path without the
recorder. Token rows that name a bound session are lost to a foreign-key mismatch, which is tracked
separately as T13111.
