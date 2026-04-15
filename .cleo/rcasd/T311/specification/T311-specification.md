---
task: T332
epic: T311
type: specification
pipeline_stage: specification
feeds_into: [T311-decomposition, T311-implementation]
depends_on: [T330, T331]
cross_epic_dependency: T310 (v2026.4.12 must ship before T311 v2026.4.13)
related_adr: ADR-038
created: 2026-04-08
---

# T311 Specification: Cross-Machine Backup Portability

> Formalizes ADR-038 into testable contracts. Bundle layout, JSON Schema,
> classification engine, CLI surface, test scenarios. Implementation must
> honor every contract here.

---

## 1. Scope

### In scope (v2026.4.13)

- tar.gz `.cleobundle` format (Q1=A)
- `manifest.json` with bundled JSON Schema Draft 2020-12 (Q6=C)
- SHA-256 integrity per file + manifest self-hash
- `cleo backup export <name> [--scope project|global|all] [--encrypt] [--out <path>]`
- `cleo backup import <bundle> [--force]`
- `cleo backup inspect <bundle>`
- `cleo restore finalize`
- Opt-in Argon2id + AES-256-GCM encryption (Q2=A)
- Abort-with-force restore semantics (Q3=A, ADR-038 §7)
- Always-include conduit.db + signaldock.db per T310 topology (Q4=A)
- Best-effort schema compat with warnings — no import block (Q5=C)
- A/B regenerate-and-compare for JSON restore (Q8=B+, ADR-038 §10)
- `.cleo/restore-conflicts.md` generation
- `.cleo/restore-imported/` raw-file preservation directory
- Schema version warnings (ADR-038 §9)
- Agent re-auth warning emission when signaldock.db is in bundle
- `BackupManifest` TypeScript type in `packages/contracts/src/`
- Unit + integration test suite

### Out of scope (explicitly deferred)

- Merge mode for restore (option D from research) — abort+force only in v1
- Redaction mode (stripping signaldock.db credentials before export)
- Cloud-based or remote backup
- Differential or incremental backups
- Automatic multi-machine sync
- `--confirm-global-salt` explicit second confirmation for global-salt export

### T310 hard dependency

**T311 CANNOT ship before T310 (v2026.4.12).** The export code references:

- `.cleo/conduit.db` at project tier (new in T310; ADR-037 Q5=A)
- `$XDG_DATA_HOME/cleo/signaldock.db` at global tier (moved in T310; ADR-037)
- `$XDG_DATA_HOME/cleo/global-salt` (new in T310; ADR-037 Q3=C)

If implementation begins before T310 lands, the export code MUST conditionally
detect whether `conduit.db` exists (T310 shipped) or `signaldock.db` still
exists at project tier (T310 not yet shipped) and emit a
`T310-migration-required` error. T333 decomposition MUST include a
T310-readiness-check subtask as the FIRST implementation task, with a
follow-up subtask to remove the conditional guard once T310 is confirmed
on main.

---

## 2. Bundle Layout

```
<name>.cleobundle.tar.gz             -- unencrypted bundle
<name>.enc.cleobundle.tar.gz         -- encrypted bundle (AES-256-GCM)

Tarball contents (after decryption if applicable):
  manifest.json                      -- MUST be FIRST entry in archive
  schemas/
    manifest-v1.json                 -- JSON Schema Draft 2020-12 (bundled)
  databases/
    tasks.db                         -- project tier (--scope project|all)
    brain.db                         -- project tier (--scope project|all)
    conduit.db                       -- project tier (--scope project|all, per ADR-037)
    nexus.db                         -- global tier  (--scope global|all)
    signaldock.db                    -- global tier  (--scope global|all, per ADR-037)
  json/
    config.json                      -- project tier (--scope project|all)
    project-info.json                -- project tier (--scope project|all)
    project-context.json             -- project tier (--scope project|all, Q8 EXTENDED)
  global/
    global-salt                      -- global tier  (--scope global|all, WARNING on export AND import)
  checksums.sha256                   -- one GNU-format line per file
```

### Layout rules

1. `manifest.json` MUST be written as the first tar entry to enable efficient
   `cleo backup inspect` that extracts only the manifest without reading the
   entire archive (ADR-038 §1 rationale).
2. Files absent from the export scope MUST NOT be written into the archive.
   The manifest `databases` and `json` arrays reflect exactly what was included.
3. `global/global-salt` is included ONLY with `--scope global` or `--scope all`.
   Its presence MUST trigger an explicit WARNING at both export time and import
   time (see §5.1 and §5.2).
4. The `checksums.sha256` file covers all files except itself and `manifest.json`
   (the manifest is covered by `integrity.manifestHash` — see §4.1).
5. Scope-to-files mapping:

   | `--scope` | `databases/` entries | `json/` entries | `global/` entries |
   |-----------|----------------------|-----------------|-------------------|
   | `project` | tasks.db, brain.db, conduit.db | config.json, project-info.json, project-context.json | (none) |
   | `global`  | nexus.db, signaldock.db | (none) | global-salt |
   | `all`     | tasks.db, brain.db, conduit.db, nexus.db, signaldock.db | config.json, project-info.json, project-context.json | global-salt |

---

## 3. Manifest Schema (manifest.json)

### 3.1 File location in bundle

`manifest.json` at the bundle root. It references the bundled schema via:

```json
{
  "$schema": "./schemas/manifest-v1.json",
  "manifestVersion": "1.0.0",
  ...
}
```

The value `"./schemas/manifest-v1.json"` is a relative path from the bundle
root — never a remote URL. This is the Q6=C decision: bundled path, offline
safe, IDE-validated.

### 3.2 JSON Schema (bundled at schemas/manifest-v1.json)

