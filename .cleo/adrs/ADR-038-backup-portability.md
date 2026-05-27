# ADR-038: Cross-Machine Backup Portability

**Date**: 2026-04-08
**Status**: accepted
**Accepted**: 2026-04-08
**Related Tasks**: T311, T330, T331, T332, T333
**Related ADRs**: ADR-036, ADR-037, ADR-013
**Keywords**: backup, portability, tar, manifest, schema, cross-machine, restore, conflict, regenerate-and-compare, cleobundle, encryption, argon2id, aes-gcm, integrity, sha256, signaldock, conduit
**Topics**: backup-architecture, portability, restore, cross-machine
**Summary**: Tarball-based .cleobundle format for portable cross-machine backup export/import. Opt-in encryption, abort-with-force restore semantics, always-include signaldock/conduit, best-effort schema compat with warnings, bundled JSON Schema manifest, and intelligent A/B regenerate-and-compare for JSON file restore with conflict report and agent review loop.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

ADR-036 documented the cross-machine portability direction as intentional future work, pointing to T311 as the follow-on epic. That section described the structural gaps in the then-current backup mechanism and sketched a tarball-based solution. T311 is that follow-on, and this ADR is its formal architectural record.

### Current State (v2026.4.11 Baseline)

The v2026.4.11 backup mechanism produces raw `.db` snapshots via SQLite's `VACUUM INTO` command at both the project tier (`<project-root>/.cleo/backups/sqlite/`) and the global tier (`$XDG_DATA_HOME/cleo/backups/sqlite/`). Each backup registry maintains at most 10 snapshots per prefix with oldest-first rotation. The existing `cleo backup add` and `cleo restore backup` commands operate on these local-machine snapshots.

The mechanism has five structural gaps that prevent cross-machine portability (from ADR-036 §Cross-Machine Portability and research audit Section 1):

1. **No manifest** — snapshot filenames carry a timestamp and nothing else. A receiving machine cannot determine which cleo version wrote the backup, what DB schema version is in the snapshot, or which machine produced it.
2. **No checksums** — no external SHA-256 or similar checksum exists that a receiving machine can verify before attempting to open the file.
3. **No provenance fingerprint** — nothing in a snapshot identifies the source machine.
4. **No bundle format** — individual `.db` files must be transferred separately; no single portable artifact carries all of them together.
5. **No schema version record** — importing a snapshot from a newer cleo into an older installation can silently corrupt the `__drizzle_migrations` table.

Source: `packages/core/src/store/sqlite-backup.ts` (VACUUM INTO pipeline), `.cleo/adrs/ADR-036-cleoos-database-topology.md` §Cross-Machine Portability.

### Dependency on ADR-037 (T310)

This ADR depends on ADR-037 (Conduit + Signaldock Separation, v2026.4.12) because the export code MUST reference `conduit.db` at the project tier and `signaldock.db` at the global tier per T310's topology. The T311 release (v2026.4.13) MUST NOT ship before T310 lands on main. See Cross-Epic Dependency section.

### Research Basis

All eight decisions in this ADR were reached via the T311 consensus phase (T330) following a research audit documented in `.cleo/research/T311-backup-portability-audit.md`. Section references in this ADR cite that audit for evidence.

---

## Decision

### 1. Archive Format: tar.gz (Q1=A)

**Decision**: The portable bundle format for v1 is **tar.gz**. The canonical file extension is `.cleobundle.tar.gz`. Encrypted bundles use `.enc.cleobundle.tar.gz`.

**Rationale**: The `tar` npm package (v6/v7) is mature, pure JavaScript, streaming, and carries no native bindings. This satisfies the ADR-010 zero-native-npm-dependencies mandate without exception. tar.gz is natively readable on Linux and macOS and readable on Windows via the Node.js `tar` package without OS tooling. Expected compressed bundle size for a typical full project scope (~39 MB uncompressed): 20–25 MB at gzip level 6.

The manifest MUST be the first entry in the tar archive to support efficient `cleo backup inspect` operations that extract only the manifest without reading the full archive.

Source evidence: Research audit Section 2 (Portable Archive Format Options), comparison table.

**Alternatives rejected**: see Alternatives Considered section.

### 2. Bundle Layout

The canonical `.cleobundle.tar.gz` layout is:

