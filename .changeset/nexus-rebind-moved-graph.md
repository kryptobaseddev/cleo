---
id: nexus-rebind-moved-graph
tasks: [T12659]
kind: fix
summary: A moved project's nexus graph no longer dead-ends. `cleo nexus analyze <root> --full` re-binds it to the live root when the project id matches, with a receipt, and every ownership error names the exact remedy
---

A graph recorded under an old root, for example axiom-app's `/mnt/projects/...`
after a Linux to Mac move, could not be repaired. `knowledge.ts` failed with
"Recorded source ownership differs…", and `doctor knowledge` proposed
`nexus.analyze`. The analyze orchestrator then refused ("Stored graph ownership
differs…") before it looked at `--full`. T12474 rebases legacy absolute
records whose paths are consistent. Any record it cannot rebase, such as a
record whose root was a symlink onto a data disk, or a project re-rooted from
a parent into its child, had no remedy.

- `cleo nexus analyze <root> --full` re-binds the stored graph to the live
  root, when the stored project id equals the live `projectId` from
  project-info. A path-derived projectHash never qualifies. It rebuilds the
  graph and returns a `rebind` receipt with the old root, new root, project
  id and published generation.
- An included repository that is missing on disk refuses and keeps the
  previous graph. That covers a re-rooted project, an unmounted volume and a
  sub-repo in the middle of a re-clone, and it applies even on `--full` and
  on a re-bind. The refusal names the missing paths and the exact command.
  Missing inclusions are dropped only with the new
  `--drop-missing-repositories` flag. They are then reported in human output
  (a warning) and in JSON (`droppedRepositories`), with a one-command restore
  (`--include-repositories`).
- A different project id still refuses, even with `--full`, and the previous
  graph is kept. Every refusal names the recorded and live root and id and
  one exact command: `cleo nexus analyze '<live root>' --full` for a moved
  project, `cleo doctor project-identity` for a foreign id. Paths are quoted
  for the host shell: single quotes on POSIX, and plain double quotes on
  Windows.
- Knowledge coverage sets `nextAction` to that command, and the
  `graph-coverage` finding in `doctor knowledge` proposes it
  (`nexus.analyze` with `full: true`, "Run exactly: …"). Running the command
  clears the finding.