The schema below is the canonical v1 contract. Any manifest produced by
`cleo backup export` MUST validate against this schema. Any importer MUST
validate the received manifest against the bundled copy of this schema before
processing any field.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://cleocode.dev/schemas/backup-manifest-v1.json",
  "title": "CLEO Backup Manifest v1",
  "type": "object",
  "required": ["$schema", "manifestVersion", "backup", "databases", "json", "integrity"],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string",
      "const": "./schemas/manifest-v1.json"
    },
    "manifestVersion": {
      "type": "string",
      "pattern": "^1\\.\\d+\\.\\d+$",
      "description": "Semantic version of the manifest format. Breaking changes increment major."
    },
    "backup": {
      "type": "object",
      "required": ["createdAt", "createdBy", "scope", "machineFingerprint", "cleoVersion", "encrypted"],
      "additionalProperties": false,
      "properties": {
        "createdAt": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 UTC timestamp when the bundle was created."
        },
        "createdBy": {
          "type": "string",
          "description": "Human-readable cleo version string, e.g. 'cleo v2026.4.13'."
        },
        "scope": {
          "type": "string",
          "enum": ["project", "global", "all"],
          "description": "Export scope. Determines target restore paths."
        },
        "projectName": {
          "type": "string",
          "description": "Project name at export time. Advisory only."
        },
        "projectFingerprint": {
          "type": ["string", "null"],
          "pattern": "^[a-f0-9]{64}$",
          "description": "SHA-256 of project-info.json at export time. Null for global-only scope. Advisory warning if mismatch on import."
        },
        "machineFingerprint": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$",
          "description": "SHA-256 of $XDG_DATA_HOME/cleo/machine-key. Privacy-safe machine identity proxy."
        },
        "cleoVersion": {
          "type": "string",
          "description": "Machine-parseable CalVer string, e.g. '2026.4.13'."
        },
        "encrypted": {
          "type": "boolean",
          "description": "True if this bundle was produced with --encrypt."
        }
      }
    },
    "databases": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "required": ["name", "filename", "size", "sha256", "schemaVersion"],
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
            "enum": ["tasks", "brain", "conduit", "nexus", "signaldock"],
            "description": "Logical database name."
          },
          "filename": {
            "type": "string",
            "description": "Relative path inside the archive, e.g. 'databases/tasks.db'."
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "description": "Byte size of the decompressed .db file."
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$",
            "description": "SHA-256 hex of the decompressed .db bytes."
          },
          "schemaVersion": {
            "type": "string",
            "description": "Latest applied migration identifier (Drizzle folderMillis or SIGNALDOCK_SCHEMA_VERSION)."
          },
          "rowCounts": {
            "type": "object",
            "description": "Per-table row counts for inspect display. Optional at import time.",
            "additionalProperties": {
              "type": "integer",
              "minimum": 0
            }
          }
        }
      }
    },
    "json": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "required": ["filename", "size", "sha256"],
        "additionalProperties": false,
        "properties": {
          "filename": {
            "type": "string",
            "enum": [
              "json/config.json",
              "json/project-info.json",
              "json/project-context.json"
            ],
            "description": "Relative path inside the archive."
          },
          "size": {
            "type": "integer",
            "minimum": 0
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        }
      }
    },
    "globalFiles": {
      "type": "array",
      "minItems": 0,
      "items": {
        "type": "object",
        "required": ["filename", "size", "sha256"],
        "additionalProperties": false,
        "properties": {
          "filename": {
            "type": "string",
            "enum": ["global/global-salt"],
            "description": "Relative path inside the archive."
          },
          "size": {
            "type": "integer",
            "minimum": 0
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        }
      }
    },
    "integrity": {
      "type": "object",
      "required": ["algorithm", "checksumsFile", "manifestHash"],
      "additionalProperties": false,
      "properties": {
        "algorithm": {
          "type": "string",
          "const": "sha256"
        },
        "checksumsFile": {
          "type": "string",
          "const": "checksums.sha256"
        },
        "manifestHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$",
          "description": "SHA-256 of this manifest JSON with manifestHash set to empty string, then hex-encoded."
        }
      }
    }
  }
}
```

### 3.3 Example manifest.json

The following is a complete, populated example for a `--scope project` export.
Implementers should use this as a reference for field names, types, and structure.

```json
{
  "$schema": "./schemas/manifest-v1.json",
  "manifestVersion": "1.0.0",
  "backup": {
    "createdAt": "2026-04-13T09:14:55Z",
    "createdBy": "cleo v2026.4.13",
    "scope": "project",
    "projectName": "cleocode",
    "projectFingerprint": "a3f8b2c1d4e5f6078901234567890abcdef1234567890abcdef1234567890ab",
    "machineFingerprint": "9b8a7c6d5e4f3021ba987654321fedcba9876543210fedcba9876543210fedc",
    "cleoVersion": "2026.4.13",
    "encrypted": false
  },
  "databases": [
    {
      "name": "tasks",
      "filename": "databases/tasks.db",
      "size": 5242880,
      "sha256": "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7f80912a3b4c5d6e7f8",
      "schemaVersion": "20260327000000",
      "rowCounts": {
        "tasks": 312,
        "sessions": 14,
        "phases": 3
      }
    },
    {
      "name": "brain",
      "filename": "databases/brain.db",
      "size": 2097152,
      "sha256": "2b3c4d5e6f7081929a3b4c5d6e7f80901a2b3c4d5e6f708192a3b4c5d6e7f",
      "schemaVersion": "20260321000001",
      "rowCounts": {
        "observations": 48,
        "patterns": 9,
        "learnings": 13
      }
    },
    {
      "name": "conduit",
      "filename": "databases/conduit.db",
      "size": 1048576,
      "sha256": "3c4d5e6f708192a3b4c5d6e7f801920a1b2c3d4e5f6708192a3b4c5d6e7f8",
      "schemaVersion": "20260401000000",
      "rowCounts": {
        "project_agent_refs": 5
      }
    }
  ],
  "json": [
    {
      "filename": "json/config.json",
      "size": 2048,
      "sha256": "4d5e6f708192a3b4c5d6e7f8019203a4b5c6d7e8f90192a3b4c5d6e7f80192"
    },
    {
      "filename": "json/project-info.json",
      "size": 512,
      "sha256": "5e6f708192a3b4c5d6e7f801920304a5b6c7d8e9f0192a3b4c5d6e7f8019203"
    },
    {
      "filename": "json/project-context.json",
      "size": 1024,
      "sha256": "6f708192a3b4c5d6e7f8019203040506a7b8c9d0e1f2a3b4c5d6e7f80192030"
    }
  ],
  "globalFiles": [],
  "integrity": {
    "algorithm": "sha256",
    "checksumsFile": "checksums.sha256",
    "manifestHash": "7081929a3b4c5d6e7f80192030405060708192a3b4c5d6e7f8019203040506"
  }
}
```

---

## 4. Integrity Model

### 4.1 checksums.sha256 format

One entry per line, GNU sha256sum-compatible format. Two spaces between hash
and filename. Paths are relative to the bundle root.

```
1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5d6e7f80912a3b4c5d6e7f8  databases/tasks.db
2b3c4d5e6f7081929a3b4c5d6e7f80901a2b3c4d5e6f708192a3b4c5d6e7f  databases/brain.db
3c4d5e6f708192a3b4c5d6e7f801920a1b2c3d4e5f6708192a3b4c5d6e7f8  databases/conduit.db
4d5e6f708192a3b4c5d6e7f8019203a4b5c6d7e8f90192a3b4c5d6e7f80192  json/config.json
5e6f708192a3b4c5d6e7f801920304a5b6c7d8e9f0192a3b4c5d6e7f8019203  json/project-info.json
6f708192a3b4c5d6e7f8019203040506a7b8c9d0e1f2a3b4c5d6e7f80192030  json/project-context.json
abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890  schemas/manifest-v1.json
```

Hashes cover decompressed file bytes (not compressed stream bytes). This
allows integrity verification independent of re-compression during transfer.

`manifest.json` itself is NOT listed in `checksums.sha256`; its integrity is
guaranteed by the `integrity.manifestHash` field within the manifest (SHA-256
of manifest JSON with `manifestHash` set to `""`).

### 4.2 Verification sequence on import

The six layers run in strict order. Failure at any layer aborts without
touching any live file.

| Layer | When | What | Failure |
|-------|------|------|---------|
| 1 | Encrypted bundles only — before unpack | AES-256-GCM auth tag verification | E_BUNDLE_DECRYPT (70) |
| 2 | Immediately after reading manifest.json | Recompute SHA-256 of manifest (manifestHash="" substitution); compare to integrity.manifestHash | E_MANIFEST_TAMPERED (note: exit 71 per §4.3) |
| 3 | After unpacking to tmp dir | Validate manifest.json against schemas/manifest-v1.json | E_BUNDLE_SCHEMA (71) |
| 4 | For each file in checksums.sha256 | Compute SHA-256 of decompressed bytes; compare to checksums.sha256 entry | E_CHECKSUM_MISMATCH (72) |
| 5 | For each .db file in tmp dir | Open read-only; run PRAGMA integrity_check | E_SQLITE_INTEGRITY (73) |
| 6 | After layers 1-5 pass | Compare databases[].schemaVersion to local Drizzle migration max; emit warnings if mismatch | WARNING only (no abort, Q5=C) |

Layer 2 and Layer 3 ordering detail: manifest integrity hash check (Layer 2)
runs first before schema validation (Layer 3) because if the manifest has been
tampered with, the schema reference itself is untrusted.

### 4.3 Exit codes

All new exit codes are in the 70-79 range to avoid collision with existing
cleo exit codes.

| Code | Symbol | Meaning |
|------|--------|---------|
| 0  | success | Import / export / inspect completed without error |
| 70 | E_BUNDLE_DECRYPT | AES-256-GCM auth tag invalid (wrong passphrase or corrupted ciphertext) |
| 71 | E_BUNDLE_SCHEMA | manifest.json does not validate against schemas/manifest-v1.json, OR manifest hash mismatch |
| 72 | E_CHECKSUM_MISMATCH | File SHA-256 does not match checksums.sha256 entry; reports which file |
| 73 | E_SQLITE_INTEGRITY | PRAGMA integrity_check failed on a .db file; reports which file |
| 74 | E_MANIFEST_MISSING | manifest.json absent from tarball |
| 75 | E_SCHEMAS_MISSING | schemas/manifest-v1.json absent from tarball (corrupted bundle) |
| 76 | E_SCHEMA_NEWER | Bundle DB schema version newer than local cleo (WARNING only — does not abort, Q5=C) |
| 77 | E_SCHEMA_OLDER | Bundle DB schema version older than local cleo (WARNING only — does not abort, Q5=C) |
| 78 | E_DATA_EXISTS | Target has live data; --force not provided (Q3=A) |
| 79 | E_RESTORE_PARTIAL | Restore wrote some files then failed mid-sequence; conflicts file preserved |

Exit codes 76 and 77 are WARNING-only: the process exits 0 after emitting the
warning to stderr and writing it to `.cleo/restore-conflicts.md`. They are
listed here to document the warning classification.

---

## 5. CLI Contracts

### 5.1 cleo backup export

```
cleo backup export <name> [options]