```
<name>.cleobundle.tar.gz
├── manifest.json                   ← $schema: "./schemas/manifest-v1.json"
├── schemas/
│   └── manifest-v1.json            ← JSON Schema Draft 2020-12 (bundled, not remote)
├── databases/
│   ├── tasks.db                    ← project tier (if --scope project or all)
│   ├── brain.db                    ← project tier
│   ├── conduit.db                  ← project tier (per ADR-037 topology)
│   ├── nexus.db                    ← global tier (if --scope global or all)
│   └── signaldock.db               ← global tier (per ADR-037 topology)
├── json/
│   ├── config.json                 ← project tier
│   ├── project-info.json           ← project tier
│   └── project-context.json        ← project tier (Q8 EXTENDED inclusion)
├── global/                         ← present only if --scope global or all
│   └── global-salt                 ← WARNING emitted on restore (see §8)
└── checksums.sha256                ← per-file SHA-256 of decompressed file bytes
```

The `databases/` subdirectory includes only the databases applicable to the export scope (see §4). Files absent from the scope are not written into the archive at all; the manifest's `databases` array reflects exactly what was included.

### 3. Manifest Schema v1 (Q6=C — Bundled Path)

**Decision**: `manifest.json` MUST include a `$schema` field pointing to the bundled schema at `./schemas/manifest-v1.json` relative to the archive root. The schema file travels inside the tarball as `schemas/manifest-v1.json`. The `$schema` value is never a remote URL.

**Rationale (Q6=C)**: A remote URL creates an external dependency that breaks offline restores. A fully schema-free manifest loses IDE validation and self-documentation. The bundled path provides both offline safety and validator support. Future schema versions ship as `manifest-v2.json` alongside `manifest-v1.json` for backward-compatible fallback.

The canonical `manifest.json` structure (v1):

```json
{
  "$schema": "./schemas/manifest-v1.json",
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
      "filename": "databases/tasks.db",
      "size": 5242880,
      "sha256": "<sha256 of decompressed .db bytes>",
      "schemaVersion": "20260327000000",
      "rowCounts": {
        "tasks": 300,
        "sessions": 12,
        "phases": 3
      }
    },
    {
      "name": "brain",
      "filename": "databases/brain.db",
      "size": 2097152,
      "sha256": "<sha256 of decompressed .db bytes>",
      "schemaVersion": "20260321000001",
      "rowCounts": {
        "brain_decisions": 45,
        "patterns": 8,
        "learnings": 12
      }
    },
    {
      "name": "conduit",
      "filename": "databases/conduit.db",
      "size": 1048576,
      "sha256": "<sha256 of decompressed .db bytes>",
      "schemaVersion": "20260401000000",
      "rowCounts": {
        "project_agent_refs": 4
      }
    }
  ],
  "files": [
    {
      "name": "config.json",
      "filename": "json/config.json",
      "size": 2048,
      "sha256": "<sha256>"
    },
    {
      "name": "project-info.json",
      "filename": "json/project-info.json",
      "size": 512,
      "sha256": "<sha256>"
    },
    {
      "name": "project-context.json",
      "filename": "json/project-context.json",
      "size": 1024,
      "sha256": "<sha256>"
    }
  ],
  "integrity": {
    "algorithm": "sha256",
    "manifestHash": "<sha256 of this JSON with manifestHash set to empty string>"
  }
}
```

**Field definitions**:

- `manifestVersion` — Required. Allows the importer to reject manifests from incompatible format versions. Breaking format changes increment the major version and trigger `E_MANIFEST_VERSION_UNSUPPORTED`.
- `backup.createdAt` — Required. ISO 8601 UTC timestamp. Promotes the VACUUM INTO filename timestamp to a structured, timezone-normalized, machine-parseable field.
- `backup.createdBy` — Required. Human-readable cleo version string that produced the export.
- `backup.scope` — Required. One of `"project"`, `"global"`, or `"all"`. Determines which tier paths are used on restore.
- `backup.projectFingerprint` — Required for project-scope; `null` for global-only. SHA-256 of `project-info.json` at export time. Triggers an advisory warning when restoring to a project with a different identity; does not block import.
- `backup.machineFingerprint` — Required. SHA-256 hash of the `machine-key` file at `$XDG_DATA_HOME/cleo/machine-key`. Privacy-safe proxy for machine identity without exposing the key itself.
- `backup.cleoVersion` — Required. Machine-parseable version string for comparison logic.
- `databases[].schemaVersion` — Required. Latest applied migration identifier per database (Drizzle `folderMillis` for Drizzle-managed DBs; `SIGNALDOCK_SCHEMA_VERSION` constant for signaldock). Used by the schema compatibility check (§9).
- `databases[].rowCounts` — Recommended. Used by `cleo backup inspect` to display bundle contents without extracting databases.
- `databases[].sha256` — Required. SHA-256 of the decompressed `.db` file bytes. Primary transport integrity mechanism.
- `integrity.manifestHash` — Required. SHA-256 of the manifest JSON with `manifestHash` set to `""`, then hex-encoded. Allows the importer to verify the manifest was not tampered with before trusting any derived decision.

