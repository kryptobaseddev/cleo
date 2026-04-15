---
task: T313
epic: T311
type: research
pipeline_stage: research
created: 2026-04-08
feeds_into: [T311-consensus, ADR-038, T311-specification, T311-decomposition]
---

# T311 Research: Cross-Machine Backup Portability Audit

> Read-only investigation. Output feeds Consensus → ADR-038 → Spec → Decomposition.

---

## Section 1: Current VACUUM INTO Backup Mechanism (v2026.4.10/4.11 Baseline)

### File Format

All CLEO SQLite backups are produced via `VACUUM INTO`. This SQLite-native
command creates a fully defragmented, WAL-free binary copy of the source
database in a single atomic write. The output file is a standard SQLite
database file, directly openable with any SQLite tooling.

Source: `packages/core/src/store/sqlite-backup.ts:133-153`

The WAL is first flushed via `PRAGMA wal_checkpoint(TRUNCATE)` to guarantee
no unwritten frames remain before the snapshot. This is critical to snapshot
consistency: without the checkpoint, frames written to the WAL file since the
last automatic checkpoint would be absent from the snapshot.

Source: `packages/core/src/store/sqlite-backup.ts:146`

### Storage Layout

Two independent backup registries:

| Scope | Storage location | DBs covered |
|-------|-----------------|-------------|
| Project | `<project-root>/.cleo/backups/sqlite/` | `tasks.db`, `brain.db` (+ `signaldock.db` after T306) |
| Global | `$XDG_DATA_HOME/cleo/backups/sqlite/` | `nexus.db` (+ `signaldock.db` after T310) |

