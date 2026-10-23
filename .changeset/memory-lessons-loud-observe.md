---
id: memory-lessons-loud-observe
tasks: [T13949]
kind: feat
summary: lessons are a memory kind with a curated `cleo memory lessons` index, and `cleo memory observe` now exits non-zero when nothing is stored
---

A lesson is an observation of type `lesson`: `--title` is the one-line rule
and the text is why (the incident). `cleo memory observe "<why>" --type lesson
--title "<rule>"` refuses a missing, multi-line or overlong rule, and defaults
to `--scope global` (the main brain) because process lessons are
cross-project. `cleo memory lessons [--scope project|global|all] [--limit N]`
lists current lessons newest first; an invalidated (superseded) lesson is
hidden.

**Behaviour change:** `cleo memory observe` now fails with
`E_OBSERVE_NOT_STORED` (non-zero exit) when the extraction gate stores
nothing: a duplicate merged into an existing entry (the message names it), or
a deferred or rejected write. It used to succeed and return the existing id,
so scripts could not tell a new memory from a duplicate. Scripts that observe
the same text repeatedly should treat this code as "already known".
Internal writers (hooks, diary, dream and hygiene passes) are unchanged.
