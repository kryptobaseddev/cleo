---
id: t13816-format-transition-cap
tasks: [T13816]
kind: fix
summary: the first push over a format-2 parent prunes only the local rows that parent counted, so a lost synced row is refused instead of hidden
---

The first checkpoint over a vault parent of format 2 names the local rows that
parent counted as `pruned`. It capped them by the local rows the store held at
push time, so every local row written since the parent hid one lost synced row:
a parent of 98 synced and 2 local rows, then 95 synced and 5 local, pushed with
nothing unexplained. The cap is now the local rows stamped at or before the
parent's `createdAt` (`created_at`, or `classified_at` for release changes), so
that push is refused with the 3 missing rows named.