Global path resolves to platform-specific XDG data directories:
- Linux: `~/.local/share/cleo/backups/sqlite/`
- macOS: `~/Library/Application Support/cleo/backups/sqlite/`
- Windows: `%LOCALAPPDATA%\cleo\Data\backups\sqlite\`

Source: `packages/core/src/store/sqlite-backup.ts:319-325` (`resolveGlobalBackupDir`)

### Filename Pattern

`<prefix>-YYYYMMDD-HHmmss.db` (local time)

Examples: `tasks-20260408-143022.db`, `nexus-20260408-143022.db`

Source: `packages/core/src/store/sqlite-backup.ts:62-68` (`formatTimestamp`)

### Rotation

Each prefix maintains a window of at most 10 snapshots. Oldest snapshot (by
`mtime`) is deleted before writing a new one when the window is full. Rotation
is per-prefix and non-fatal on filesystem errors.

Source: `packages/core/src/store/sqlite-backup.ts:24` (`MAX_SNAPSHOTS = 10`)
Source: `packages/core/src/store/sqlite-backup.ts:85-105` (`rotateSnapshots`)

### Debounce

A 30-second debounce per prefix is applied by default. `force: true` bypasses
it. Used by `cleo session end` and `cleo backup add`.

Source: `packages/core/src/store/sqlite-backup.ts:26-27` (`DEBOUNCE_MS = 30_000`)
Source: `packages/core/src/store/sqlite-backup.ts:169-190` (`vacuumIntoBackup`)

### Registered Snapshot Targets

Project tier (`SNAPSHOT_TARGETS`): `tasks`, `brain`

Source: `packages/core/src/store/sqlite-backup.ts:51-54`

Global tier (`GLOBAL_SNAPSHOT_TARGETS`): `nexus`
(`signaldock` is declared reserved for T310 but not yet active)

Source: `packages/core/src/store/sqlite-backup.ts:314`

### Current CLI Surface (v2026.4.11 baseline)

```
cleo backup add [--destination <dir>] [--global]
cleo backup list [--scope project|global|all]
cleo restore backup [--file <name>] [--dry-run] [--scope project|global]
```

Source: `packages/cleo/src/cli/commands/backup.ts:1-62`
Source: `packages/cleo/src/cli/commands/restore.ts:1-88`

### Identified Gaps (ADR-036 §Cross-Machine Portability)

The current mechanism produces LOCAL machine artifacts with the following
structural gaps relative to cross-machine portability:

1. **No manifest** — backup filenames carry a timestamp and nothing else.
   There is no structured metadata file traveling alongside the snapshot. A
   receiving machine cannot determine what cleo version wrote the backup, which
   DB schema version is in the snapshot, or which machine produced it.

2. **No checksums** — the only integrity guarantee is SQLite's own internal
   page checksum, surfaced by `PRAGMA integrity_check`. There is no external
   SHA-256 or similar checksum that a receiving machine can verify before
   attempting to open the file.

3. **No provenance fingerprint** — nothing in the snapshot file or its
   filename identifies the source machine. The `machine-key` exists in the
   global tier but is not included in or referenced by any snapshot metadata.

4. **No bundle format** — the current mechanism produces individual `.db`
   files. A full CleoOS restore requires transferring `tasks.db`, `brain.db`,
   `signaldock.db`, `nexus.db`, `config.json`, and `project-info.json`
   individually. There is no single portable artifact that carries all of them.

5. **No schema version record** — importing a snapshot taken by a newer
   version of cleo into an older installation can silently corrupt the
   `__drizzle_migrations` table. The `reconcileJournal` function in
   `migration-manager.ts` handles journal orphan detection, but only after
   a migration run, not during a pre-import compatibility check.

Source: `packages/core/src/store/migration-manager.ts:83-130` (`reconcileJournal`)
Source: `.cleo/adrs/ADR-036-cleoos-database-topology.md:269-316`

---

## Section 2: Portable Archive Format Options

Four candidate archive formats are evaluated below. Bundle size assumptions:
`nexus.db` ≈ 30 MB, `tasks.db` ≈ 5 MB, `brain.db` ≈ 2 MB,
`signaldock.db` ≈ 1 MB, JSON files ≈ <1 MB total → ~39 MB uncompressed.
SQLite files compress well (typically 40-60% reduction for sparse databases).

### Candidate 1: tar.gz (tar + gzip)

**Extension**: `.tar.gz` or `.tgz`

**Node.js library**: The `tar` npm package (v6/v7) provides streaming
tar+gzip in pure JavaScript. It is ESM-compatible via `import tar from 'tar'`
(CJS-ESM bridge) or via `@pkgjs/tar` for native ESM. No native bindings
required. Also usable with Node.js built-ins: `zlib.createGzip()` +
`node:tar`-like streaming via `node:fs` streams.

**Cross-platform**: Linux, macOS, Windows all read `.tar.gz`. Native macOS
and Linux command line tools support it directly. Windows requires WSL or
7-Zip but the Node.js `tar` package works natively on all three platforms
without OS tools.

**Compression ratio**: gzip level 6 (default) on mixed SQLite content
(WAL-flushed pages) typically achieves 35-50% size reduction. Expected
bundle: ~20-25 MB from ~39 MB.

**Streaming vs in-memory**: Fully streaming — `tar.create()` with a
file-list can pipe entry by entry without loading the entire archive into
memory. Suitable for large `nexus.db` files.

**Signature/encryption support**: No built-in. Requires wrapping with GPG
(`gpg --symmetric --compress-algo none`) or OpenSSL. Can layer `node:crypto`
AES-GCM on the output stream for custom encryption.

**Pros**: Industry standard, universally readable, streaming, well-tested
Node.js library ecosystem, tar headers preserve file metadata.

**Cons**: Random-access requires full extraction (cannot seek to a specific
file without extracting all prior entries). No built-in integrity beyond
gzip's CRC32 (which covers the compressed stream but not the decompressed
content). A supplementary `checksums.sha256` file inside the archive is
needed.

---

### Candidate 2: zip

**Extension**: `.zip`

**Node.js library**: `yazl` (write) + `yauzl` (read) are the canonical
Node.js zip libraries. Both are ESM-compatible with `import` shims and have
no native bindings. `archiver` (which wraps `yazl`) is also widely used.

**Cross-platform**: First-class on Windows (native Explorer extract).
Readable on macOS and Linux via built-in `unzip`. Best cross-platform
ubiquity for end-user extraction without Node.js installed.

**Compression ratio**: Deflate compression is comparable to gzip for
individual files. zip compresses each file independently, so the aggregate
ratio is similar: ~35-50% from the SQLite content.

**Streaming vs in-memory**: `yazl` uses a streaming write model but
requires knowing file sizes upfront (standard zip limitation). Reading
(`yauzl`) supports central-directory-based random access — you can open
the zip and extract only `manifest.json` without extracting all DBs.

**Signature/encryption support**: zip has an optional AES-256 encryption
extension (WinZip/7-Zip compatible) but `yazl`/`yauzl` do not support it
natively. Traditional zip encryption (ZipCrypto) is cryptographically weak.
Not recommended for encryption without wrapping with an external layer.

**Pros**: Windows-native, random-access file lookup (read manifest first
without unpacking DBs), very wide ecosystem support, single-file container.

**Cons**: zip encryption built-ins are weak. zip was historically not
streaming-write-friendly for large files (requires streaming workarounds in
`yazl`). Less suited to signed/encrypted payloads without custom wrapping.

---

### Candidate 3: tar.zst (tar + Zstandard)

**Extension**: `.tar.zst`

**Node.js library**: `@mongodb-js/zstd` provides Node.js zstd bindings but
requires native compilation (via `node-gyp`). `fzstd` is a pure-JS
implementation but is single-threaded and slower for large files.
`zstd-napi` uses NAPI bindings. ADR-010 mandates zero native-npm-dependencies
for the core package, which rules out any native zstd binding.

Source: (ADR-010 referenced in ADR-036:reference section)

**Cross-platform**: The `.tar.zst` format is not universally supported by
OS-level tools on Windows (requires zstd CLI or 7-Zip with plugin). macOS
and Linux have `zstd` available via Homebrew/package manager but it is not
pre-installed on macOS.

**Compression ratio**: zstd level 3 (default) achieves 45-55% reduction
with significantly faster decompression than gzip. For a 39 MB bundle, expect
~18-22 MB output.

**Streaming vs in-memory**: Streaming supported via `zstd` CLI pipes or the
NAPI bindings, but the pure-JS `fzstd` implementation is block-based (not
fully streaming without additional wrappers).

**Signature/encryption support**: No built-in. Same limitations as tar.gz.

**Pros**: Best compression ratio and fastest decompression of the three
compressed formats. Modern format with broad server-side adoption.

**Cons**: Native binding requirement conflicts with ADR-010's zero-native-npm
mandate. Not natively extractable on Windows or stock macOS without extra
tools. Pure-JS fallback (`fzstd`) exists but has performance penalties.
Unless ADR-010 is relaxed, this format should be considered BLOCKED for the
core package.

---

### Candidate 4: cleo-native .cleobak (custom container)

**Extension**: `.cleobak`

**Node.js library**: No external library required. Format would be
implemented entirely in `packages/core/src/store/`. Could use a simple binary
format: 4-byte magic (`CLEO`), 4-byte format version, then a length-prefixed
manifest JSON blob, followed by length-prefixed file blobs in sequence, with
a trailing SHA-256 checksum of the entire file.

**Cross-platform**: Node.js `Buffer` and `node:fs` streams are fully
cross-platform. However, a `.cleobak` file cannot be opened by any OS-level
tool (no `tar xf`, no File Explorer, no `unzip`). Users must use cleo itself
to inspect or extract.

**Compression ratio**: If internal gzip is layered on each blob, ratio is
comparable to tar.gz. Without compression, 0%.

**Signature/encryption support**: Full control — custom header can include
AES-256-GCM-encrypted content with any key derivation scheme desired.
Signature bytes can be appended to the footer.

**Pros**: Complete format control. Version byte in header allows forward-
compatible format evolution. Can bundle encryption and signing natively.
Zero external dependencies.

**Cons**: Non-inspectable by external tools — users cannot `tar xf` a
.cleobak for manual recovery. Operational risk: if cleo is broken, backups
may be inaccessible. Reinvents decades of tarball infrastructure. Larger
implementation surface to maintain (parser, writer, version migration).

---

### Comparison Table

| Dimension | tar.gz | zip | tar.zst | .cleobak |
|-----------|--------|-----|---------|----------|
| Node.js ESM library | `tar` (mature) | `yazl`/`yauzl` (mature) | `fzstd` (pure-JS) / native binding | custom (none needed) |
| Native binding required | No | No | Yes (for perf) | No |
| ADR-010 compatible | Yes | Yes | Blocked (native) | Yes |
| Linux support | Native | Via `unzip` | Via `zstd` CLI | cleo only |
| macOS support | Native | Native | Via Homebrew | cleo only |
| Windows support | Via Node.js | Native | Via 7-Zip/CLI | cleo only |
| Est. compressed size (39 MB) | ~20-25 MB | ~20-25 MB | ~18-22 MB | ~20-25 MB (with gzip) |
| Streaming write | Yes | Partial | Yes (CLI) | Yes |
| Random-access read | No (full extract) | Yes (central dir) | No | Partial (seek to header) |
| Built-in encryption | No | Weak (ZipCrypto) | No | Can add custom |
| External inspectability | High | High | Medium | None |
| Implementation cost | Low | Low | Low | High |

**Summary for HITL**: tar.gz is the lowest-risk, highest-compatibility option
that satisfies ADR-010 (zero native bindings). zip adds Windows-native
extractability and random-access manifest reading at similar cost. tar.zst is
effectively blocked by ADR-010 unless an exception is granted. `.cleobak`
offers maximum control but at significant maintenance cost and zero external
inspectability.

---

## Section 3: Manifest Schema

### Why a Manifest is Necessary

A standalone `.db` snapshot has no self-describing provenance. When transferred
to another machine, an operator cannot determine: which cleo version wrote it,
whether the schema matches the installed cleo, which machine produced it, or
whether the file was corrupted in transit. The manifest provides the structured
metadata layer that makes a bundle self-describing.

### Candidate Manifest Schema (v1)

```json
{
  "$schema": "https://cleocode.dev/schemas/backup-manifest-v1.json",
  "manifestVersion": "1.0.0",
  "backup": {
    "createdAt": "2026-04-08T14:30:22Z",
    "createdBy": "cleo v2026.4.13",
    "scope": "project",
    "projectFingerprint": "<sha256 of project-info.json contents>",
    "machineFingerprint": "<sha256 of machine-key contents>",
    "cleoVersion": "2026.4.13"
  },
  "databases": [
    {
      "name": "tasks",
      "filename": "tasks-20260408-143022.db",
      "size": 5242880,
      "sha256": "abc123...",
      "schemaVersion": "20260327000000",
      "rowCounts": {
        "tasks": 300,
        "sessions": 12,
        "phases": 3
      }
    },
    {
      "name": "brain",
      "filename": "brain-20260408-143022.db",
      "size": 2097152,
      "sha256": "def456...",
      "schemaVersion": "20260321000001",
      "rowCounts": {
        "brain_decisions": 45,
        "patterns": 8,
        "learnings": 12
      }
    },
    {
      "name": "signaldock",
      "filename": "signaldock-20260408-143022.db",
      "size": 1048576,
      "sha256": "ghi789...",
      "schemaVersion": "2026.3.76",
      "rowCounts": {
        "agents": 4,
        "messages": 120
      }
    },
    {
      "name": "nexus",
      "filename": "nexus-20260408-143022.db",
      "size": 31457280,
      "sha256": "jkl012...",
      "schemaVersion": "20260318205558",
      "rowCounts": {
        "nodes": 890,
        "edges": 1240
      }
    }
  ],
  "files": [
    {
      "name": "config.json",
      "filename": "config.json",
      "size": 2048,
      "sha256": "mno345..."
    },
    {
      "name": "project-info.json",
      "filename": "project-info.json",
      "size": 512,
      "sha256": "pqr678..."
    }
  ],
  "integrity": {
    "algorithm": "sha256",
    "manifestHash": "<sha256 of this JSON object with manifestHash set to empty string>"
  }
}
```

### Field-by-Field Justification

**`manifestVersion`** — Required. Allows the importer to reject manifests
from formats it cannot understand. Version `"1.0.0"` signals the v1 schema.
A future breaking change bumps the major version and the importer emits a
clear `E_MANIFEST_VERSION_UNSUPPORTED` error rather than silently misreading
fields.

**`backup.createdAt`** — Required. ISO 8601 UTC timestamp. Allows operators
to identify when the backup was taken. The existing VACUUM INTO snapshot
filenames carry a local-time timestamp in the filename only; the manifest
promotes this to a structured, machine-parseable, timezone-normalised field.

**`backup.createdBy`** — Required. The cleo version string that produced the
export. Combined with `cleoVersion` (see below) it gives a full audit trail
of which binary produced the backup. Useful for bug reports.

**`backup.scope`** — Required. One of `"project"` or `"global"`. The importer
uses this to determine which tier the databases should be restored into. A
global-scope backup should never be accidentally restored into a project tier.

**`backup.projectFingerprint`** — Required for project-scope backups;
`null` for global-scope. SHA-256 hash of `project-info.json` at export time.
Allows the importer to warn when restoring a backup into a project with a
different identity (different project name, different root path). Does NOT
block the import by default — this is a warning, not an error — because the
primary use case is moving projects between machines where the path changes.

Source: (project-info.json path resolution at `packages/core/src/paths.ts:574`)

**`backup.machineFingerprint`** — Required. SHA-256 hash of the `machine-key`
file at `$XDG_DATA_HOME/cleo/machine-key`. This is the publicly-safe
representation of the machine identity — it commits to a specific key without
exposing the key itself.

Source: `packages/core/src/crypto/credentials.ts:37-56` (`getMachineKeyPath`)

**IMPORTANT**: The `machine-key` itself is used to derive per-project AES
encryption keys for agent credentials in `signaldock.db`. See Section 5
for the security implications of this linkage.

**`backup.cleoVersion`** — Required. Semantic version of cleo at export time.
Separate from `createdBy` because `createdBy` is a human-readable string and
`cleoVersion` is machine-parseable for comparison logic.

**`databases[].schemaVersion`** — Required. The latest applied migration
identifier for each database. For Drizzle-managed databases (`tasks`,
`brain`, `nexus`), this is the `folderMillis` of the last entry in
`__drizzle_migrations` (a timestamp-based identifier such as
`"20260327000000"`). For `signaldock`, this is the `SIGNALDOCK_SCHEMA_VERSION`
constant (`"2026.3.76"` as of v2026.4.11).

Source: `packages/core/src/store/migration-manager.ts:91-125` (journal reconciliation)
Source: `packages/core/src/store/signaldock-sqlite.ts:31` (`SIGNALDOCK_SCHEMA_VERSION`)

The importer uses this field to detect schema version mismatches before
touching any live database. Without it, importing a future-schema backup into
an older cleo silently runs reconcile on startup, potentially corrupting data.

**`databases[].rowCounts`** — Recommended but not required. Used by the
`cleo backup inspect` command to display a summary of what is in the bundle
without extracting or opening the databases. Makes dry-run inspection useful
for human operators ("this backup has 300 tasks and 45 brain entries").
Optional at import time — row count mismatches are not an import error.

**`databases[].sha256`** — Required. The SHA-256 of the `.db` file as it
exists inside the archive. Verified pre-extraction to detect corruption in
transit. This is the primary transport integrity mechanism.

**`integrity.manifestHash`** — Required. SHA-256 of the manifest JSON with
the `manifestHash` field set to empty string (`""`), then base64 or hex
encoded. This allows the importer to verify the manifest itself was not
tampered with before trusting any of its fields. The algorithm used is
recorded in `integrity.algorithm`.

### Fields REJECTED for v1

**`hostname`** — Rejected. Hostnames are not unique, can change, and may
expose PII (corporate machine naming conventions). The `machineFingerprint`
(hash of `machine-key`) is both more privacy-preserving and more
cryptographically stable.

**`os` / `platform`** — Rejected. SQLite `.db` files produced by
`VACUUM INTO` are fully binary-portable across OS platforms (SQLite's page
format is endian-agnostic and architecture-independent). Recording the source
OS would imply platform-specific restore restrictions that do not exist.

**`compressionAlgorithm`** — Rejected from manifest (it belongs in the
container format's own header, not the manifest). The manifest lives inside
the archive as an already-decompressed file; the caller has already opened the
archive before reading the manifest, so the compression algorithm is already
known.

**`encryptionAlgorithm`** — Rejected from manifest (same reasoning as
compression). If the bundle is encrypted, the encryption metadata must live
in an unencrypted header or sidecar, not inside the encrypted manifest.

---

## Section 4: Integrity Validation

Four validation layers are needed. Each layer is described below with timing,
failure behavior, and recovery path.

### Layer 1: SHA-256 Checksum Verification

**When**: Pre-extract, immediately after opening the archive and parsing the
manifest.

**What**: For each database file listed in `databases[].sha256`, compute the
SHA-256 of the compressed (or decompressed, depending on where the hash is
computed) file bytes and compare to the manifest value.

**Design choice**: Hash the decompressed file bytes (the raw `.db` content),
not the compressed bytes. This allows the importer to verify integrity
independently of how the archive was compressed or re-compressed during
transit (e.g., if someone re-tarballed or re-zipped the extracted files).

Source: `packages/core/src/platform.ts:129-130` (`sha256` helper already exists)
Source: `packages/core/src/snapshot/index.ts:102` (existing stream hash pattern)

**Failure**: `E_CHECKSUM_MISMATCH` — abort import, report which file failed,
leave no live database modified.

**Recovery**: Re-download or re-transfer the archive from the source machine.

### Layer 2: Manifest Integrity Verification

**When**: Immediately upon reading the manifest, before inspecting any field.

**What**: Compute SHA-256 of the manifest JSON with `manifestHash` zeroed out;
compare to the stored `integrity.manifestHash`.

**Failure**: `E_MANIFEST_TAMPERED` — abort import entirely. If the manifest
itself cannot be trusted, all derived decisions (schema version checks,
fingerprint checks) are unreliable.

**Recovery**: Re-export from the source machine.

### Layer 3: SQLite integrity_check

**When**: Post-extract, after writing each `.db` file to a temporary staging
directory, before committing the tmp files to the live paths.

**What**: Open each extracted `.db` via `DatabaseSync` in read-only mode and
run `PRAGMA integrity_check`. Returns `"ok"` or a list of problems.

Source: `packages/core/src/store/atomic.ts:183-201` (`validateSqliteDatabase` — existing implementation)

**Failure**: `E_CORRUPT_DATABASE` for the affected file — abort import of the
specific database. Other databases in the bundle can still be imported
(configurable via `--partial` flag, see Section 7).

**Recovery**: The source file is corrupt. Return to source machine and
re-export a fresh snapshot.

### Layer 4: Schema Version Compatibility Check

**When**: Post-extract, after passing `integrity_check`, before committing.

**What**: Compare `databases[].schemaVersion` from the manifest against the
latest migration identifier known to the local cleo installation.

For Drizzle-managed databases: read the `__drizzle_migrations` table from
the extracted file to get `MAX(created_at)`. Compare against the latest
`folderMillis` from `readMigrationFiles({ migrationsFolder })`.

Source: `packages/core/src/store/migration-manager.ts:91` (migration file reading pattern)

Three possible outcomes:
1. **Exact match** — proceed.
2. **Import is newer than local** (e.g., backup has `20260327`, local only
   knows `20260321`) — emit `E_SCHEMA_TOO_NEW` error. The local cleo cannot
   safely run against a schema it does not understand. Require `cleo self-update`
   first. Do not import.
3. **Import is older than local** (e.g., backup has `20260321`, local is at
   `20260327`) — emit a WARNING (not error). Drizzle's `migrate()` will run
   the pending migrations on first open after restore. This is safe because
   VACUUM INTO preserves all existing data; the migration adds new columns.
   Allow import with warning.

**Failure for case 2**: Abort with `E_SCHEMA_TOO_NEW`. Output which DB
triggered the error and what version mismatch was detected.

**Recovery for case 2**: Update local cleo to the version that shipped the
migration referenced by the backup's `schemaVersion`.

### Layer 5: Source Fingerprint Validation (Advisory)

**When**: Pre-commit, as a final advisory check.

**What**: Compare `backup.machineFingerprint` against the SHA-256 of the
current machine's `machine-key`. A mismatch means the backup was produced
on a different machine — expected for cross-machine restore scenarios, so
this MUST be a warning, not an error.

**Important implication**: Agent credentials in `signaldock.db` are encrypted
with `HMAC-SHA256(machine-key, project-path)`. If the source machine's
`machine-key` differs from the target machine's `machine-key`, all credential
ciphertexts in the restored `signaldock.db` will be unreadable. The import
MUST emit a prominent warning:

> "This backup was created on a different machine. Agent credentials in
> signaldock.db are encrypted with the source machine's key and cannot be
> decrypted here. Re-register agents after import: `cleo agent register`."

Source: `packages/core/src/crypto/credentials.ts:178-211` (`decrypt` error message documents this behavior)

---

## Section 5: Security Considerations

### What is Sensitive in a CleoOS Export

A full project-scope export contains:

1. `signaldock.db` — stores `api_key_encrypted` for each registered agent.
   Credentials are encrypted with AES-256-GCM using a per-project key derived
   from `HMAC-SHA256(machine-key, project-path)`.
   Source: `packages/core/src/store/signaldock-sqlite.ts:269-271`
   Source: `packages/core/src/crypto/credentials.ts:136-141`

2. `tasks.db` — may contain task descriptions, notes, and agent identifiers.
   Low-sensitivity in most contexts but potentially contains business logic.

3. `brain.db` — contains memory observations and learnings. Potentially
   contains proprietary code snippets or business context captured during
   agent sessions.

4. `project-info.json` — contains project root path, which leaks filesystem
   layout (low-sensitivity but PII in some contexts).

### Credential Ciphertext Portability Problem

Because credentials are encrypted with a MACHINE-BOUND key derived from
`HMAC-SHA256(machine-key, project-path)`, a `signaldock.db` snapshot is
cryptographically bound to the originating machine and project path. On the
target machine:

- The `machine-key` is different → decryption fails with the existing
  `getMachineKey()` / `deriveProjectKey()` chain.
- Even if the project path is identical, the `machine-key` differs → still fails.

This is documented behavior in the decrypt error message at
`packages/core/src/crypto/credentials.ts:205-210`.

**Implication for export design**: The plaintext credentials are NOT accessible
to the export mechanism (which would need the machine-key to decrypt them).
The export necessarily carries encrypted-but-unreadable credential blobs.
On import to a new machine, agents must be re-registered.

### Export Encryption Options

#### Option A: No encryption (plaintext tarball)

**How**: Bundle files as-is into tar.gz.

**Pros**: Simplest implementation, no passphrase prompts, machine-native tools
can inspect the bundle.

**Cons**: `brain.db` and `tasks.db` are readable by anyone who has the file.
`signaldock.db` credentials are already encrypted at-rest but the table
metadata (agent names, API base URLs) is plaintext in the DB.

**Prior art**: `pg_dumpall` produces plaintext SQL by default. Most database
backup tools do not encrypt by default. `git bundle` does not encrypt.

#### Option B: Optional passphrase encryption (--encrypt flag)

**How**: User provides a passphrase. Derive a key using PBKDF2 or Argon2id.
Encrypt the entire tar.gz using AES-256-GCM. Write a minimal plaintext header
(algorithm, KDF parameters, salt, IV) before the ciphertext.

**Pros**: User controls whether sensitive content is encrypted. Opt-in means
no UX friction for non-sensitive projects. Decryption is self-contained
(passphrase + cleo → decrypted bundle, no machine-key dependency).

**Cons**: Passphrase management burden on user. If passphrase is forgotten,
backup is irrecoverable. Passphrase prompt is CLI-hostile for automated
workflows (CI, cron).

#### Option C: Machine-key encryption (automatic, no passphrase)

**How**: Encrypt with a key derived from the target machine's `machine-key`.
Export is encrypted; only a machine with the same `machine-key` can decrypt.

**Pros**: No passphrase management. Transparent to the user.

**Cons**: Defeats the primary use case (cross-machine portability). A backup
encrypted for machine A cannot be decrypted on machine B. This option is
fundamentally incompatible with the T311 goal.

#### Option D: Redacted export (strip credentials, export everything else)

**How**: Before bundling, scan `signaldock.db` and set `api_key_encrypted`
to `NULL` (or a placeholder) for all agents. Export the sanitized copy.

**Pros**: Removes the most sensitive data. Bundle is safe to share more
broadly (e.g., with a colleague onboarding to the same project).

**Cons**: Import produces a broken credential state that requires manual
re-registration of all agents. May not be obvious to users that credentials
were stripped. The redaction transforms a backup into a partial state transfer.

**Prior art**: Some backup tools offer a "schema-only" mode that strips data.

### Recommendation Structure for HITL

The HITL must decide the default encryption posture. The research does not
prescribe a winner but flags that:
- Credential ciphertexts in `signaldock.db` are already machine-bound and
  cannot be decrypted on the target machine regardless of bundle encryption.
- The primary sensitive data at risk in a plaintext bundle is `brain.db`
  content and task data, not agent credentials (those are already unreadable).
- A plaintext default (Option A) with opt-in encryption (Option B, `--encrypt`)
  matches industry practice and is lowest-friction.

---

## Section 6: Restore Modes

### Mode 1: Fresh Install (--mode fresh)

**Scenario**: No pre-existing CLEO data at the target path. The target machine
has a freshly initialized `.cleo/` directory (or the global tier is empty).

**Behavior**:
1. Verify manifest integrity (Section 4, Layer 2).
2. Verify checksums for all DB files (Layer 1).
3. Run `integrity_check` on each extracted DB (Layer 3).
4. Check schema version compatibility (Layer 4).
5. Emit fingerprint warning if source machine differs (Layer 5).
6. Copy each `.db` to the appropriate tier path using atomic tmp-then-rename.
7. Clear any stale WAL sidecar files (`<db>-wal`, `<db>-shm`) at the target path.
8. Copy `config.json` and `project-info.json` (project scope only) with
   atomic rename.
9. Emit structured success log with import provenance.

**Conflict resolution**: Not applicable — no pre-existing data to conflict with.

**Interaction with manifest**: `backup.scope` determines which paths are used.
`backup.machineFingerprint` triggers the re-register agents warning.

Source: `packages/core/src/store/atomic.ts:183-202` (integrity check pattern)

---

### Mode 2: Merge into Existing Install (--mode merge)

**Scenario**: Target machine already has a running CLEO installation with its
own `tasks.db`, `brain.db`, etc. The operator wants to import data from
another machine without losing their current data.

**Conflict Cases**:

1. **Row-level conflict (same task ID, different data)**: The most complex
   case. Two machines that have been running independently will have the same
   `T001`, `T002` etc. IDs with potentially diverged data.

   Candidate resolutions:
   - `abort` — refuse to merge; require fresh mode. Safest, no data loss.
   - `source-wins` — import rows from the bundle, overwriting local conflicts.
   - `local-wins` — keep local rows, skip conflicts from bundle.
   - `prompt` — ask user for each conflicting row (impractical for 300+ tasks).

   No row-merge strategy is free of data loss risk. The `tasks.db` schema
   uses a single-tenant ID space (auto-incrementing `T<N>` with a global
   sequence table). Two independent installations will collide on IDs.

2. **Schema version conflict (import newer than local)**: Covered by Layer 4.
   Abort with `E_SCHEMA_TOO_NEW` regardless of mode.

3. **Schema version conflict (import older than local)**: Covered by Layer 4.
   Emit warning, allow merge. Drizzle will migrate the imported rows to the
   new schema on next open.

4. **Project-root conflict (backup from a differently-named or differently-
   pathed project)**: The `backup.projectFingerprint` (SHA-256 of
   `project-info.json`) will differ. Emit warning: "This backup was created
   for a different project. Task IDs may collide with existing data."

**Practical guidance**: The row-level merge problem for `tasks.db` is
fundamentally hard because the ID space is single-tenant. For v1, `merge`
mode is recommended to target BRAIN (`brain.db`) and NEXUS (`nexus.db`)
only, which contain additive observations and knowledge graph nodes rather
than uniquely-keyed operational state. Full `tasks.db` merge would require
a rekeying strategy (reassigning IDs) which is out of scope for v1.

**Interaction with manifest**: `databases[].rowCounts` gives the operator
an informed preview before committing to a merge.

---

### Mode 3: Dry-Run Inspect (cleo backup inspect)

**Scenario**: Operator wants to see what is in a bundle without applying
anything.

**Behavior**:
1. Open archive and extract `manifest.json` only (no DB extraction).
2. Verify `manifestHash` for manifest integrity.
3. Display structured summary:
   - Backup scope, created-at, cleo version
   - Source machine fingerprint (hash, not key)
   - For each DB: filename, size, schema version, row counts
   - Whether source machine differs from current machine
   - Whether any schema versions are incompatible with local cleo
4. Exit 0 (no changes made).

**Interaction with manifest**: This mode is only possible because the manifest
is a small JSON file that can be extracted without reading the full archive
(for zip: random-access via central directory; for tar.gz: manifest must be
the first entry in the archive).

**Design consideration for tar.gz**: The manifest MUST be the first entry in
the tar archive to support efficient inspect without full extraction.

---

## Section 7: CLI Verb Surface Candidates

The existing backup CLI surface (v2026.4.11 baseline) is:

```
cleo backup add [--destination <dir>] [--global]
cleo backup list [--scope project|global|all]
cleo restore backup [--file <name>] [--dry-run] [--scope project|global]
```

Source: `packages/cleo/src/cli/commands/backup.ts:11-62`
Source: `packages/cleo/src/cli/commands/restore.ts:17-88`

### Candidate A: Verb-based (recommended)

```
cleo backup export <name> --out <path> [--scope project|global|all] [--encrypt]
cleo backup import <path> [--mode fresh|merge|dry-run] [--scope project|global]
cleo backup inspect <path>
```

**Scoring against existing surface**:
- `export` and `import` parallel each other symmetrically.
- `export` adds naturally to the existing `backup` command family alongside
  `add` and `list`.
- `inspect` is a new verb but reads naturally ("inspect what is in this bundle").
- `--scope` flag reuses the same flag that `backup list` and `restore backup`
  already use with identical semantics.
- `--mode` mirrors the `--status` pattern used by `restore task`.

**Ergonomic note**: `cleo backup inspect <path>` is more discoverable than
a `--dry-run` flag on `cleo backup import` because `inspect` appears in
`cleo backup --help` as its own verb.

### Candidate B: Flag-based

```
cleo backup --export --out <path>
cleo backup --import <path> --merge
```

**Scoring**: Inconsistent with the existing `cleo backup <subcommand>` pattern
where `add` and `list` are subcommands, not flags. Flags as primary
action selectors conflict with the subcommand model. Not recommended.

### Candidate C: Subcommand hierarchy

```
cleo backup portable export <name>
cleo backup portable import <path>
cleo backup portable inspect <path>
```

**Scoring**: The `portable` namespace is unnecessarily verbose. The word
"portable" is an implementation detail that users should not need to type.
The distinction between `cleo backup add` (local snapshot) and
`cleo backup export` (portable bundle) is already semantically clear from
the verb choice. Nested subcommands (`backup portable`) create discoverability
issues — users must know the `portable` namespace exists.

### Recommendation

Candidate A is recommended for ergonomic consistency with the existing surface.
Consensus phase makes the final call.

Full proposed surface with options:

```
cleo backup export <name>
  --out <path>            Required. Output path for the bundle.
  --scope project|global|all  Default: project.
  --encrypt               Optional. Prompt for passphrase and encrypt bundle.
  --no-signaldock         Optional. Exclude signaldock.db (strips agent credentials).

