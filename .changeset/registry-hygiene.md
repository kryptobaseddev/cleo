---
id: registry-hygiene
tasks: [T12324]
kind: fix
summary: "Registry hygiene: temp projects no longer auto-register into a persistent registry; `nexus projects clean` classifies every row, removes aliases with their rows, and VACUUMs the global store; rows report `.cleo/cleo.db`"
---

The owner's global `nexus_project_registry` held 1,138 rows, of which 1,097
were temp or test directories and 874 no longer existed. Three defects fed it
and one kept it from being cleaned.

**Encounter registration had no notion of a throwaway directory.** Every
command run inside a project, plus `cleo init` and the health startup
reconcile, registered that project globally. Agent scratchpads, `/tmp`
experiments and CLI-spawning test fixtures therefore landed in the real
registry. A project under the OS temp directory (or `/tmp`, `/var/tmp`) is now
refused when the target registry is persistent. A sandboxed run with a temp
`CLEO_HOME` still registers its temp fixtures, and explicit
`cleo nexus register` is unaffected. The vitest fork sandbox, in place since
2026-09-19, already stopped new test leaks. A regression test now pins that
sandbox for `@cleocode/cleo`, and `goal.test.ts` sets its own `CLEO_HOME`.

**`cleo nexus projects clean` left orphaned aliases and vacuumed the wrong
file.** It deleted registry rows through the project handle's ATTACH, so
`--vacuum` compacted the PROJECT `cleo.db`, and `nexus_project_id_aliases`
kept pointing at deleted projects. The command now opens the global registry
store directly. In one transaction it deletes the matched rows, every alias
pointing at them, any pre-existing orphan alias, and an audit receipt listing
each removed row. `--vacuum` then compacts that global store and checkpoints
its WAL.

Every run, dry or applied, now reports a `classification` of the whole
registry (`missingPath`, `tempPath`, `testPath`, `stale`, `retained`,
`orphanAliases`) and `matchedByReason`. An applied run also returns a
`receipt` with the removed rows, alias counts, the store path, the VACUUM
before/after bytes, and the audit id. `--include-temp` also matches paths under
the OS temp directory. `--include-tests` also matches `tests`, `__tests__` and
`fixtures` segments.

**Registry rows named the pre-E6 relics.** `tasks_db_path` and `brain_db_path`
were written as `.cleo/tasks.db` and `.cleo/brain.db`, which are empty in a
migrated project. They are now written as `.cleo/cleo.db`, and rows written
before this fix are reported as `.cleo/cleo.db` when read.
