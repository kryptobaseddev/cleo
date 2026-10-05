---
id: t13188-ancestry-null-start
tasks: [T13188]
kind: fix
summary: A run nested under an admitted run whose start time was never recorded rides its admission only with the holder's token
---

Admission re-entrancy accepts a run as nested in an admitted run when the holder is one
of its ancestors and the holder's recorded process start time matches. When `ps` failed
at admission, no start time is recorded, and that check was skipped: a dead holder's pid
recycled into a newcomer's ancestry let the newcomer ride a grant that no longer existed
until the entry was reaped (up to 10 minutes). Such a holder now proves nesting by
ancestry only together with its `CLEO_ADMISSION` token, as group membership already did.
A known start time that differs still rules the holder out.
The trade-off: a run nested under such a holder by a wrapper that scrubs the environment
(dropping the token) can no longer prove nesting, so it waits for its own parent until it
times out or the entry is reaped as unidentifiable. That needs `ps` to have failed at
admission, which is rare.