Source evidence: Research audit Section 3 (Manifest Schema), Section 4 (Integrity Validation).

### 4. Export Scope: --scope flag (Q7=C)

**Decision**: Export scope is controlled by a `--scope project|global|all` flag. Default is `project`.

Per the ADR-037 topology (T310):

| `--scope` | Databases included | JSON files included |
|-----------|-------------------|---------------------|
| `project` | `tasks.db`, `brain.db`, `conduit.db` | `config.json`, `project-info.json`, `project-context.json` |
| `global` | `nexus.db`, `signaldock.db` | — |
| `all` | union of both scopes | `config.json`, `project-info.json`, `project-context.json` |

The `global-salt` file at `$XDG_DATA_HOME/cleo/global-salt` is included only with `--scope global` or `--scope all`. Its presence in the bundle triggers a security warning at both export and import time because it is used in the KDF chain for agent credential encryption (per ADR-037 §5). Importing a bundle that contains `global-salt` to a new machine regenerates API-key-derived ciphertexts bound to the source machine's salt, invalidating all agent credentials on the target. Operators MUST be warned explicitly.

Exporting with `--scope global` in the absence of an initialized project context is allowed (useful for fresh machine seeding with existing global agent registries).

Source evidence: Research audit Section 7 (CLI Verb Surface), T311 consensus Q7 cross-reference to T310 Q5 and Q3.

### 5. Encryption: Opt-In via --encrypt (Q2=A)

**Decision**: Bundles are unencrypted by default. Encryption is opt-in via the `--encrypt` flag.

**Rationale (Q2=A)**: Encryption-by-default adds passphrase management complexity to every backup and breaks CI/automation workflows. The most sensitive data in the bundle (`signaldock.db` credentials) are already machine-bound ciphertext: `AES-256-GCM(HMAC-SHA256(machine-key, project-path), api_key_plaintext)`. They are unreadable on the target machine regardless of whether the bundle itself is encrypted. This matches the defaults of `pg_dumpall`, `git bundle`, and `tar` in the industry.

When `--encrypt` is specified:

1. Prompt for a passphrase at the CLI.
2. Generate a random 32-byte per-bundle salt.
3. Derive a 256-bit encryption key using Argon2id: `key = Argon2id(passphrase, salt, t=3, m=65536, p=4)`.
4. Encrypt the finalized `.cleobundle.tar.gz` byte stream with AES-256-GCM, producing `.enc.cleobundle.tar.gz`.
5. Prepend a plaintext header containing the algorithm identifier, Argon2id parameters, salt, and GCM IV to allow decryption without out-of-band metadata.

On import, the `.enc.cleobundle.tar.gz` extension is detected automatically, a passphrase is prompted, and decryption occurs before any archive extraction. The AES-256-GCM authentication tag validates the ciphertext before any byte is unpacked.

Source evidence: Research audit Section 5 (Security Considerations), Q2 option A and B analysis.

### 6. Integrity Model

Four validation layers run in sequence at import time, before any live database is modified.

**Layer 1 — AES-256-GCM authentication tag** (encrypted bundles only): The authentication tag is verified before any archive extraction. Failure aborts with a decryption error. No bytes are written to disk.

**Layer 2 — Manifest hash verification**: Immediately upon reading `manifest.json`, compute SHA-256 of the manifest JSON with `integrity.manifestHash` set to `""` and compare to the stored value. Failure aborts with `E_MANIFEST_TAMPERED`. If the manifest cannot be trusted, all derived decisions (schema version checks, fingerprint checks) are unreliable.

**Layer 3 — Per-file SHA-256 checksum**: For each database file in `databases[]`, compute SHA-256 of the decompressed file bytes and compare to `databases[].sha256`. Failure on any file aborts with `E_CHECKSUM_MISMATCH`, reporting which file failed. No live database is modified.

**Layer 4 — SQLite PRAGMA integrity_check**: After extracting each `.db` file to a temporary staging directory, open it in read-only mode and run `PRAGMA integrity_check`. Failure on any database aborts with `E_CORRUPT_DATABASE`. The existing `validateSqliteDatabase` implementation at `packages/core/src/store/atomic.ts:183-201` provides this capability.