Arguments:
  name                      Base name for the bundle file (no extension needed)

Options:
  --scope <project|global|all>
                            Which tier to export. Default: project.
  --encrypt                 Prompt for passphrase; encrypt bundle with
                            Argon2id + AES-256-GCM. Default: off (Q2=A).
  --out <path>              Output path for the bundle file.
                            Default: ./<name>.cleobundle.tar.gz
                            (or ./<name>.enc.cleobundle.tar.gz with --encrypt)

Exit: 0 on success. Non-zero on filesystem error or DB access failure.

Behavior:
  1. Resolve project root (for --scope project|all) or global XDG home
     (for --scope global|all).
  2. T310 readiness check: verify conduit.db exists at project tier;
     if not and signaldock.db exists at project tier, abort with message
     "T310 migration required before export; run cleo to trigger migration."
  3. VACUUM INTO snapshot for each in-scope DB to a tmp staging dir.
     Uses os.tmpdir()/cleo-export-<uuid>/.
  4. Copy in-scope JSON files (config.json, project-info.json,
     project-context.json) to tmp dir under json/.
  5. Copy global-salt to tmp dir under global/ for --scope global|all.
     EMIT WARNING to stderr:
     "WARNING: global-salt included in bundle. Importing this bundle on another
      machine will invalidate all agent API keys on that machine. Agents will
      require re-authentication after import."
  6. Compute SHA-256 for each staged file.
  7. Write checksums.sha256 to tmp dir.
  8. Compute projectFingerprint (SHA-256 of project-info.json bytes) and
     machineFingerprint (SHA-256 of $XDG_DATA_HOME/cleo/machine-key).
  9. Collect schemaVersion for each DB (MAX(created_at) from
     __drizzle_migrations, or SIGNALDOCK_SCHEMA_VERSION for signaldock.db).
 10. Collect rowCounts per table for each DB.
 11. Write manifest.json (with manifestHash="") to tmp dir; compute its
     SHA-256; re-write manifest.json with the computed manifestHash value.
 12. Copy embedded schemas/manifest-v1.json from build-time asset into
     tmp dir under schemas/.
 13. Create tar.gz archive from tmp dir contents, with manifest.json as
     the FIRST entry.
 14. If --encrypt:
       a. Prompt passphrase (twice for confirmation).
       b. Generate 32-byte random Argon2id salt.
       c. Derive 32-byte AES key: Argon2id(passphrase, salt, t=3, m=65536, p=4).
       d. Generate 12-byte random GCM nonce.
       e. Encrypt tar.gz stream with AES-256-GCM.
       f. Write encrypted bundle to --out path.
 15. Write final bundle to --out path.
 16. Remove tmp staging dir.
 17. Log to stdout: "Bundle written to <path> (<size> bytes, <N> files)"
