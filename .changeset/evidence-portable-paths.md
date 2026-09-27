---
id: evidence-portable-paths
tasks: [T12476]
kind: fix
summary: evidence atoms pin the hashed file (cwd-independent re-validation) and rebase moved paths through recorded project roots; fleet and scan roots come from the registry instead of /mnt/projects
---

**Evidence named a file by where `cleo complete` happened to run.** A
relative `files:` or `test-run:` path was re-resolved against the completing
process's tree, so verifying from one checkout and completing from another
could hash a different copy of the file. An absolute path recorded on one
device reported "File removed since verify" after the project moved.

New atoms keep `path` exactly as supplied, byte for byte, because consumers
match it against repo-relative PR paths. They also record `resolvedPath`,
which is the absolute file that was hashed. Re-validation reads that file
whatever directory it runs from, so tampering with the attested copy is
caught, and an untouched copy elsewhere cannot stand in for it. When the
bytes came from git rather than disk, no `resolvedPath` is recorded and the
git lookups behave as before. Atoms recorded before this change also
re-validate as before.

A move is handled only at re-validation, when the absolute path is gone.
The path is rebased onto the live root only through a recorded checkout
root of this project (`nexus_project_paths`) that no longer exists and does
not nest with the live root. There is no tail matching, so a file that moved
or vanished inside a project that did not move is reported removed. Paths
with `.`/`..` segments are refused, separators are the platform's own (a
backslash is a file-name character on POSIX), and the rebased realpath must
stay inside the live root. The sha256 captured at verify time still decides.

**Defaults named one past device.** `cleo doctor db-substrate --fleet`
defaulted to `/mnt/projects`, and `cleo nexus projects scan` to
`~/code,~/projects,/mnt/projects`. Both now default to the parent directories
of the projects registered on this device. When the registry yields none, the
fleet survey uses the current project's parent and the scan uses `~/code` and
`~/projects`. `surveyFleetDbSubstrate` accepts several roots and surveys a
project reachable from two of them once. The Studio scan dialog now defaults
to blank, which lets the server derive the roots.