**Layer 5 — Schema version compatibility check** (see §9): Runs after all integrity layers pass.

**Layer 6 — Source machine fingerprint advisory**: Compare `backup.machineFingerprint` against the SHA-256 of the current machine's `machine-key`. A mismatch is expected for cross-machine restores and MUST be a warning, not an error. The warning is emitted to stderr and written to `.cleo/restore-conflicts.md`.

Verification ordering is strict: layers run in sequence 1 → 6. Failure at any layer aborts without touching the live tier.

Source evidence: Research audit Section 4 (Integrity Validation), layers 1–5 with specific file:line citations.

### 7. Restore Semantics: Abort with --force (Q3=A)

**Decision**: When live data exists at the target, import aborts by default. The `--force` flag bypasses the pre-check.

**Pre-check**: Before writing any file, scan the target for existing live data:

- Project tier: `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/conduit.db`, `.cleo/config.json`, `.cleo/project-info.json`, `.cleo/project-context.json`
- Global tier: `$XDG_DATA_HOME/cleo/nexus.db`, `$XDG_DATA_HOME/cleo/signaldock.db`

If any of the applicable files (based on `backup.scope`) exist, the command aborts with `E_DATA_EXISTS` (exit code 78) and prints the list of conflicting files. An empty `.cleo/` directory with none of the above files is considered a fresh install — no abort.

`cleo backup import <bundle> --force` bypasses the pre-check and proceeds to overwrite. Even with `--force`, the Q8 A/B regenerate-and-compare mechanism (§10) still runs for JSON files.

**Rationale (Q3=A)**: The abort default protects against accidental data loss and aligns with the ADR-013 §9 data-safety-first principle. Merge logic (research option D) is complex, requires a rekeying strategy for `tasks.db` ID collisions, and is explicitly deferred to a future epic.

Source evidence: Research audit Section 6 (Restore Modes, Mode 1 and Mode 2), Q3 decision record.

### 8. Always Include signaldock/conduit (Q4=A)

**Decision**: `conduit.db` and `signaldock.db` are always included in the bundle when the export scope covers the relevant tier. There is no opt-out flag for v1.

**Rationale (Q4=A)**: Agent credentials in `signaldock.db` are encrypted with `HMAC-SHA256(machine-key, project-path)` (per `packages/core/src/crypto/credentials.ts:136-141`). On the target machine, the `machine-key` differs, so all credential ciphertexts are unreadable anyway. Including the database does not create an exploitable security hole. Exclusion, however, destroys agent attachment history, custom project overrides, and the `project_agent_refs` rows in `conduit.db`, forcing full re-registration on every restore.

On import, the restore pipeline MUST:

1. Emit a re-auth warning to stderr: "Agent credentials are machine-bound. API keys encrypted on the source machine cannot be decrypted here. Re-authenticate all agents after restore: `cleo agent auth <id>`."
2. Write the same warning to `.cleo/restore-conflicts.md` under the "Agent credential re-auth required" section, listing each agent ID found in the restored `signaldock.db`.

The `global-salt` inclusion with `--scope global` is a separate security-sensitive action (see §4) and is subject to an additional warning about API key invalidation.

Source evidence: Research audit Section 5 (Security Considerations, credential ciphertext portability problem), Q4 decision record.

### 9. Schema Version Compatibility: Best-Effort with Warnings (Q5=C)

**Decision**: All imports are allowed regardless of schema version mismatch. Warnings are emitted when versions differ. Drizzle's migration pipeline handles forward reconciliation on first `cleo` invocation after restore.

**Comparison logic** (runs after integrity layers pass, per database in the bundle):

| Version relationship | Action |
|---------------------|--------|
| `import == local` | No warning. Proceed. |
| `import < local` (bundle is older) | WARNING: "Bundle is from an older cleo version; Drizzle will apply forward migrations on first open." Import proceeds. |
| `import > local` (bundle is newer) | WARNING: "Bundle is from a newer cleo version; some features may not be supported. Consider upgrading cleo." Import proceeds. |

All warnings are written to both `stderr` and `.cleo/restore-conflicts.md`. Drizzle's `migrate()` function runs automatically on first cleo invocation after restore via the existing migration pipeline — no new code required. The `reconcileJournal` function at `packages/core/src/store/migration-manager.ts:83-130` handles journal orphan detection for forward migrations.

