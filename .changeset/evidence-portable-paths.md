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

New atoms persist the path relative to the root it was found under (the
execution root first, then the store root). A report outside every project
root, such as one in the system temp directory, stays absolute. For a legacy
absolute atom whose path no longer exists, re-validation looks up the path
under the live root. It uses the position under a recorded former checkout
root of this project (`nexus_project_paths`) when there is one. Otherwise it
uses the longest tail of the path that exists under the live root. Rebasing
only chooses which bytes to hash: the sha256 captured at verify time still
decides, so a rebased file that changed fails exactly as a modified file does.
Relative `test-run:` atoms now re-validate against the execution root before
the store root, matching the order validation already used.

**Defaults named one past device.** `cleo doctor db-substrate --fleet`
defaulted to `/mnt/projects`, and `cleo nexus projects scan` to
`~/code,~/projects,/mnt/projects`. Both now default to the parent directories
of the projects registered on this device. When the registry yields none, the
fleet survey uses the current project's parent and the scan uses `~/code` and
`~/projects`. `surveyFleetDbSubstrate` accepts several roots and surveys a
project reachable from two of them once. The Studio scan dialog now defaults
to blank, which lets the server derive the roots.