```

### 5.2 cleo backup import

```
cleo backup import <bundle> [options]

Arguments:
  bundle                    Path to .cleobundle.tar.gz or
                            .enc.cleobundle.tar.gz file

Options:
  --force                   Bypass E_DATA_EXISTS pre-check (Q3=A).
                            JSON A/B comparison still runs even with --force.

Exit: 0 on success (even with conflicts — operator reviews restore-conflicts.md).
     Non-zero on fatal error (70-75, 78, 79).

Behavior:
  1. Pre-check (unless --force):
       Scan target for existing live files per scope:
         project tier: .cleo/tasks.db, .cleo/brain.db, .cleo/conduit.db,
                       .cleo/config.json, .cleo/project-info.json,
                       .cleo/project-context.json
         global tier:  $XDG_DATA_HOME/cleo/nexus.db,
                       $XDG_DATA_HOME/cleo/signaldock.db
       An empty .cleo/ dir with none of the above is treated as fresh.
       If ANY applicable file exists → abort E_DATA_EXISTS (78); print list.
  2. Detect encryption from extension:
       .enc.cleobundle.tar.gz → prompt passphrase → decrypt (see §7.4)
       .cleobundle.tar.gz → proceed directly
  3. Unpack tarball to tmp dir: os.tmpdir()/cleo-restore-<uuid>/
  4. Integrity verification (all 6 layers from §4.2 in sequence).
     Abort with appropriate exit code on any failure.
  5. Emit schema version warnings for each DB version mismatch (Q5=C).
     Write warnings to both stderr and .cleo/restore-conflicts.md.
  6. Copy each .db file from tmp to its target path using atomic
     tmp-then-rename. Clear any stale .db-wal and .db-shm sidecars at target.
  7. For each JSON file (config.json, project-info.json, project-context.json):
       Run A/B regenerate-and-compare (see §6).
  8. Write .cleo/restore-conflicts.md with:
       - JSON field conflicts and resolutions
       - Agent re-auth warnings (if signaldock.db in bundle)
       - Schema version warnings (if any version mismatch)
       - Machine fingerprint advisory (if source != target machine)
  9. Move raw imported JSON files to .cleo/restore-imported/:
       .cleo/restore-imported/config.json
       .cleo/restore-imported/project-info.json
       .cleo/restore-imported/project-context.json
 10. Remove tmp staging dir.
 11. Log to stdout:
       "Restore complete. Review .cleo/restore-conflicts.md for <N> conflicts."
     If N > 0 and any are 'manual-review' category → exit code non-zero:
       "Restore complete with <N> unresolved conflicts. Run 'cleo restore finalize'
        after resolving .cleo/restore-conflicts.md."
```

### 5.3 cleo backup inspect

```
cleo backup inspect <bundle>

Arguments:
  bundle                    Path to .cleobundle.tar.gz or
                            .enc.cleobundle.tar.gz file

Exit: 0 always (read-only; no changes made).

Behavior:
  1. Detect encryption from extension.
     If .enc.cleobundle.tar.gz: report "Bundle is encrypted. Passphrase
     required to decrypt. Manifest cannot be read without decryption."
     Then exit 0 with the encryption report only.
  2. Extract manifest.json ONLY from tarball (streaming — stop after
     first entry; manifest MUST be first per §2 rule 1).
  3. Verify integrity.manifestHash against manifest content.
     If mismatch: report tamper warning but do NOT exit non-zero.
  4. Validate manifest.json against schemas/manifest-v1.json
     (embedded in the importer binary, not extracted from the bundle).
  5. Print structured report to stdout:
       Bundle: <path>
       Format: CLEO Backup Bundle v<manifestVersion>
       Scope: <scope>
       Created: <createdAt> by <createdBy>
       Encrypted: <yes|no>
       Source machine: <machineFingerprint> (<same|different> as this machine)
       Project: <projectName> (<projectFingerprint>)

       Databases:
         tasks.db        5.0 MB   schema: 20260327000000   tasks: 312, sessions: 14
         brain.db        2.0 MB   schema: 20260321000001   observations: 48
         conduit.db      1.0 MB   schema: 20260401000000   project_agent_refs: 5

       JSON files:
         config.json     2.0 KB
         project-info.json  512 B
         project-context.json  1.0 KB

       Schema compatibility:
         tasks.db: bundle 20260327000000, local 20260327000000  [OK]
         brain.db: bundle 20260321000001, local 20260327000000  [OLDER — Drizzle will migrate]
         conduit.db: bundle 20260401000000, local 20260327000000  [NEWER — upgrade cleo recommended]

       Manifest integrity: [OK|TAMPERED]
  6. Do NOT extract databases, JSON files, or any other file.
     Do NOT write anything to disk.