**Rationale (Q5=C)**: Strict-equal (option A) would block every cross-version restore, which defeats the purpose of a backup. The research recommendation (option B: block on import-newer) was considered but the consensus chose option C because even a newer schema is reconcilable if the user upgrades cleo after import. Drizzle's additive migration system makes this safe.

Source evidence: Research audit Section 4 (Layer 4, Schema Version Compatibility Check), Q5 decision record.

### 10. Intelligent JSON Restore: A/B Regenerate-and-Compare (Q8=B+ EXTENDED)

**Decision**: JSON file restore uses intelligent A/B regenerate-and-compare with a 4-way field classification taxonomy, a structured conflict report, and an agent review loop. This is the critical new mechanism introduced by T311.

**Owner quote** (verbatim from T311 consensus): "restore but also the project-info.json and MUST include project-context.json too and need to have A/B intelligent regenerate and compare ensure the content is correct report out to agent for review on conflicts"

The three JSON files in scope for A/B comparison: `config.json`, `project-info.json`, `project-context.json`.

#### A/B Comparison Process

**Step 1 — Local regeneration (A)**: For each JSON file, run the local `cleo init` file generators in read-only dry-run mode (`--dry-run --emit <file>`) to produce what the file would look like if freshly initialized on the target machine. This captures machine-local values (resolved paths, machine-key-derived fields, hostname) as they exist on the target.

**Step 2 — Imported file (B)**: Parse the file as exported from the source machine from the `json/` directory in the tarball.

**Step 3 — Field-by-field classification**: Apply the 4-way taxonomy:

| Category | Applies to | Example fields | Resolution |
|----------|-----------|----------------|------------|
| Machine-local | all | `projectRoot`, `machineKey`, `hostname`, `cwd`, `createdAt`, `detectedAt`, absolute paths | A (local) |
| User intent | `config.json` | `enabledFeatures`, `brain.*`, `hooks`, `tools`, custom overrides | B (imported) |
| Project identity | `project-info.json` | `name`, `description`, `type`, `primaryType`, `tags` | B (imported) |
| Auto-detect | `project-context.json` | `testing.framework`, `build.command`, `directories.*`, `conventions.*`, `llmHints.*` | A if A == B, else A (current tool detection is more reliable than a stale import) |
| Unknown | any | any unclassified field | No default; written to conflict report for manual resolution |

**Step 4 — Resolution**: Apply the default resolutions for classified fields. Write a structured conflict report for all fields that differ, regardless of whether a default resolution applies.

**Step 5 — Conflict report**: Written to `.cleo/restore-conflicts.md`. Format:

```markdown
# T311 Import Conflict Report

Source bundle: <absolute path>
Source machine: <machineFingerprint from manifest>
Target machine: <sha256 of local machine-key>
Restored at: <ISO timestamp>

## config.json (N conflicts, M fields classified)

- Field: `brain.embeddingProvider`
  - Local regeneration (A): `"local"` (machine default)
  - Imported (B): `"openai"` (user-set on source machine)
  - Recommended: B (user intent)
  - Rationale: user intent field per T311 classification

## project-info.json (N conflicts)

- Field: `projectRoot`
  - Local regeneration (A): `"/mnt/projects/myproject"`
  - Imported (B): `"/home/user/projects/myproject"`
  - Recommended: A (machine-local)
  - Rationale: machine-local field; absolute path differs by machine

## project-context.json (N conflicts)

- Field: `testing.framework`
  - Local regeneration (A): `"vitest"`
  - Imported (B): `"vitest"`
  - Recommended: A (identical; no conflict)
  - Rationale: auto-detect field; values agree

## Agent credential re-auth required

The following agents are listed in signaldock.db but their API keys were
encrypted with the source machine's global-salt and will not decrypt on this
machine. Run `cleo agent auth <id>` to re-authenticate each:

- <agent-id-1>
- <agent-id-2>

## Schema compatibility warnings

- tasks.db: bundle schemaVersion 20260310000000, local schemaVersion 20260327000000
  WARNING: Bundle is from an older cleo version; Drizzle will apply forward
  migrations on first open.
```

**Step 6 — Non-destructive preservation**: The raw imported files are preserved under `.cleo/restore-imported/<filename>.json` for manual recovery, regardless of which resolution was applied to disk.

**Step 7 — Agent review loop**: After the conflict report is written and default resolutions are applied to disk, the import command exits with a non-zero exit code if any "Unknown" category fields were found (no default resolution available). The downstream agent or human operator reads `.cleo/restore-conflicts.md`, resolves the remaining conflicts, and runs `cleo restore finalize` to commit the pending resolutions.