cleo backup import <path>
  --mode fresh|merge      Default: fresh. 'merge' warns about ID conflicts.
  --scope project|global  Default: inferred from manifest.
  --force                 Skip fingerprint warning. Required for cross-machine import.
  --dry-run               Alias for 'cleo backup inspect <path>'.

cleo backup inspect <path>
  (no additional flags — read-only manifest display)
```

---

## Section 8: RCASD Next-Step Recommendations

### What Consensus Phase Must Decide

1. **Archive format**: tar.gz vs zip vs .cleobak. Primary decision axis: does
   the team prioritize external inspectability (tar.gz / zip) or full control
   (cleobak)? tar.zst is blocked by ADR-010 unless that constraint is revisited.

2. **Encryption default**: off (plaintext bundle) vs opt-in (`--encrypt` flag)
   vs on-with-passphrase vs on-with-machine-key. The machine-key option is
   architecturally incompatible with cross-machine portability (the goal of T311).

3. **signaldock.db inclusion**: always include (credentials are ciphertext
   and unreadable on target anyway) vs opt-in (`--with-credentials`) vs never
   (require separate export). The inclusion/exclusion decision has UX
   implications: excluding it simplifies the security story but forces
   re-registration on every restore.

4. **Restore default mode for existing installs**: abort if live data exists
   (safe) vs fresh (overwrite) vs merge (risky for tasks.db, safer for
   brain.db). HITL should decide whether merge is in scope for v1 or deferred.

5. **Schema version policy**: strict equal (reject if any mismatch) vs
   major-version compatible (reject only if import is newer) vs best-effort
   with warnings. The research recommends blocking on import-newer-than-local
   and warning on import-older-than-local.

6. **CLI surface**: Candidate A, B, or C (or a hybrid). Must be decided before
   Specification can define the arg-parsing schema.

7. **Manifest hash algorithm**: SHA-256 (established in codebase at
   `packages/core/src/platform.ts:129`) is the obvious choice, but HITL should
   confirm whether SHA-512 or BLAKE3 is worth considering for future-proofing.

8. **Which databases are included in a project-scope export**: tasks + brain +
   signaldock only, or also include nexus (which is global-tier). The ADR-036
   prototype structure includes nexus in a full export; this needs explicit
   confirmation since nexus is architecturally global.

### What ADR-038 Must Document

ADR-038 (CleoOS Backup Portability) must contain the following sections:

- **Archive Format Decision**: Which format was chosen and why (with explicit
  rejection reasoning for the alternatives).
- **Manifest Schema v1**: The canonical `manifest.json` structure, field
  definitions, and the `$schema` URL.
- **Integrity Model**: Which validation layers run at which lifecycle points,
  what error codes they emit, and what the recovery path is for each failure.
- **Security Model**: Encryption default, passphrase handling (if applicable),
  signaldock.db credential treatment, and the machine-binding implications.
- **CLI Surface**: Exact verb surface, flag names, and their semantics.
- **Restore Mode Matrix**: Which modes are supported in v1, which are deferred.
- **Schema Version Compatibility Policy**: Exact rules for blocking vs warning.
- **Upgrade Path**: How v2 of the bundle format (if needed) will be identified
  and handled by a v1-aware cleo installation.

### What Specification Must Define

The Specification phase must produce the following concrete contracts:

1. **`BackupManifest` TypeScript type** — in `packages/contracts/src/` per
   the code quality rules. Must cover all fields from Section 3.

2. **`packBackup(dbs: DatabaseRef[], opts: PackOptions) => Promise<string>`** —
   function signature for the archiver. Inputs: list of DB paths + manifest
   metadata. Output: path to the created archive.

3. **`unpackBackup(archivePath: string, opts: UnpackOptions) => Promise<UnpackResult>`** —
   function signature for the importer. Must include pre-commit validation
   results in `UnpackResult`.

4. **`inspectBackup(archivePath: string) => Promise<BackupInspectResult>`** —
   manifest-only reader for the `inspect` command.

5. **CLI argument schema** — exact flag names, types, defaults, and validation
   rules for `backup export`, `backup import`, and `backup inspect`.

6. **Exit codes** for each failure mode:
   - `E_CHECKSUM_MISMATCH` — archive file corrupt in transit
   - `E_MANIFEST_TAMPERED` — manifest hash verification failed
   - `E_CORRUPT_DATABASE` — SQLite integrity_check failed
   - `E_SCHEMA_TOO_NEW` — backup has newer schema than local cleo
   - `E_SCOPE_MISMATCH` — backup scope incompatible with target

7. **Encryption contract** (if encryption is in scope for v1): passphrase KDF
   parameters (algorithm, iterations, salt length), ciphertext envelope format,
   and the plaintext header structure that allows the importer to identify an
   encrypted bundle before attempting decryption.

### What Decomposition Must Produce

Estimated atomic implementation tasks (sizes are rough):

| # | Task | Size | Notes |
|---|------|------|-------|
| 1 | `BackupManifest` type + schema in contracts | small | Foundation for all other tasks |
| 2 | Archive packer (`packBackup`) | medium | tar.gz (or chosen format) writer |
| 3 | Archive unpacker (`unpackBackup`) | medium | Extractor + all 4 validation layers |
| 4 | Manifest inspect reader (`inspectBackup`) | small | Manifest-only read, no DB extract |
| 5 | `cleo backup export` CLI wiring | small | Connects packer to CLI flags |
| 6 | `cleo backup import` CLI wiring | small | Connects unpacker to CLI flags |
| 7 | `cleo backup inspect` CLI command | small | New subcommand, thin wrapper |
| 8 | Integration test: round-trip (project scope) | medium | Export machine A → import machine B simulation |
| 9 | Integration test: round-trip (global scope) | small | nexus.db export/import |
| 10 | Integration test: schema version mismatch | small | Inject old/new schema version in manifest |
| 11 | Integration test: corrupt archive | small | Flip byte in archive, verify abort |
| 12 | ADR-038 authorship | small | Write after Consensus decisions land |
| 13 | v2026.4.13 release mechanics | small | CalVer bump, changelog, npm publish |

Total: ~13 tasks. The packer (task 2) and unpacker (task 3) are the critical
path because all CLI wiring tasks (5, 6, 7) depend on them.

---

## Section 9: File:Line Citations

1. `packages/core/src/store/sqlite-backup.ts:24` — `MAX_SNAPSHOTS = 10` constant
2. `packages/core/src/store/sqlite-backup.ts:26-27` — `DEBOUNCE_MS = 30_000`
3. `packages/core/src/store/sqlite-backup.ts:51-54` — `SNAPSHOT_TARGETS` for project tier
4. `packages/core/src/store/sqlite-backup.ts:62-68` — `formatTimestamp` producing `YYYYMMDD-HHmmss`
5. `packages/core/src/store/sqlite-backup.ts:85-105` — `rotateSnapshots` function
6. `packages/core/src/store/sqlite-backup.ts:133-153` — `snapshotOne` with VACUUM INTO call
7. `packages/core/src/store/sqlite-backup.ts:146` — `PRAGMA wal_checkpoint(TRUNCATE)` line
8. `packages/core/src/store/sqlite-backup.ts:314` — `GLOBAL_SNAPSHOT_TARGETS` (nexus only)
9. `packages/core/src/store/sqlite-backup.ts:319-325` — `resolveGlobalBackupDir`
10. `packages/core/src/store/sqlite-backup.ts:346-403` — `vacuumIntoGlobalBackup` function
11. `packages/core/src/store/migration-manager.ts:83-130` — `reconcileJournal` (journal orphan detection)
12. `packages/core/src/store/migration-manager.ts:91-125` — migration hash reading via `readMigrationFiles`
13. `packages/core/src/store/signaldock-sqlite.ts:31` — `SIGNALDOCK_SCHEMA_VERSION = '2026.3.76'`
14. `packages/core/src/store/signaldock-sqlite.ts:269-271` — `api_key_encrypted` column addition
15. `packages/core/src/crypto/credentials.ts:7-9` — machine-key derivation comment
16. `packages/core/src/crypto/credentials.ts:37-56` — `getMachineKeyPath()` platform-aware resolution
17. `packages/core/src/crypto/credentials.ts:64-132` — `getMachineKey()` read/generate/permission-check
18. `packages/core/src/crypto/credentials.ts:136-141` — `deriveProjectKey` using HMAC-SHA256
19. `packages/core/src/crypto/credentials.ts:178-211` — `decrypt()` with machine-key-mismatch error
20. `packages/core/src/store/atomic.ts:183-201` — `validateSqliteDatabase` using `PRAGMA integrity_check`
21. `packages/core/src/platform.ts:129-130` — `sha256()` helper using `createHash('sha256')`
22. `packages/core/src/snapshot/index.ts:102` — streaming SHA-256 hash computation pattern
23. `packages/cleo/src/cli/commands/backup.ts:11-62` — existing CLI backup command registration
24. `packages/cleo/src/cli/commands/restore.ts:17-88` — existing CLI restore backup command
25. `.cleo/adrs/ADR-036-cleoos-database-topology.md:269-316` — Cross-Machine Portability section
26. `.cleo/adrs/ADR-036-cleoos-database-topology.md:181-228` — Backup Mechanism section

---

## Section 10: Open Questions for Consensus Phase

**Q1: What archive format should v1 use?**
- A) tar.gz — widest Linux/macOS/Windows compatibility via Node.js `tar` package; no native bindings; streaming; requires supplementary checksums.sha256
- B) zip — Windows-native extraction without tools; random-access manifest read; requires `yazl`+`yauzl`; weak built-in encryption
- C) tar.zst — best compression ratio; blocked by ADR-010 (native binding required); not stock on Windows or macOS
- D) .cleobak (custom) — full control; no external dependencies; no external inspectability; high maintenance cost

**Q2: Should the export be encrypted by default?**
- A) Off by default, opt-in via `--encrypt` flag (industry default pattern; matches pg_dumpall, git bundle)
- B) Always encrypted with user passphrase (maximum security; friction in automated workflows)
- C) Encrypted with machine-key derivation (no passphrase; incompatible with cross-machine portability — NOT VIABLE for T311)
- D) Two modes: plaintext (default) + `--redact` to strip signaldock.db credentials before bundling

**Q3: What is the default restore mode when live data already exists?**
- A) Abort with `E_DATA_EXISTS` — require `--force` to overwrite (safest; no merge complexity in v1)
- B) Fresh overwrite by default with confirmation prompt
- C) Merge `brain.db` and `nexus.db` additively; abort for `tasks.db` conflicts (partial merge)
- D) Full merge with `source-wins` conflict resolution (highest risk; ID collision for tasks.db)

**Q4: Should `signaldock.db` be included in the export bundle by default?**
- A) Always include — credentials are already machine-bound ciphertext and unreadable on target; inclusion completes the backup but requires re-registration warning
- B) Opt-in via `--with-credentials` flag — exclude by default since credentials will not work on target anyway
- C) Never include signaldock.db in export — require separate agent re-registration; simplifies security model

**Q5: What schema version compatibility policy should govern import?**
- A) Strict equal — reject import if ANY database schema version differs from local (maximally safe; maximally restrictive)
- B) Block if import is newer than local; allow (with warning) if import is older (research recommendation: forward-only blocks, backward-compat allows)
- C) Best-effort with warnings only — allow all imports and let Drizzle reconcile on first open
- D) Block if import schema major-version differs; allow patch/minor mismatches

**Q6: Should `manifest.json` include a `$schema` URL pointing to a published JSON Schema?**
- A) Yes — enables IDE validation and self-documentation; requires maintaining a schema at `cleocode.dev/schemas/`
- B) No — schema URL adds external dependency; keep manifest self-contained
- C) Include `$schema` field but point to a bundled schema path rather than a remote URL

**Q7: Which databases are included in a project-scope export?**
- A) `tasks.db` + `brain.db` + `signaldock.db` only (project-tier DBs as defined in ADR-036)
- B) All of the above plus `nexus.db` (global-tier) pulled into the bundle for a complete restore
- C) Determined by `--scope` flag: `project` exports project-tier; `global` exports nexus; `all` exports both

**Q8: What should happen to `config.json` and `project-info.json` on import?**
- A) Restore both files exactly as exported (target project gets source project's config)
- B) Restore `config.json` only; regenerate `project-info.json` from local detection
- C) Skip both JSON files; only restore SQLite databases (config is environment-specific)
- D) Include both with a warning that `project-info.json.projectRoot` will differ on target machine
