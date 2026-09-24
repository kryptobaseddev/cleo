---
id: portable-backup-bundle
tasks: [T12318]
kind: fix
summary: "`cleo backup export` captures the live cleo.db stores, fails loudly on a missing store, and import proves the restore lossless by re-counting every table"
---

`cleo backup export` snapshotted a hard-coded list of pre-E6 filenames:
`.cleo/tasks.db`, `brain.db`, `conduit.db`, `<cleoHome>/nexus.db` and
`signaldock.db`. Since the E6 cutover (ADR-068) the live stores are the
consolidated `.cleo/cleo.db` and `<cleoHome>/cleo.db`, so neither was ever
captured. Missing stores were only warned about on stderr, and the command
still returned `success: true`. Measured on a real project with a 610 MB store,
`--scope all` produced a **10,803-byte** bundle containing a stale June
`nexus.db`, three JSON files and `global-salt`. Anyone relying on it to move
machines would have lost every task, memory and session.

Export now writes a **portable bundle (manifest v2)**:

- **Live stores.** The primary store for each scope is found through the
  dual-scope resolver (`resolveDualScopeDbPath`), not a literal filename. It is
  captured with `VACUUM INTO` over a read-only connection, which gives a
  consistent snapshot under WAL without checkpointing or otherwise modifying
  the source. Legacy per-domain files are included only when present and are
  labelled `legacy`. The legacy names come from `DB_INVENTORY`.
- **Fails loudly.** A missing primary store exits `E_PRIMARY_STORE_MISSING`
  (exit 4). An unreadable one exits `E_PRIMARY_STORE_UNREADABLE` (exit 3).
  Both return a LAFS error envelope, and no bundle is written.
- **Whole tree, explicit denylist.** The rest of `.cleo/`, the CLEO home and
  the config home is captured byte for byte. Any other SQLite file found in the
  tree is also snapshotted. Excluded material is listed in the result with its
  size: `backups/`, `cache/`, `logs/`, `locks/`, `worktrees/`,
  `verification-archives/`, `_archive/`, WAL/SHM/journal sidecars, pid/lock/tmp
  files, and symlinks that point outside the root. Directories with more than
  200,000 entries report `sizeComplete: false`, and `bytes` is then a lower
  bound. Nothing outside `.cleo/` is read for a project.
- **Secrets only when encrypted.** `global-salt`, `machine-key`,
  `llm-credentials.json`, OAuth/key files, config-home `auth/` and project
  `keys/` travel only in `--encrypt` bundles. Unencrypted bundles report
  `secretsIncluded: false` and list each omitted file with what must be redone.
  Encryption now streams (format byte `0x02`), so multi-GB bundles never sit in
  one Buffer.
- **Verifiable.** The manifest records every table's row count. Import checks
  the manifest self-hash, every file's SHA-256 and `PRAGMA integrity_check`
  before it places anything. After placing, it re-counts every table and
  compares the counts with the manifest. Any mismatch exits
  `E_RESTORE_MISMATCH` (exit 20) and includes the full per-table report.
- **`--scope machine`** exports the global home plus every registered project
  whose path exists and holds a live `cleo.db`. It skips temp and test-fixture
  paths, missing paths, duplicates, and any registered project whose `.cleo/`
  resolves to the global home. Included and skipped counts are reported by
  reason.
- **Relocation.** `cleo backup import <bundle> --target <root>` places a
  single project at a new root. `--map <old>=<new>` (repeatable, longest
  prefix wins) relocates a machine bundle. The global registry row is
  rewritten in the staged store before placement. It is matched by original
  path or projectId, because many older projects have no projectId in
  `project-info.json`. Only the live store is relocated. Legacy files,
  archives and `.bak` snapshots are restored byte-identical. In the live store,
  structural locators are rewritten: path-named columns, path-named keys in `*_json`
  columns such as attachment paths, `config.json`, `project-context.json`, and
  the `projectHash` in `project-info.json`. Historical records are reported but
  never edited: audit logs, observations, narratives, captured tool output and
  task text. Rewriting them would falsify history and break content hashes and
  signatures. Paths outside the old root that were left unchanged are reported,
  and so are rewritten locators whose target does not exist on the new machine.

v1 `.cleobundle` files are still importable. `backup import` detects the format
from the header and sends v1 bundles through the existing path.

## Moving a `.cleo/` that lives in a non-git directory

Consider `/mnt/projects/axiom-analytics`. It is not a git repository, but it
contains two separate repositories (`axiom-app/`, `axiom-instrument-studio/`)
next to the `.cleo/`. Two moves are possible.

**Same layout on the new machine** (for example `--map
/mnt/projects=/home/me/projects`) works as-is. Clone both repositories into the
same relative places and every relative path still resolves.
`project-context.json` keeps working unchanged because its commands are written
`pnpm --dir axiom-app …`. Rewritten attachment locators point at real files
once the repositories are cloned. Until then they appear under
`rewrittenTargetMissing`, which is informational.

**Re-rooting `.cleo/` into one repository** (for example `--target
<new>/axiom-app`) places and verifies the data, but it does not make the
project coherent. The user must fix the following:

- The tool commands in `project-context.json` (`pnpm --dir axiom-app …`) assume
  the old root. Edit them to run in the new root (for example `pnpm test`).
  The `GIT_DIR`/`GIT_WORK_TREE` workaround in its comments is no longer needed,
  because the root is now the git work tree.
- Relative evidence paths recorded before the move (for example
  `files:axiom-app/src/...`) no longer resolve from the new root. Tasks that
  are not yet completed and carry such evidence must be re-verified. Completed
  tasks are not re-validated.
- Locators prefix-rewritten under the new root, such as attachments that
  pointed at `research-plans/…`, point at files that are not inside
  `axiom-app/`. The import lists them under `rewrittenTargetMissing`. Attachment
  content is safe in the content-addressed store; only the provenance path is
  stale.
- `axiom-instrument-studio/` is outside the new root. Work that referenced it
  keeps absolute or old-root-relative paths.

For such a layout the recommended move keeps the same relative layout: keep
`.cleo/` at the directory that contains both repositories, and restore it with
`--map` or `--target` pointing at that directory.

## After importing

- **Unencrypted bundles.** Recreate each listed secret. For example, a new
  `global-salt` means registered agents must re-authenticate, and a new
  `machine-key` means stored agent credentials must be re-entered. Or re-export
  with `--encrypt` to carry them.
- **Worktrees** are never bundled. Recreate them with `cleo orchestrate spawn`.
- **Registry rows.** The bundled registry also carries the stale rows of the
  source machine (temp paths, deleted projects). Prune them with
  `cleo nexus projects clean`.
