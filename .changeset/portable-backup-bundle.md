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
- **Unmigrated legacy data is preserved and reported, not migrated.** In
  about 20 real projects the live `cleo.db` is an empty shell. In those
  projects, the legacy `tasks.db` / `brain.db` hold the only copy of the data.
  One measured example is `claude-todo`: 5,330 tasks and 5,148 observations,
  with `tasks_tasks = 0`. Every SQLite file in `.cleo/` is always snapshotted,
  with per-table row counts. Each project and the global home report
  `unmigratedLegacyData: { detected, evidence[] }`. Each evidence entry holds
  the legacy table, its row count, the consolidated table with its row count,
  and the row count of any bare same-named table in `cleo.db`. A project that
  has legacy stores but no `cleo.db` is exported, not rejected. On import,
  such projects are not registered automatically: registering opens the store,
  and opening can run the on-open legacy migration. The import result says so.
- **Fails loudly.** A missing primary store with no legacy store to hold the
  data exits `E_PRIMARY_STORE_MISSING` (exit 4). An unreadable one exits `E_PRIMARY_STORE_UNREADABLE` (exit 3).
  Both return a LAFS error envelope, and no bundle is written.
- **Whole tree, explicit denylist.** The rest of `.cleo/`, the CLEO home and
  the config home is captured byte for byte. Any other SQLite file found in the
  tree is also snapshotted. Excluded material is listed in the result with its
  size: `backups/`, `.backups/`, `cache/`, `logs/`, `locks/`, `worktrees/`,
  `verification-archives/`, `_archive/`, WAL/SHM/journal sidecars, pid/lock/tmp
  files, and symlinks that point outside the root. Directories with more than
  200,000 entries report `sizeComplete: false`, and `bytes` is then a lower
  bound. Nothing outside `.cleo/` is read for a project.
- **Memories always travel (ADR-093).** Brain tables are part of the system
  of record and are in every bundle, including unencrypted ones. The export
  result carries `memory: { included, encrypted, counts, notice }`. When the
  bundle is unencrypted, the notice says so in plain words and recommends
  `--encrypt`.
- **Credentials only when encrypted (ADR-093 `portable-secret`).** An
  unencrypted bundle leaves out secret files: `global-salt`,
  `llm-credentials.json`, OAuth/key files, config-home `auth/` and project
  `keys/`. It also clears credential columns inside each database snapshot,
  for example agent API keys, session owner tokens, OAuth tokens and service
  secrets. The rows themselves are kept, so identities and sessions survive
  with unchanged row counts. Clearing uses `secure_delete` followed by
  `VACUUM`, so the old values are not left in free pages. If a column cannot
  be cleared, the export fails (`E_REDACTION_FAILED`). Every omission is
  listed under `requiresReentry` with what to redo. Encrypted bundles carry
  credentials untouched. `machine-key` is never exported, not even when the
  bundle is encrypted. It is device-bound, and restoring it would overwrite the
  target's key and break every credential already stored there. As a result,
  values encrypted with the source machine-key (for example agent
  `api_key_encrypted`) cannot be decrypted on the target until the T12326
  credential transfer re-seals them under the bundle passphrase. Until that
  integration lands, re-enter them. Encryption now
  streams (format byte `0x02`), so multi-GB bundles never sit in one Buffer.
- **Verifiable, and scriptable.** The manifest records every table's row count. Import checks
  the manifest self-hash, every file's SHA-256 and `PRAGMA integrity_check`
  before it places anything. After placing, it re-counts every table and
  compares the counts with the manifest. It also re-hashes every placed file
  and database, except the entries that relocation rewrote on purpose, which
  are listed in `hashSkipped`. Any count or hash mismatch exits
  `E_RESTORE_MISMATCH` (exit 20) and includes the full report. For a
  restore-and-compare gate:
  `cleo backup import <bundle> --target <dir> --field /data/lossless` prints
  `true` and exits 0 only when the restore is lossless.
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
  `global-salt` means registered agents must re-authenticate. Or re-export
  with `--encrypt` to carry them.
- **Any bundle.** The target keeps its own `machine-key`. Credentials that
  were encrypted with the source key must be re-entered until the T12326
  credential transfer is wired in.
- **Worktrees** are never bundled. Recreate them with `cleo orchestrate spawn`.
- **Registry rows.** The bundled registry also carries the stale rows of the
  source machine (temp paths, deleted projects). Prune them with
  `cleo nexus projects clean`.