**Step 8 — cleo restore finalize**: Reads the conflict report, applies any pending manual resolutions, and removes `.cleo/restore-conflicts.md` on successful completion.

**Implementation note**: The classification engine MUST be implemented in `packages/core/src/store/restore-json-merge.ts`. The `BackupManifest` TypeScript type MUST live in `packages/contracts/src/` per code quality rules.

Source evidence: T311 consensus Q8 decision record (verbatim owner quote and classification rules table), research audit Section 6 (Restore Modes).

### 11. CLI Surface

```
cleo backup export <name> [--scope project|global|all] [--encrypt] [--out <path>]
cleo backup import <bundle> [--force]
cleo backup inspect <bundle>
cleo restore finalize
```

**Defaults**: `--scope=project`, `--encrypt=off`, `--force=off`.

**cleo backup export**: Produces `<name>.cleobundle.tar.gz` (or `<name>.enc.cleobundle.tar.gz` with `--encrypt`). If `--out` is omitted, writes to the current directory.

**cleo backup import**: Verifies integrity (all 6 layers), runs the pre-check for live data (abort with `E_DATA_EXISTS` unless `--force`), extracts databases to a temporary staging directory, commits atomically via tmp-then-rename, then runs A/B regenerate-and-compare for JSON files (always, even with `--force`). Writes `.cleo/restore-conflicts.md` if any conflicts or warnings exist.

**cleo backup inspect**: Extracts and validates `manifest.json` only. Displays structured summary: scope, created-at, cleo version, source machine fingerprint, per-DB row counts and schema versions, and any schema compat warnings. Exits 0; makes no changes.

**cleo restore finalize**: Reads `.cleo/restore-conflicts.md`, applies pending manual resolutions from "Unknown" category fields, then removes the conflict report on success. This command is idempotent — if no pending resolutions exist, it exits 0 with a confirmation message.

Existing commands `cleo backup add` and `cleo restore backup` remain unchanged. The new export/import verbs are additive to the `cleo backup` subcommand family alongside the existing `add`, `list`, and `inspect`.

---

## Consequences

### Positive

- Cross-machine backup and restore is a first-class, single-artifact operation. A full project transfer requires transferring one `.cleobundle.tar.gz` file and running one command.
- Agents can migrate between developer machines with full task history, brain memory, and attachment metadata preserved.
- Opt-in encryption matches industry defaults (pg_dumpall, git bundle, tar). No passphrase friction for the common case; AES-256-GCM with Argon2id for users who need it.
- Abort-with-force default protects against accidental data loss on existing installations.
- A/B regenerate-and-compare eliminates the "which machine's absolute paths are correct" ambiguity that a naive file-copy restore would introduce.
- Conflict report and agent review loop enable delegated restore verification — an autonomous agent can read the report and apply safe resolutions without human intervention.
- Bundled JSON Schema means offline restores work with full manifest validation. No external URL dependency.
- The T310 topology is honored directly: `conduit.db` at the project tier and `signaldock.db` at the global tier are first-class members of the export scope.
- `cleo backup inspect` enables dry-run verification before any restore is committed.

### Negative

- **T310 hard dependency**: T311 cannot ship until T310 (v2026.4.12) lands on main. The export code must reference `conduit.db` and `signaldock.db` per the ADR-037 topology. See Cross-Epic Dependency section.
- **tar.gz is not encrypted by default**: `brain.db` and `tasks.db` travel as readable bytes in unencrypted bundles. `signaldock.db` credentials are already ciphertext but agent metadata (names, base URLs) is plaintext.
- **A/B regenerate-and-compare adds restore latency**: Running local `cleo init` generators in dry-run mode for three JSON files adds a measurable step to every import. The latency is bounded (< 2 seconds expected) but is non-zero.
- **Conflict report format is new**: Users and agents must learn the `.cleo/restore-conflicts.md` format. The `cleo restore finalize` workflow adds a second step to resolving "Unknown" category fields.
- **SQLite integrity_check on every restore**: For large databases (nexus.db at ~30 MB), `PRAGMA integrity_check` is not instantaneous. This slows large imports.
- **global-salt export is a security-sensitive operation**: Including `global-salt` in a `--scope global` bundle causes API key invalidation on the target machine. The current design relies on warnings rather than a mandatory second confirmation prompt. A future hardening pass SHOULD add a `--confirm-global-salt` explicit flag.
- **Re-auth required after restore**: All agents in the restored `signaldock.db` must be re-authenticated on the target machine. The KDF chain (`HMAC-SHA256(machine-key, project-path)`) is machine-bound per ADR-037 §5.
- **Merge mode deferred**: Row-level merge for `tasks.db` (option D in the research) is not implemented in v1. The abort-with-force model is the only restore mode for existing installations. Teams that need merge-style import must wait for a future epic.