```

### 5.4 cleo restore finalize

```
cleo restore finalize

Exit: 0 always (idempotent).

Behavior:
  1. Check for .cleo/restore-conflicts.md. If absent:
       Log "No pending restore conflicts. Nothing to finalize."
       Exit 0.
  2. Parse the conflict report for fields with Resolution: manual-review
     that have been edited by the operator (detected by presence of
     "RESOLVED:" prefix replacing "Resolution: manual-review").
  3. Apply each resolved field to its target file on disk.
  4. Archive the conflict report to:
       .cleo/restore-conflicts-<ISO-timestamp>.md.finalized
  5. Remove .cleo/restore-conflicts.md.
  6. Log: "Finalized <N> conflict resolutions. Conflict report archived."

If no manually-resolved fields exist, exits with:
  "No manual resolutions found in .cleo/restore-conflicts.md.
   Edit the file to mark resolutions, then re-run 'cleo restore finalize'."
```

### 5.5 Existing commands unchanged

`cleo backup add`, `cleo backup list`, and `cleo restore backup` remain
unchanged. The new export/import/inspect verbs are additive to the
`cleo backup` subcommand family.

---

## 6. A/B Regenerate-and-Compare Engine

### 6.1 Module location

`packages/core/src/store/restore-json-merge.ts`

The `BackupManifest` TypeScript type MUST live in `packages/contracts/src/`
per code quality rules (no inline type definitions in implementation files).

### 6.2 TypeScript interfaces

```typescript
/**
 * Input descriptor for one JSON file in an A/B regenerate-and-compare operation.
 */
export interface JsonRestoreInput {
  /** Which of the three managed JSON files is being compared. */
  filename: 'config.json' | 'project-info.json' | 'project-context.json';
  /** Parsed content of the imported file (B — from bundle json/ directory). */
  imported: unknown;
  /** Absolute path to the project root (used by dry-run regenerators). */
  projectRoot: string;
}

/**
 * Classification and resolution for a single field path.
 */
export interface FieldClassification {
  /** JSON dot-path of the field, e.g. "brain.embeddingProvider" or "testing.framework". */
  path: string;
  /** Value from local regeneration (A). */
  local: unknown;
  /** Value from imported bundle (B). */
  imported: unknown;
  /**
   * Taxonomy category per §6.3 classification rules.
   * 'identical' means JSON.stringify(A) === JSON.stringify(B) — no conflict.
   */
  category:
    | 'identical'
    | 'machine-local'
    | 'user-intent'
    | 'project-identity'
    | 'auto-detect'
    | 'unknown';
  /**
   * The resolution applied (or to be applied) to disk.
   * 'A' = use local value; 'B' = use imported value; 'manual-review' = operator must decide.
   */
  resolution: 'A' | 'B' | 'manual-review';
  /** Human-readable explanation for the resolution. */
  rationale: string;
}

/**
 * Complete A/B comparison result for one JSON file.
 */
export interface JsonRestoreReport {
  /** Which file was compared. */
  filename: string;
  /** The locally regenerated object (A). */
  localGenerated: unknown;
  /** The imported object (B). */
  imported: unknown;
  /** Per-field classification results. Only differs fields are included for identical category. */
  classifications: FieldClassification[];
  /** The final merged object written to disk (applying all resolutions). */
  applied: unknown;
  /** Count of fields with resolution 'manual-review' (no auto-resolution). */
  conflictCount: number;
}

/**
 * Run A/B regenerate-and-compare for a single JSON file.
 *
 * Does NOT write to disk. Returns the report; caller writes `applied` to disk
 * and the raw imported file to .cleo/restore-imported/.
 *
 * @param input  Comparison input (filename, imported content, project root)
 * @returns      Full classification report including the applied merge result
 */
export function regenerateAndCompare(input: JsonRestoreInput): JsonRestoreReport;
```

### 6.3 Classification rules

These rules implement the Q8=B+ (EXTENDED) decision from T311 consensus.
The table is the authoritative resolution contract; implementation must match
exactly.

| Category | Applies to | Example fields | Default resolution |
|----------|-----------|----------------|--------------------|
| Machine-local | all three files | `projectRoot`, `machineKey`, `hostname`, `cwd`, `createdAt`, `detectedAt`, any string value that is an absolute filesystem path (`/` prefix on Unix, drive letter on Windows) | **A** (local regenerated) |
| User intent | `config.json` only | `enabledFeatures`, `brain.*`, `hooks`, `tools`, any field not present in a fresh regeneration that was explicitly set by the user | **B** (imported) |
| Project identity | `project-info.json` only | `name`, `description`, `type`, `primaryType`, `tags` | **B** (imported) |
| Auto-detect | `project-context.json` only | `testing.framework`, `testing.command`, `build.command`, `directories.*`, `conventions.*`, `llmHints.*` | **A** if `JSON.stringify(A) === JSON.stringify(B)`, else **A** (current tool detection is always preferred over a potentially stale import) |
| Identical | any | any field where `JSON.stringify(A) === JSON.stringify(B)` | no-op (not written to conflict report) |
| Unknown | any | any field not matching the rules above | **manual-review** (written to conflict report; no auto-resolution applied; file written with local value (A) as safe default until operator resolves) |

Resolution precedence: identical > machine-local > user-intent > project-identity > auto-detect > unknown.
If a field matches multiple categories, the first matching category in the precedence order wins.

### 6.4 Local regeneration (A)

For each of the three files, the module uses the existing `cleo init` file
generators in a read-only dry-run mode:

```typescript
/**
 * Regenerate config.json as it would look on the target machine.
 * MUST NOT write to disk. Returns the parsed object.
 */
