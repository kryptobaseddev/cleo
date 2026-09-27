---
id: evidence-portable-paths
tasks: [T12476]
kind: fix
summary: evidence atoms store project-relative paths and legacy absolute atoms re-validate after a move; fleet and scan roots come from the registry instead of /mnt/projects
---

**Evidence survived nothing that moved.** `files:` and `test-run:` atoms kept
the path exactly as typed, so an absolute path recorded on one device made
`cleo complete` report "File removed since verify" on the next, for a file
that was present and byte-identical under the new root.

Each atom kind re-validates a relative path against exactly one root:
`files:` against the execution root, and `test-run:` against the store root.
New atoms are relativised only against that root. For `files:`, this happens
only when the execution root is the store root. In a worktree layout, an
absolute path stays absolute, so re-validation hashes the recorded file and
never an identical copy in the other tree. A path outside that root stays
absolute. Relative input is kept verbatim.

A legacy absolute atom whose path no longer exists is rebased onto the live
root only when the project root it was recorded under is itself gone. The
rebase goes through a vanished recorded checkout root of this project
(`nexus_project_paths`), or through the longest tail of at least two
segments. Paths with `.`/`..` segments are refused, and so is a rebased file
whose realpath escapes the live root. A file deleted from a project that did
not move is reported removed, never re-pointed. Rebasing only chooses which
bytes to hash: the sha256 captured at verify time still decides.

**Defaults named one past device.** `cleo doctor db-substrate --fleet`
defaulted to `/mnt/projects`, and `cleo nexus projects scan` to
`~/code,~/projects,/mnt/projects`. Both now default to the parent directories
of the projects registered on this device. When the registry yields none, the
fleet survey uses the current project's parent and the scan uses `~/code` and
`~/projects`. `surveyFleetDbSubstrate` accepts several roots and surveys a
project reachable from two of them once. The Studio scan dialog now defaults
to blank, which lets the server derive the roots.
