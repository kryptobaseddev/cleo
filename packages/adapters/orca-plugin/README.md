# CLEO plugin for Orca

A read-only CLEO view inside [Orca](https://github.com/stablyai/orca): a right-sidebar panel
(**CLEO Tasks**) that shows the epics and tasks of one workspace, with each task's acceptance
criteria, evidence gates and worker claim, and one palette command (**CLEO: Refresh Tasks**).

This is the first slice of the CLEO and Orca integration (task T14462, spec
`cleo-orca-integration`, owner decision D11242). It only reads. It does not launch, stop or
approve anything, switch accounts, register hooks, clean up worktrees or schedule work.

## What it runs

| Piece | File | What it does |
|---|---|---|
| Manifest | `orca-plugin.json` | Manifest format 2, plugin id `cleo`, Orca `>=1.4.255` |
| Panel | `src/panel.tsx`, `src/panel-state.ts` | Components panel: workspace picker, epic and task tree, task detail. `panel.tsx` draws; `panel-state.ts` decides what is read and which answer may be drawn |
| Worker | `src/worker.ts`, `src/handlers.ts` | Node worker: answers the panel with bounded `cleo` reads. `worker.ts` binds the handlers to Orca |
| Command | `cleo.refresh` | Tells the open panel to reload |

The panel never talks to CLEO. It asks the worker, and the worker starts one `cleo` process per
read, without a shell, from a fixed set of commands:

| Read | Command |
|---|---|
| Epics of the workspace | `cleo list --type epic [--status <status>] --limit 50 --offset <n>` |
| Children of a task | `cleo list --parent <id> --limit 50 --offset <n>` |
| One task | `cleo show <id> --full` |

Every read is bounded: 20 seconds, 4 MiB of output, 50 rows a page, and it stops when the panel
cancels or closes. Stdout must be exactly one LAFS envelope; the envelope, not the exit code,
decides success. Task ids are checked before they reach the command line. The worker never opens
`.cleo/*.db`.

Each read runs in the chosen workspace's folder with the worker's environment minus every `CLEO_*`
variable except `CLEO_HOME` (where this machine keeps CLEO's global data). `CLEO_ROOT`,
`CLEO_PROJECT_ROOT` and `CLEO_DIR` would otherwise replace the folder as the project `cleo` reads,
and show another project under the chosen workspace's name; `CLEO_SESSION_ID`, `CLEO_AGENT_ID` and
`CLEO_AGENT_ROLE` would make the view act as an agent.

## Choosing a workspace

Orca lists workspaces on every host it reaches, and its "focused workspace" has a name and a
branch but no id or path. So the plugin never guesses:

- Nothing is read until you pick a workspace in the panel.
- The choice is stored as Orca's workspace id plus the host and path it named. Before every read
  the worker asks Orca for the list again and refuses the read when the id is gone, names two
  workspaces, or now points at another host or path. The path always comes from Orca's list,
  never from the panel.
- Only a workspace on this machine can be chosen (Orca host `local`, or a folder with no host).
  Remote workspaces (SSH targets, paired servers) are listed, greyed out, and never used as a
  local path.
- Workspaces that share a name are shown with their paths.
- The focused workspace is only labelled `(focused)` when exactly one listed workspace matches
  it. When several match, the panel says so and chooses none.

## What it stores

Three values, in Orca's per-plugin panel state: the chosen workspace (id, host, path), the epic
status filter and which task is open. Tasks, acceptance and evidence are held in memory for the
open panel only and are read again from CLEO on refresh. There is no second task store.

## States you can see

| State | What the panel shows |
|---|---|
| Loading | A spinner, with **Cancel** enabled |
| No workspaces / no matching epics | An empty state saying what to do |
| Remote or ambiguous workspace | A notice; nothing is chosen for you |
| `cleo` not found, not a CLEO project, timeout, unexpected output, CLEO error | A red notice with the reason |
| Failure after data was loaded | The notice, plus the earlier data marked "Showing what was loaded before" |
| More rows than one page | "Showing N of M epics" with **Load more**, until the last page; a truncated child list says how many are hidden |
| Truncated workspace list | A warning that Orca listed only part of its workspaces |

**Refresh** reloads the workspace list, the tree and the open task. **Cancel** stops the reads in
flight; an answer that arrives after a cancel is dropped. So is an answer for a workspace, filter
or task you have since moved away from: the detail pane only ever shows the task selected last.

## Access it asks for

| Access | Why |
|---|---|
| Execution profile `trusted-worker` | The worker is a Node process that starts `cleo`. Orca describes this as running its own code on the Orca host with your user account's access. It is not a sandbox: trust it as you trust the `cleo` CLI and this repository. |
| Capability `workspace:read` | `workspace.list` (ids, hosts, paths) and `workspace.readContext` (the focused workspace's name and branch) |

It asks for nothing else: no storage, settings, secrets, terminal, agent or notification access,
no events and no hooks.

## Loading it (owner decision)

Orca refuses to load a plugin that runs code until its owner approves the exact access. That
approval is the owner's step; nothing in this repository performs it.

```sh
orca plugin validate packages/adapters/orca-plugin --json   # offline manifest check
orca plugin inspect  packages/adapters/orca-plugin --json   # contributions, access, content hash
orca plugin dev load packages/adapters/orca-plugin --json   # exits 3 and prints the approval fingerprint
orca plugin dev load packages/adapters/orca-plugin --approve <fingerprint> --json
orca plugin open local.cleo --panel tasks
```

Approve only the fingerprint Orca prints for this folder. An approved development folder runs
later edits to its files without asking again, and new capabilities or commands need a new
approval. `orca plugin dev unload packages/adapters/orca-plugin` removes it.

## Packaging

The plugin is this folder: `orca-plugin.json`, `src/`, this README. Orca loads the `.ts` and
`.tsx` files as written, so there is no build step, no bundle and no `node_modules`; that is also
why the folder imports nothing from the CLEO workspace packages and checks every envelope itself.
`.orca/` holds typings Orca generates for your installed version and is not committed.

It lives in `packages/adapters` because it is host integration for one agent environment, and it
is not part of the `@cleocode/adapters` npm package. Loading it today means loading this folder
from a checkout. Publishing it to an Orca catalog is a separate owner decision.

## Working on it

```sh
pnpm exec tsc -b packages/adapters/orca-plugin             # type-checks every file; also part of the root `tsc -b`
pnpm exec vitest run packages/adapters/src/__tests__/orca-plugin.test.ts packages/adapters/src/__tests__/orca-plugin-panel.test.ts
orca plugin validate packages/adapters/orca-plugin --json
orca plugin check packages/adapters/orca-plugin --json     # renders every scenario in src/panel.check.ts
```

CI has no Orca, so the plugin is built to be checked without it:

- **Types.** `tsconfig.json` type-checks against `packages/adapters/orca-types/`, a committed
  snapshot of the typings Orca 1.4.255 generates (the `engines.orca` floor), not against the local
  `.orca/types`. CI's Type Check runs it through the root `tsc -b`. When the floor rises, refresh
  the snapshot as that folder's README describes.
- **Tests.** Everything that decides something has no Orca import and is tested by the two vitest
  files above, which CI runs: the CLI runner against real subprocesses (Node stands in for `cleo`),
  the workspace policy, the envelope mapping, the worker handlers and the panel state. The plugin
  folder holds no `*.test.*` file, because Orca's own test kit ships only inside the Orca app.
- **Rendering.** `orca plugin check` draws each scenario with Orca's runtime and reports what
  Orca would refuse or drop. It runs this folder's code on your machine, outside Orca's sandbox,
  without loading it into Orca. It is a local check; CI covers `panel.tsx` and `worker.ts` by
  type only.

## Known limits

- The worker finds `cleo` on the `PATH` of Orca's plugin worker process. If Orca was started
  without your shell's `PATH`, the panel reports "CLEO CLI not found". There is no setting for
  the executable path yet.
- On Windows an npm-installed `cleo` is a `.cmd` shim, which cannot be started without a shell;
  the panel reports "CLEO CLI not found" there.
- Remote workspaces are not read. That needs CLEO to run on the remote host.