export function regenerateConfigJson(projectRoot: string): Record<string, unknown>;

/**
 * Regenerate project-info.json as it would look on the target machine.
 * MUST NOT write to disk. Returns the parsed object.
 */
export function regenerateProjectInfoJson(projectRoot: string): Record<string, unknown>;

/**
 * Regenerate project-context.json as it would look on the target machine
 * (runs tool detection: testing framework, build commands, etc.).
 * MUST NOT write to disk. Returns the parsed object.
 */
export function regenerateProjectContextJson(projectRoot: string): Record<string, unknown>;
```

These functions are in `packages/core/src/store/regenerators.ts`.
T333 decomposition MUST produce a subtask that decides whether to refactor
existing `cleo init` code to expose these dry-run generators, or to factor
out a new shared module. They MUST NOT call `cleo init` as a child process.

### 6.5 Conflict report format (.cleo/restore-conflicts.md)

```markdown
# CLEO Import Conflict Report

**Source bundle**: /path/to/myproject.cleobundle.tar.gz
**Source machine**: 9b8a7c6d5e4f3021ba987654321fedcba9876543210fedcba9876543210fedc
**Target machine**: c3d4e5f6708192a3b4c5d6e7f8019203a4b5c6d7e8f90192a3b4c5d6e7f80
**Restored at**: 2026-04-13T09:22:10Z
**Cleo version (import)**: 2026.4.13

---

## config.json

_5 fields classified, 1 conflict._

### Resolved (auto-applied)

- `brain.embeddingProvider`
  - Local (A): `"local"`
  - Imported (B): `"openai"`
  - Resolution: **B** (user intent)
  - Rationale: user intent field per T311 classification rules

### Manual review needed

- `hooks.customPreCommit`
  - Local (A): _(absent)_
  - Imported (B): `"./scripts/pre-commit.sh"`
  - Resolution: **manual-review**
  - Rationale: unknown category; no auto-resolution rule applies
  - RESOLVED: (edit this line to set 'A', 'B', or a custom value, then run 'cleo restore finalize')

---

## project-info.json

_3 fields classified, 0 conflicts._

All fields auto-resolved (no manual review needed).

---

## project-context.json

_8 fields classified, 0 conflicts._

All fields auto-resolved (no manual review needed).

---

## Agent re-authentication required

The following agents in `signaldock.db` were encrypted with the source
machine's `global-salt` and cannot be decrypted on this machine.
Run `cleo agent auth <id>` to re-authenticate each:

- cleo-prime
- cleo-researcher

---

## Schema compatibility warnings

- `brain.db`: bundle schemaVersion `20260321000001`, local `20260327000000`
  - Status: bundle is OLDER; Drizzle will apply forward migrations on first open.
- `conduit.db`: bundle schemaVersion `20260601000000`, local `20260401000000`
  - **WARNING**: bundle schema is NEWER than local. Upgrade cleo for full support.
```

### 6.6 Preservation directory

Imported raw JSON files are MOVED (not copied) to `.cleo/restore-imported/`
after the conflict report is written. They are preserved regardless of which
resolution was applied.

```
.cleo/restore-imported/
  config.json             -- raw B (imported, untouched)
  project-info.json
  project-context.json
