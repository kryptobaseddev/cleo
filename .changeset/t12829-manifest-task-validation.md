---
id: t12829-manifest-task-validation
tasks: [T12829]
kind: fix
summary: "cleo manifest append validates linked task ids (format and existence), entry ids and file references, so no input names a path outside the project; manifest show refuses malformed ids and unsafe stored file references; cleo doctor manifest-rows reports existing rows with bad identities (security hardening)"
---

`cleo manifest append` stored any value it was given. `--task T99999` was
accepted although no such task existed. A 900-character JSON blob became the
entry id and part of the `file` reference, and `cleo manifest show` then failed
with ENAMETOOLONG.

Security hardening: `--task ../../../x`, or an `--entry` with
`"file":"../secret.txt"`, was stored. `cleo manifest show` then read that file
from outside the project and returned its contents. Append never wrote to the
path, so this was a read traversal (file disclosure), not a write.

- Append (the shorthand `--task` form and full `--entry`/`--file`/stdin
  entries) now rejects the following with `E_VALIDATION`, exit 6:
  - a linked task id that is not a task id. Canonical `T<digits>` ids are
    accepted, and so are the structured `T…` ids CLEO mints.
  - an entry id that has a path separator, whitespace or control character,
    or is longer than 200 characters.
  - a `file` reference that resolves outside the project or has a path
    segment longer than 255 bytes.
- The CLI path rejects a well-formed task id that names no task with
  `E_NOT_FOUND`, exit 4. Direct SDK callers can turn this check on with
  `requireExistingTasks`.
- `manifest show` (and `research show`) refuses a malformed id with
  `E_VALIDATION` before any lookup. It never reads a stored file reference that
  escapes the project, and fails with `E_MANIFEST_FILE_UNSAFE` instead.
- `cleo doctor manifest-rows` is read-only and now also lists `identity`
  problems in existing rows. These are rows with a bad id, a bad linked task
  id, an unsafe file reference, or a missing linked task. It exits non-zero on
  malformed or unsafe values. A missing task alone is only a warning.