---

## Alternatives Considered

### Alternative: zip format instead of tar.gz

zip provides Windows-native extraction without additional tools and random-access central-directory lookup (useful for reading `manifest.json` without extracting all DBs). The `yazl` + `yauzl` npm package pair is mature and pure JavaScript.

**Why rejected**: tar.gz is streaming and simpler for the packer/unpacker code path. The zip random-access manifest-read advantage is small because the tar.gz design mandates that `manifest.json` be the first entry in the archive, enabling sequential manifest extraction without reading all other entries. tar's sequential model is also more natural for streaming large databases. Research audit Section 2 evaluated both candidates as equivalent on compression ratio and ADR-010 compliance; tar.gz was chosen for ergonomics and lower implementation complexity.

### Alternative: tar.zst (Zstandard)

Zstandard achieves 45–55% compression with significantly faster decompression than gzip. Expected bundle size for a 39 MB input: 18–22 MB versus 20–25 MB for gzip.

**Why rejected**: All mature Node.js Zstandard implementations require native compilation (`@mongodb-js/zstd` via node-gyp; `zstd-napi` via NAPI). The pure-JS `fzstd` alternative is block-based and not fully streaming. ADR-010 mandates zero native-npm-dependencies for the core package. Unless ADR-010 is relaxed, tar.zst is blocked. Research audit Section 2, Candidate 3.

### Alternative: custom .cleobak format

A custom binary container (4-byte magic `CLEO`, version byte, length-prefixed manifest blob, length-prefixed file blobs, trailing SHA-256) gives full format control and can embed encryption and signing natively with zero external dependencies.

**Why rejected**: A `.cleobak` file cannot be opened by any OS-level tool. If cleo itself is broken or unavailable, the backup is inaccessible. Manual recovery (extracting individual databases for repair) is impossible without cleo. The implementation and maintenance cost (custom parser, writer, version migration) is high with no offsetting benefit over tar.gz. Research audit Section 2, Candidate 4.

### Alternative: encryption on by default

Encrypt all bundles with a mandatory passphrase, requiring users to supply a passphrase on every export and import.

**Why rejected**: Passphrase prompts break CI and automation workflows. The most sensitive data (`signaldock.db` credentials) is already machine-bound ciphertext and unreadable on the target machine regardless. Opt-in encryption (Q2=A) matches `pg_dumpall`, `git bundle`, and virtually all database backup tools. Research audit Section 5, Option B.

### Alternative: machine-key encryption (no passphrase)

Encrypt the bundle automatically using a key derived from the exporting machine's `machine-key`. No passphrase required.

**Why rejected**: This option is architecturally incompatible with cross-machine portability — the fundamental goal of T311. A bundle encrypted for machine A cannot be decrypted on machine B because the `machine-key` differs. Research audit Section 5, Option C.

### Alternative: merge mode on restore for existing data

Instead of aborting when live data exists, attempt to merge the imported data additively (Option D in research, Q3).

**Why rejected**: Row-level merge for `tasks.db` is fundamentally hard because the ID space is single-tenant (`T<N>` with a global sequence table). Two independent installations will collide on task IDs. Rekeying all imported task IDs (reassigning them to non-colliding values) is a substantial independent feature. Research audit Section 6, Mode 2 documents the conflict cases and explicitly defers full merge to a future epic.

### Alternative: exclude signaldock/conduit from exports

Exclude `signaldock.db` and `conduit.db` by default. Require the user to opt in with a `--with-credentials` flag.

**Why rejected**: Agent credentials are already machine-bound ciphertext — unreadable on the target regardless of bundle content. Exclusion loses attachment history, custom project overrides, and `project_agent_refs` rows in `conduit.db`, forcing full agent re-registration on every restore. Inclusion with a re-auth warning gives users the information they need without penalizing the common case. Q4=A decision record.

### Alternative: strict schema version matching

Block the import if any database schema version in the bundle differs from the local cleo installation's schema version.

**Why rejected**: Strict equality blocks every cross-version restore, which defeats the purpose of a backup. Drizzle's migration system handles forward-compatible additive changes safely on first open. Warnings preserve user awareness without requiring a cleo downgrade or upgrade before restoring. Q5=A was rejected in favor of Q5=C.

