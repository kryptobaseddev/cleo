---
id: t13193-pages
tasks: [T13193, T13274]
kind: feat
summary: Sync apply runs in pages - one frame and one scoped rebase per page of staged transactions
---

This is the second part of the fourth slice of the scoped rebase (T13193 R-4c), against journal spec §3.5 Rule 3 (R6-4).

- **Pages.** Staged transactions now apply in pages. Each page is one apply frame with one scoped rebase:
  1. rewind the page's scope once;
  2. apply its transactions in stream order, each in its own Gate C savepoint, so a post-apply void rolls back only that transaction;
  3. replay once.

  Before this, every transaction rewound and replayed the whole local scope again.
- **Page bounds.** A page holds up to `REBASE_PAGE_OPS` (2,000) ops and stops taking transactions after `REBASE_PAGE_MS` (50 ms).
  Both are overridable through `pageOps` and `pageMs`.
  - A page breaks only between transactions. A split transaction is one staged unit, so its part-set stays whole.
  - A page also breaks on an actor change, because one apply frame records one actor.
  - A transaction larger than a page is a page alone (the declared exemption).
- **Own echoes in a page.** A rewound local transaction whose echo is in the page is applied at its stream position and sequenced there.
  Every other rewound local transaction is replayed at the end of the page. The own-echo fast path is judged once per page.
- **Natural twins.** A local insert that the stream also made is now rewound to the stream's row instead of being deleted, so a later
  stream update of that row applies (D2).
- **Composite UNIQUE keys (T13274).** An update that sets part of a composite UNIQUE key fills the rest of the key from the current row
  for its footprint pseudo-row.
