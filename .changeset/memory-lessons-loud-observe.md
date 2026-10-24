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
`E_OBSERVE_NOT_STORED` (exit code 110) when nothing is stored: the extraction
gate merged a duplicate into an existing entry, or deferred or rejected the
write. `error.details.id` names the existing entry, so a script can treat the
code as "already known" and keep that id. It used to succeed and return the
existing id, so scripts could not tell a new memory from a duplicate. The main
brain (`--scope global`) now refuses a duplicate the same way; it used to store
the same text twice.

Callers updated for this: `cleo memory import` skips an entry already in BRAIN
(reported as skipped, not imported, and the import no longer stops at the first
failing entry), and release reconcile reads the existing entry's id from the
refusal. Internal writers that call core directly (hooks, diary, dream,
hygiene, pivot) are unaffected.
