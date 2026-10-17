---
id: t13816-format-transition-cap
tasks: [T13816]
kind: fix
summary: the first push over a format-2 parent prunes only the local rows in that parent's own snapshot, so a lost synced row is refused instead of hidden
---

The first checkpoint over a vault parent of format 2 names the local rows that
parent counted as `pruned`. It capped them by the local rows this store held at
push time, so every local row here that the parent never held hid one lost
synced row: a parent of 98 synced and 2 local rows, then 95 synced and 5 local,
pushed with nothing unexplained. The same happened when another device pushed
the parent. The cap is now the local rows in the parent's own `cleo.db`, read
from its snapshot once, exact whoever pushed it and with no clock. That push is
now refused, and the message names the format-2 head and the two ways out:
`cleo cloud pull --force` to take the cloud copy, or `cleo cloud push --force` to keep this store as a
labelled fork.