```

Users can diff `.cleo/restore-imported/*.json` against the applied
`.cleo/*.json` to verify what was kept versus overridden.

---

## 7. Encryption Specification

### 7.1 Key derivation

```
passphrase (user input, prompted at CLI)
  → Argon2id(
       password = passphrase,
       salt     = per-bundle random 32 bytes,
       t        = 3  (time cost),
       m        = 65536  (memory cost, 64 MB),
       p        = 4  (parallelism)
     )
  → 32-byte AES-256 key
```

Parameters match the OWASP Argon2id recommendation for interactive logins.

### 7.2 Cipher

AES-256-GCM with a 12-byte random nonce per bundle. The 16-byte GCM
authentication tag is appended at the END of the ciphertext in the file
(after the ciphertext bytes, before EOF).

### 7.3 Encrypted bundle binary layout

```
Offset    Length   Field
------    ------   -----
0         8        Magic bytes: 0x43 0x4C 0x45 0x4F 0x45 0x4E 0x43 0x31
                   (ASCII "CLEOENC1")
8         1        Format version byte: 0x01
9         7        Reserved (zero-filled)
16        32       Argon2id salt (random, per-bundle)
48        12       AES-256-GCM nonce (random, per-bundle)
60        N        Encrypted ciphertext (the tar.gz bytes)
60+N      16       AES-256-GCM authentication tag
```

Total overhead: 76 bytes of header + 16 bytes of auth tag = 92 bytes.

The file extension `.enc.cleobundle.tar.gz` is kept for operator familiarity.
The `.tar.gz` suffix is technically incorrect for the encrypted file (it is
not a tar.gz until decrypted), but consistent naming aids discoverability.

### 7.4 Decryption flow on import

```
1. Read first 8 bytes; verify magic = "CLEOENC1".
   If mismatch → E_BUNDLE_DECRYPT (70) with message "Not a CLEO encrypted bundle."
2. Read format version byte (offset 8). If version != 0x01 → E_BUNDLE_DECRYPT
   with message "Unsupported encrypted bundle version."
3. Read 32-byte Argon2id salt (offset 16).
4. Prompt passphrase at CLI.
5. Derive key: Argon2id(passphrase, salt, t=3, m=65536, p=4) → 32 bytes.
6. Read 12-byte GCM nonce (offset 48).
7. Read ciphertext bytes (offset 60 to EOF-16).
8. Read 16-byte auth tag (last 16 bytes of file).
9. AES-256-GCM decrypt(key, nonce, ciphertext, tag).
   If auth tag verification fails → E_BUNDLE_DECRYPT (70)
   with message "Decryption failed: wrong passphrase or corrupted bundle."
10. Resulting plaintext is a tar.gz stream — proceed with standard import flow.
```

---

## 8. Test Scenarios

### 8.1 Unit tests

| File | What it tests |
|------|---------------|
| `restore-json-merge.test.ts` | All 5 classification categories (including identical), nested field paths (dot-notation), unknown fields written to manual-review, multi-file comparison, regenerateAndCompare contract |
| `manifest-schema.test.ts` | Valid manifests pass schema validation; invalid manifests reject (missing required fields, wrong enum values, bad regex patterns) |
| `backup-encryption.test.ts` | Round-trip encrypt/decrypt with known passphrase; wrong passphrase fails with E_BUNDLE_DECRYPT; bad magic bytes detected; corrupted auth tag detected |
| `backup-export.test.ts` | Create bundle from test project fixture; verify manifest contents, checksums.sha256 format, file count, tar entry order (manifest first) |
| `backup-unpack.test.ts` | Unpack valid bundle into tmp dir; verify all integrity layers pass; verify DB files present at expected relative paths |
| `inspect.test.ts` | Inspect returns manifest without modifying bundle; encrypted bundle returns encryption-only report without prompting passphrase |

### 8.2 Integration tests — full .cleobundle lifecycle

| Scenario | Expected outcome |
|----------|-----------------|
| Export project scope → inspect → import into empty target | All DBs and JSON files restored; conflict report written; zero integrity errors |
| Export with --encrypt → import with correct passphrase | Successful decrypt and restore |
| Export with --encrypt → import with wrong passphrase | E_BUNDLE_DECRYPT (70); nothing written to disk |
| Import into live target WITHOUT --force | E_DATA_EXISTS (78); lists conflicting files; nothing overwritten |
| Import into live target WITH --force | Succeeds; DBs overwritten; JSON A/B comparison runs |
| Export --scope global → import on fresh machine | nexus.db + signaldock.db + global-salt restored; re-auth warning emitted |
| Export --scope all → import | Both project and global tiers restored |
| Tampered checksum in checksums.sha256 | E_CHECKSUM_MISMATCH (72); reports which file; nothing written |
| Corrupted .db file (bit-flip) | E_SQLITE_INTEGRITY (73); reports which DB; nothing written |
| Bundle with older DB schema | Import succeeds with WARNING; Drizzle migrates on first open |
| Bundle with newer DB schema | Import succeeds with WARNING; message recommends cleo upgrade |
| manifest.json missing from tarball | E_MANIFEST_MISSING (74) |
| schemas/manifest-v1.json missing from tarball | E_SCHEMAS_MISSING (75) |
| manifest.json with invalid JSON | E_BUNDLE_SCHEMA (71) |
| manifest.json passes syntax but fails schema (extra required field absent) | E_BUNDLE_SCHEMA (71) |
| integrity.manifestHash tampered | E_BUNDLE_SCHEMA (71) |

### 8.3 A/B regenerate-and-compare tests

| Scenario | Expected outcome |
|----------|-----------------|
| config.json: user-intent field `brain.embeddingProvider` differs A vs B | Keeps B; written to resolved section of conflict report |
| project-info.json: machine-local `projectRoot` differs (different absolute path) | Keeps A; rationale "machine-local field" |
| project-info.json: project-identity field `name` differs | Keeps B; rationale "project identity field" |
| project-context.json: auto-detect `testing.framework` identical A and B | No conflict; not written to report |
| project-context.json: auto-detect `build.command` differs A vs B | Keeps A; rationale "auto-detect; current detection preferred" |
| config.json: unknown field present only in B | manual-review; A value (absent) used as safe default on disk |
| All fields identical across all three files | Zero conflicts; no manual review section in report |
| Agent re-auth: signaldock.db in bundle | Re-auth section written to conflict report listing agent IDs |
| Schema mismatch for brain.db (older bundle) | Schema warning section written to conflict report |
| Machine fingerprint mismatch | Machine advisory section written to conflict report |

### 8.4 cleo restore finalize tests

| Scenario | Expected outcome |
|----------|-----------------|
| No .cleo/restore-conflicts.md present | Exits 0 with "no pending conflicts" message; no file changes |
| Conflict report with 0 manual-review fields | Exits 0; archives report |
| Conflict report with 3 manual-review fields, 2 marked RESOLVED: B | Applies 2 resolutions to disk; archives report; logs "Finalized 2 conflict resolutions" |
| Conflict report with 1 manual-review field, not yet resolved | Exits 0 with instruction to edit; does not archive; no file changes |

---

## 9. Non-Functional Requirements

### Performance

- Export of typical project scope (tasks.db + brain.db + conduit.db + 3 JSON files, ~8 MB total uncompressed): MUST complete in < 2 seconds on a modern SSD.
- Import of same scope (including all 6 integrity layers + A/B comparison): MUST complete in < 3 seconds.
- `cleo backup inspect`: MUST complete in < 100 ms for typical bundles (manifest-only read).
- `PRAGMA integrity_check` on nexus.db (~30 MB): implementation MUST NOT block the CLI main thread; run in a worker thread or async boundary.

### Safety

- `--force` is the ONLY mechanism to overwrite live data. No flags, env vars, or config settings bypass this without `--force`.
- `global-salt` export MUST emit a WARNING at export time AND at import time. No silent inclusion.
- Encrypted bundles require a passphrase prompt; no key escrow or auto-decrypt path.
- The conflict report and `.cleo/restore-imported/` directory are non-destructive — raw imported files are always preserved.
- Atomic tmp-then-rename MUST be used for all DB writes to live paths. No partial writes.

### Portability

- The `.cleobundle.tar.gz` format MUST be self-contained: all validation (including the JSON Schema) is available inside the bundle with no external network requests.
- The `tar` npm package (pure JS, ADR-010 compliant) MUST be the only archive dependency.
- SHA-256 via Node.js built-in `node:crypto` (no external hash library).
- Argon2id via a pure-JS or WASM library that carries no native bindings (ADR-010 compliance). If no ADR-010-compliant Argon2id library exists at implementation time, the implementation team MUST raise a flag to the owner before proceeding.

---

## 10. File Boundaries for Implementation Phase

T333 decomposition will produce atomic subtasks aligned to these boundaries.
Each row represents one implementation unit with its own test file.

| Subtask group | New files |
|---------------|-----------|
| BackupManifest type + JSON Schema | `packages/contracts/src/backup-manifest.ts` + `packages/core/src/assets/schemas/manifest-v1.json` |
| Bundle packer | `packages/core/src/store/backup-pack.ts` + `backup-pack.test.ts` |
| Bundle unpacker (integrity layers) | `packages/core/src/store/backup-unpack.ts` + `backup-unpack.test.ts` |
| Manifest schema validator | `packages/core/src/store/backup-manifest-validator.ts` + `manifest-schema.test.ts` |
| Encryption layer | `packages/core/src/store/backup-crypto.ts` + `backup-encryption.test.ts` |
| A/B regenerate-and-compare engine | `packages/core/src/store/restore-json-merge.ts` + `restore-json-merge.test.ts` |
| Dry-run JSON regenerators | `packages/core/src/store/regenerators.ts` + `regenerators.test.ts` |
| CLI: backup export | `packages/cleo/src/cli/commands/backup-export.ts` + `backup-export.test.ts` |
| CLI: backup import | `packages/cleo/src/cli/commands/backup-import.ts` + `backup-import.test.ts` |
| CLI: backup inspect | `packages/cleo/src/cli/commands/backup-inspect.ts` + `inspect.test.ts` |
| CLI: restore finalize | `packages/cleo/src/cli/commands/restore-finalize.ts` + `restore-finalize.test.ts` |
| Integration test suite | `packages/cleo/src/cli/commands/backup.integration.test.ts` |

No existing files are modified as part of the core logic, except:
- `packages/cleo/src/cli/commands/backup.ts`: register the three new subcommands (export, import, inspect) alongside existing add/list.
- `packages/cleo/src/cli/commands/restore.ts`: register `restore finalize` subcommand.
- `packages/core/src/store/sqlite-backup.ts`: no changes required (VACUUM INTO baseline reused via import in backup-pack.ts).

---

## 11. Acceptance Criteria Summary

Implementation is complete when ALL of the following are true:

1. `cleo backup export --scope project` creates a valid `.cleobundle.tar.gz` with manifest as first tar entry.
2. `cleo backup inspect <bundle>` displays manifest contents without writing to disk, in under 100 ms.
3. `cleo backup import <bundle>` into an empty target restores all DBs and JSON files; writes `.cleo/restore-conflicts.md`.
4. `cleo backup import <bundle> --encrypt` / `cleo backup import <bundle.enc>` encryption round-trip works.
5. `cleo backup import <bundle>` into a live target WITHOUT `--force` aborts with E_DATA_EXISTS (78).
6. A/B regenerate-and-compare classifies all fields per §6.3 and produces a correct conflict report.
7. Schema version warnings are emitted for version mismatches; import is NOT blocked (Q5=C).
8. Agent re-auth warnings are emitted when `signaldock.db` is in the bundle.
9. `cleo restore finalize` applies pending manual resolutions and archives the report.
10. All test scenarios from §8 pass.
11. Zero pre-existing test failures introduced; `pnpm biome check` passes; `pnpm run build` passes.

---

## 12. Cross-Epic Notes

**T311 CANNOT ship before T310 (v2026.4.12).**

The export paths reference:

- `.cleo/conduit.db` at project tier — this file does NOT exist before T310 ships (ADR-037 Q5=A, T310 Q5=A). The pre-T310 equivalent is `.cleo/signaldock.db`.
- `$XDG_DATA_HOME/cleo/signaldock.db` at global tier — moved from project tier in T310.
- `$XDG_DATA_HOME/cleo/global-salt` — created on first invocation after T310 upgrade (ADR-037 Q3=C, T310 Q3=C).

**Integration risk and mitigation**: If T311 implementation begins before T310
is confirmed on main, the packer MUST include a T310 readiness gate:

```typescript
// Pseudocode — exact implementation in backup-pack.ts
const conduitExists = existsSync(join(cleoDir, 'conduit.db'));
const legacySignaldockExists = existsSync(join(cleoDir, 'signaldock.db'));
if (!conduitExists && legacySignaldockExists) {
  throw new CleoError(
    'T310 migration required before export. ' +
    'Run any cleo command to trigger the automatic migration, then retry.'
  );
}
```

T333 decomposition MUST:
1. Create a `T310-readiness-check` subtask as the first implementation task.
2. Create a follow-up subtask to remove the conditional guard once T310 is
   confirmed merged to main.

**DB topology reference (from T310 consensus and ADR-037)**:

| Scope | DB file | Tier path |
|-------|---------|-----------|
| Project | `tasks.db` | `<project-root>/.cleo/tasks.db` |
| Project | `brain.db` | `<project-root>/.cleo/brain.db` |
| Project | `conduit.db` | `<project-root>/.cleo/conduit.db` (NEW in T310) |
| Global | `nexus.db` | `$XDG_DATA_HOME/cleo/nexus.db` |
| Global | `signaldock.db` | `$XDG_DATA_HOME/cleo/signaldock.db` (MOVED in T310) |
| Global | `global-salt` | `$XDG_DATA_HOME/cleo/global-salt` (NEW in T310) |

The T310 topology is the single source of truth for these paths. Any
implementation that hardcodes `.cleo/signaldock.db` at the project tier
is incorrect after T310 ships.
