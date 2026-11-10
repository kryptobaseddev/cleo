---
id: orca-plugin-task-panel
tasks: [T14462]
kind: feat
summary: "an Orca plugin (packages/adapters/orca-plugin) shows a workspace's CLEO epics, tasks, acceptance, evidence and worker claim in a read-only sidebar panel"
---

First slice of the CLEO and Orca integration (spec `cleo-orca-integration`, D11242): a manifest
format 2 plugin with one components panel (**CLEO Tasks**), one trusted Node worker and one
palette command (**CLEO: Refresh Tasks**). It only reads.

- **Reads.** The worker starts one `cleo` process per read, without a shell, from three fixed
  commands (`list --type epic`, `list --parent <id>`, `show <id> --full`), each bounded to 20
  seconds, 4 MiB of output and 50 rows. Stdout must be one LAFS envelope. It never opens
  `.cleo/*.db` and never passes an agent identity to the read.
- **Workspace choice.** Nothing is read until a workspace is picked. The choice is Orca's
  workspace id plus host and path, re-checked against Orca's list before every read. Remote
  workspaces are listed but cannot be chosen, and a focus that matches several workspaces
  chooses none.
- **Access.** Execution profile `trusted-worker` and the single capability `workspace:read`.
  Loading it into Orca needs the owner's approval of that access; nothing here loads it.
- **Stored.** Only the workspace choice and the status filter. Tasks are re-read from CLEO.

The plugin folder is not part of the `@cleocode/adapters` npm package. See
`packages/adapters/orca-plugin/README.md`.
