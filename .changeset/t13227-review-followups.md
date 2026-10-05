---
id: t13227-review-followups
tasks: [T13221, T12998]
kind: fix
summary: cleo doctor also finds hand-written CLEO safestop hooks and says "no matcher" when an entry has none; cloud status counts this replica's folded transactions in the last sealed seq
---

- `cleo doctor` (`user_global_claude_leftovers`) now also finds an unmarked
  `precompact-safestop.sh` hook written in the forms CLEO's own hook template suggests:
  `~/…`, `$HOME/…`, `${HOME}/…`, or a single-quoted path. When the entry holding a
  leftover hook has no `matcher` key, the manual step now says "(no matcher)" instead
  of `(matcher "")`.
- In `cleo cloud status`, a store's `lastSealedSeq` now counts this replica's `folded`
  transactions. Those are its own history below a genesis cut. Transactions
  `inherited` from a copied store's original replica are still excluded. The docs for
  the read-only snapshot now say that it may create empty `-wal`/`-shm` sidecars when
  the store's directory is writable; the store file itself is never modified.