### Alternative: remote $schema URL for manifest

Point `manifest.json`'s `$schema` field to a published URL at `cleocode.dev/schemas/backup-manifest-v1.json`.

**Why rejected**: Offline restores break when the schema URL is unreachable. An external URL dependency is fragile for an operation that must work on air-gapped machines, CI environments without outbound HTTP, and developer machines with restricted network access. The bundled schema at `./schemas/manifest-v1.json` is functionally equivalent and requires no network access. Q6=A rejected; Q6=C chosen.

### Alternative: silent JSON overwrite on restore

Write the imported JSON files (`config.json`, `project-info.json`, `project-context.json`) directly to disk without comparison or conflict reporting.

**Why rejected**: Machine-local fields (`projectRoot`, `machineKey`, `hostname`, absolute paths) embedded in the imported files would break the target machine. A config with `projectRoot: "/home/user/projects/myproject"` from machine A is incorrect on machine B where the project lives at `"/mnt/projects/myproject"`. The A/B regenerate-and-compare is the minimal correct approach for handling machine-local versus user-intent field separation. Q8 options A, C, and D were all rejected by the owner in favor of the extended B+ mechanism.

---

## Implementation Tasks

| Task | Type | Description |
|------|------|-------------|
| T330 | consensus | Owner decisions recorded (complete) |
| T331 | adr | This ADR (complete) |
| T332 | specification | Bundle layout, JSON Schema v1, classification engine contract, CLI surface, exit code catalog |
| T333 | decomposition | Break T332 specification into atomic implementation subtasks |
| (generated) | implementation | Atomic code tasks per T333: packer, unpacker, inspect reader, CLI wiring, A/B classification engine, conflict report writer, restore finalize command |
| (generated) | testing | Round-trip integration tests: project scope, global scope, schema mismatch, corrupt archive, cross-machine simulation |
| (generated) | release | v2026.4.13 CalVer bump, changelog, npm publish, GitHub Release |

---

## Cross-Epic Dependency

T311 releases as **v2026.4.13**, which REQUIRES **v2026.4.12 (T310)** to be shipped and merged to main first.

The T311 export code MUST reference:
- Project tier: `.cleo/conduit.db` (NEW file per ADR-037; does not exist before T310 ships)
- Global tier: `$XDG_DATA_HOME/cleo/signaldock.db` (moved to global tier per ADR-037; does not exist at global tier before T310 ships)
- Global-salt file: `$XDG_DATA_HOME/cleo/global-salt` (NEW per ADR-037 §5)

**Integration risk**: If T311 implementation begins before T310 lands on main, the export code paths MUST conditionally detect whether `conduit.db` exists at the project tier (T310 shipped) versus whether `signaldock.db` still exists at the project tier (T310 not yet shipped). This conditional is a technical debt flag — the T332 specification MUST document the feature gate or conditional check required, and T333 MUST produce a subtask that removes the conditional once T310 is confirmed on main.

The T311 specification (T332) and decomposition (T333) MUST explicitly document this dependency and MUST NOT produce implementation tasks that assume T310 is live until T310's release mechanics are confirmed complete.

---

## References

- **ADR-036 §Cross-Machine Portability** — pointed to T311 as the follow-on and sketched the initial tarball concept
- **ADR-037** — Conduit + Signaldock Separation (hard dependency; topology that defines conduit.db and global signaldock.db)
- **ADR-013 §9** — Data-safety-first principle (abort-with-force restore default traces directly to this)
- **ADR-010** — Zero-native-npm-dependencies mandate (rules out tar.zst; validates tar.gz choice)
- **`.cleo/research/T311-backup-portability-audit.md`** — Full research phase: format options, manifest schema, integrity validation, security, restore modes, CLI surface
- **`.cleo/consensus/T311-consensus.md`** — 8 owner decisions recorded verbatim; this ADR implements them formally
- **`packages/core/src/store/sqlite-backup.ts`** — Existing VACUUM INTO pipeline (baseline this ADR extends)
- **`packages/core/src/store/atomic.ts:183-201`** — `validateSqliteDatabase` using PRAGMA integrity_check (reused by Layer 4)
- **`packages/core/src/crypto/credentials.ts:136-141`** — `deriveProjectKey` HMAC-SHA256 (machine-binding rationale for re-auth warning)
- **`packages/core/src/store/migration-manager.ts:83-130`** — `reconcileJournal` (Drizzle forward migration on restore)
