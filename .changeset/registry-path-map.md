---
id: registry-path-map
tasks: [T12354]
kind: fix
summary: "A moved project's registry path now updates on any command, not just `cleo init` / `cleo nexus reconcile`, and a new device-local path map records every checkout of a project"
---

After `mv`, `cleo list` and `cleo briefing` left the registry pointing at the
old directory. Only `cleo init` and `cleo nexus reconcile` updated it.

**Root cause.** The registry was updated only as a side effect of the
deprecated walk-up branch of `getCleoDirAbsolute(cwd)`, and that had two
problems:

- Commands that resolve the project through `getProjectRoot`/`resolveCleoDir`,
  such as `cleo list`, never reached it.
- Commands that did reach it, such as `cleo briefing`, started the
  registration as detached background work. CLI teardown cancels in-flight
  work before draining it, so the registration was abandoned before it
  committed (`Project encounter abandoned by teardown` under `CLEO_DEBUG`).

`init` and `nexus reconcile` worked because they await their registry write.

**Fix.** The CLI now calls `recordProjectEncounter()` and awaits it once per
command, *before* the command runs. Running it afterwards would miss commands
that leave through `process.exit`, such as an empty `cleo list`, which exits
with 100. If the registry row and the path map already name this checkout, the
call is one indexed read. Only a new or moved checkout pays for a full
registration. The detached encounter joins the same in-flight registration
instead of racing it.

**Two checkouts.** The registry row is keyed by the immutable `project_id`, so
it can name only one checkout. The new global `nexus_project_paths` table is
the device-local path map. It holds one row per checkout path, and each path
belongs to exactly one project. A migration backfills it from the existing
registry rows.

- Every writer that records a checkout in the registry also records it here,
  in the same transaction: the encounter, `nexusRegister` and
  `nexusReconcile`. `nexusMoveProject` gets this through the reconcile it
  runs.
- A checkout whose directory is gone is pruned the next time its project is
  recorded, so a move leaves one checkout, not two.
- `nexus unregister` and `nexus projects clean` remove the project's path-map
  rows.
- `listProjectCheckouts(projectId)` returns every checkout.
- The registry row itself keeps naming the checkout used most recently, as
  before.
