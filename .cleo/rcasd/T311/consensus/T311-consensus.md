---
task: T330
epic: T311
type: consensus
pipeline_stage: consensus
feeds_into: [ADR-038, T311-specification, T311-decomposition]
research_source: .cleo/research/T311-backup-portability-audit.md
cross_epic_dependency: T310 (conduit.db/signaldock.db split must be live before T311 release)
decisions_recorded: 2026-04-08
---

# T311 Consensus Record: Cross-Machine Backup Portability

> Records the 8 architectural decisions made by the HITL owner during the
> T311 Consensus phase. ADR-038 implements these formally; T311 Specification
> defines the contracts; T311 Decomposition turns them into atomic subtasks.

## Decision Summary

| # | Question | Decision | Impact |
|---|----------|----------|--------|
| Q1 | Archive format | tar.gz | Node `tar` package, streaming, no native bindings |
| Q2 | Encryption default | opt-in via --encrypt | Matches pg_dumpall/git bundle pattern |
| Q3 | Restore on live data | abort with --force override | Safest default; explicit intent required |
| Q4 | signaldock/conduit inclusion | always include | Credentials are machine-bound ciphertext |
| Q5 | Schema compat policy | best-effort with warnings | Drizzle reconciles forward-compat |
| Q6 | manifest.json $schema | bundled path | Schema file ships inside .cleobundle |
| Q7 | Export scope control | --scope flag (conduit/signaldock per T310) | Explicit T310 topology awareness |
| Q8 | JSON file restore | EXTENDED A/B regenerate-and-compare | Conflict report + agent review |

## Cross-Epic Dependency

T311 releases in v2026.4.13, which requires v2026.4.12 (T310) to be shipped first. The
T311 export code MUST reference `.cleo/conduit.db` at project tier and
`$XDG_DATA_HOME/cleo/signaldock.db` at global tier per T310's decisions. The T311 scope
flag `--scope project` exports `tasks.db + brain.db + conduit.db`; `--scope global`
exports `nexus.db + signaldock.db`; `--scope all` exports both.

## Full Decision Records

### Q1: Archive Format — Decision A (tar.gz)

**Question**: What archive format for v1? [tar.gz | zip | tar.zst | .cleobak]

**Decision**: **A — tar.gz.**

**Rationale**:
- Widest cross-platform compatibility (Linux, macOS, Windows 10+)
- Node.js `tar` package is mature, pure JS, streaming, no native bindings
- Supplementary SHA-256 checksums provide integrity where tar.gz native integrity is weak
- Rejected alternatives: `zip` (worse streaming), `tar.zst` (blocked by ADR-010 native binding rule), `.cleobak` (reinvents the wheel)

**How to apply**:
- Dependency: `tar` npm package (add to `@cleocode/core` or `@cleocode/cleo`)
- Bundle filename pattern: `<project-name>-<ISO-timestamp>.cleobundle.tar.gz`
- Streaming packer and unpacker (backpressure-friendly)
- SHA-256 checksums per file stored in manifest.json

**Research link**: T311-backup-portability-audit.md Section 2 (Portable Archive Format Options)

---

### Q2: Encryption Default — Decision A (opt-in via --encrypt)

**Question**: Should exports be encrypted by default?

**Decision**: **A — Off by default; opt-in via `--encrypt` flag.**

**Rationale**:
- Matches `pg_dumpall`, `git bundle`, `tar`, and other industry defaults
- Encryption forces key management complexity on every user
- Credentials in signaldock.db are already machine-bound ciphertext (unreadable on target)
- Opt-in encryption caters to users who manage their own key workflow

**How to apply**:
- CLI: `cleo backup export <name> --encrypt` prompts for passphrase
- Cipher: AES-256-GCM with Argon2id KDF from passphrase + per-bundle salt
- Encrypted bundle has `.enc.cleobundle.tar.gz` extension; import detects from extension
- Unencrypted bundle is the default path (simpler, zero prompts)
- Import of encrypted bundle also prompts for passphrase
- Redaction mode is NOT implemented for v1 (owner chose A, not D)

**Research link**: T311-backup-portability-audit.md Section 5 (Security Considerations)

---

### Q3: Restore on Live Data — Decision A (Abort with --force Override)

**Question**: What is the default restore mode when live data already exists?

**Decision**: **A — Abort with `E_DATA_EXISTS`; require `--force` to overwrite.**

**Rationale**:
- Safest default; no accidental data loss
- Aligns with ADR-013 §9 data-safety-first principle
- Merge logic (option D) is complex and deferred to a future epic
- Explicit `--force` is a deliberate, auditable action

**How to apply**:
- Import pre-check: scan target project for existing tasks.db, brain.db, conduit.db, config.json, project-info.json, project-context.json
- If ANY exist, abort with `E_DATA_EXISTS` (exit code 78) and print the list of existing files
- `cleo restore import <bundle> --force` bypasses the pre-check
- `--force` still triggers the Q8 intelligent regenerate-and-compare for JSON files
- Global tier: if `nexus.db` exists, apply the same abort-with-force rule
- Exception: an empty `.cleo/` dir (no tracked DBs or JSON files) is considered fresh — no abort needed

**Research link**: T311-backup-portability-audit.md Section 6 (Restore Modes)

---

### Q4: signaldock/conduit Inclusion — Decision A (Always Include)

**Question**: Should signaldock.db be included in the export bundle by default?

**Decision**: **A — Always include signaldock.db + conduit.db (per T310 topology).**

**Rationale**:
- Credentials are machine-bound ciphertext (encrypted with machine-key) — unreadable on target
- Inclusion preserves agent identity metadata (attachment to project, custom overrides, activity logs)
- Exclusion would force re-registration on every restore, losing attachment history
- Warning on restore: "Agent credentials are machine-bound; re-authenticate after restore."

**How to apply**:
- `--scope project` bundle includes: `tasks.db + brain.db + conduit.db`
- `--scope global` bundle includes: `nexus.db + signaldock.db + global-salt`
- `--scope all` bundle includes the union of both
- Restore emits re-auth warning to stderr and writes it to `.cleo/restore-conflicts.md` alongside JSON conflicts
- signaldock.db credentials remain encrypted in ciphertext after restore; the KDF (machine-key + global-salt + agent-id from T310 Q3) fails on target — agent auto-logs-out and prompts re-auth

**Research link**: T311-backup-portability-audit.md Section 5 (security); cross-reference T310 Q3 (KDF change)

---

### Q5: Schema Version Compatibility — Decision C (Best-Effort with Warnings)

**Question**: What schema version compatibility policy governs import?

**Decision**: **C — Best-effort with warnings.** Allow all imports. Emit warnings on schema mismatch. Let Drizzle reconcile forward-compatible migrations on first open.

**Rationale**:
- Strict-equal (A) blocks every cross-version restore, defeating the purpose of backup
- Drizzle's migration system handles forward-compat additively
- Warnings preserve user awareness without blocking
- Breaking changes are handled at the Drizzle-migration level, not the import level

**How to apply**:
- manifest.json contains schema version per DB (from drizzle migration folder names)
- Import compares manifest schema versions to local-installed versions
- If import version < local: WARNING "Bundle is from an older cleo version; Drizzle will apply forward migrations on first open"
- If import version > local: WARNING "Bundle is from a newer cleo version; some features may not be supported. Consider upgrading cleo."
- If import version == local: no warning
- All warnings go to both stderr AND `.cleo/restore-conflicts.md`
- Drizzle reconciliation runs on first `cleo` invocation after import (existing migration pipeline, no new code)

**Research link**: T311-backup-portability-audit.md Section 4 (Integrity Validation)

---

### Q6: manifest.json $schema — Decision C (Bundled Path)

**Question**: Should manifest.json include a $schema URL?

**Decision**: **C — Bundled schema path inside the .cleobundle.**

**Rationale**:
- Remote URL creates external dependency (offline restore breaks)
- Fully self-contained (no $schema) loses IDE validation
- Bundled path: `$schema: "./schemas/manifest-v1.json"` relative to the bundle root
- The schema file ships inside the tarball at `schemas/manifest-v1.json`

**How to apply**:
- Tarball layout:
  ```
  <name>.cleobundle.tar.gz
  ├── manifest.json
  ├── schemas/
  │   └── manifest-v1.json       ← JSON Schema Draft 2020-12
  ├── databases/
  │   ├── tasks.db
  │   ├── brain.db
  │   └── conduit.db
  ├── json/
  │   ├── config.json
  │   ├── project-info.json
  │   └── project-context.json
  └── checksums.sha256
  ```
- `manifest.json`'s `$schema` field: `"./schemas/manifest-v1.json"`
- Validator on import: unpacks to tmp dir, validates manifest against bundled schema, then processes
- Schema file also versioned: future `manifest-v2.json` is additive; v1 bundles still import via fallback

**Research link**: T311-backup-portability-audit.md Section 3 (Manifest Schema)

---

### Q7: Export Scope Control — Decision C (--scope flag)

**Question**: Which databases are included in a project-scope export?

**Decision**: **C — Controlled by `--scope project|global|all` flag.**

**Critical cross-epic note**: This decision depends on T310's topology. After T310 ships:
- Project tier = `.cleo/tasks.db` + `.cleo/brain.db` + `.cleo/conduit.db`
- Global tier = `$XDG_DATA_HOME/cleo/nexus.db` + `$XDG_DATA_HOME/cleo/signaldock.db`
- Global-salt file at `$XDG_DATA_HOME/cleo/global-salt` is included with `--scope global` (security-sensitive; opt-in)

**How to apply**:
- `cleo backup export myproject --scope project` → 3 DBs + 3 JSON files (config, project-info, project-context)
- `cleo backup export global-snap --scope global` → 2 DBs + global-salt + machine-key metadata
- `cleo backup export full --scope all` → union of both scopes
- Default scope is `project` (most common use case)
- Global-salt is included only with `--scope global` or `--scope all`; a warning reminds the user it regenerates API keys on target
- Exporting `--scope global` without a project context is allowed (useful for fresh machine seeding)

**Research link**: T311-backup-portability-audit.md Section 7 (CLI Verb Surface); cross-reference T310 Q5 (conduit.db), T310 Q3 (global-salt)

---

### Q8: JSON File Restore — Decision B+ (Extended A/B Regenerate-and-Compare)

**Question**: What should happen to config.json and project-info.json on import?

**Decision**: **EXTENDED — B+** Restore `config.json` + `project-info.json` AND MUST include `project-context.json` AND use intelligent A/B regenerate-and-compare with conflict reporting.

**Owner quote** (verbatim): "restore but also the project-info.json and MUST include project-context.json too and need to have A/B intelligent regenerate and compare ensure the content is correct report out to agent for review on conflicts"

**The A/B Regenerate-and-Compare strategy**:

This is a NEW mechanism specific to T311. Spec and decomposition must define the details; consensus defines the shape.

1. **(A) Local regeneration** — For each JSON file, regenerate what it would look like if freshly initialized on the target machine. Uses the existing `cleo init` file generators in read-only mode (new `--dry-run --emit <file>` flag needed).

2. **(B) Imported file** — Parse the file as exported from the source machine (from `json/` dir in the tarball).

3. **Field-by-field comparison** with a 4-way classification (see Classification Rules table below).

4. **Resolution**:
   - Identical fields → no conflict
   - Machine-local fields → keep A (local) — expected to differ
   - User-intent fields → keep B (imported) — this is what the user wants back
   - Auto-detect fields → prefer A unless A == B
   - Unknown/ambiguous → report to conflict file

5. **Conflict report** written to `.cleo/restore-conflicts.md` with recommended resolutions.

6. **Agent review loop** — a downstream agent (or human) can read the report, resolve conflicts, and optionally run `cleo restore finalize` to commit.

7. **Default behavior after writing conflict report**: Apply the recommended resolutions to disk. Non-destructive: the imported file is preserved in `.cleo/restore-imported/<filename>.json` for manual recovery.

### Classification Rules

| Category | Files | Fields | Resolution |
|----------|-------|--------|------------|
| Machine-local | all | `projectRoot`, `machineKey`, `hostname`, `cwd`, `createdAt`, `detectedAt`, absolute paths | A (local) |
| User intent | config.json | `enabledFeatures`, `brain.*`, `hooks`, `tools`, custom overrides | B (imported) |
| Project identity | project-info.json | `name`, `description`, `type`, `primaryType`, `tags` | B (imported) |
| Auto-detect | project-context.json | `testing.framework`, `build.command`, `directories.*`, `conventions.*`, `llmHints.*` | A if A == B, else A (current tool detection more reliable than stale import) |
| Unknown | any | anything unclassified | conflict report (no default resolution) |

### Conflict Report Format

```markdown
# T311 Import Conflict Report

Source bundle: <path>
Source machine: <fingerprint>
Target machine: <fingerprint>
Restored at: <ISO timestamp>

## config.json (N conflicts, M fields classified)
- Field: `brain.embeddingProvider`
  - Local regeneration (A): `"local"` (machine default)
  - Imported (B): `"openai"` (user-set on source machine)
  - Recommended: B (user intent)
  - Rationale: user intent field per T311 classification

## project-info.json (N conflicts)
...

## project-context.json (N conflicts)
...

## Agent credential re-auth required
The following agents are listed in signaldock.db but their API keys were encrypted with the source machine's global-salt and will not decrypt on this machine. Run `cleo agent auth <id>` to re-authenticate:
- <agent-id-1>
- <agent-id-2>

## Schema compat warnings
...
```

**How to apply**:
- New code: `packages/core/src/store/restore-json-merge.ts` with classification engine
- New CLI: `cleo restore finalize` (reads conflict report, applies pending resolutions)
- Preserves imported raw files under `.cleo/restore-imported/` for recovery
- Integrated into T311 Implementation phase (must be a decomposed subtask)

**Research link**: T311-backup-portability-audit.md Section 6 (Restore Modes) — expanded to match owner's requirement

---

## Cross-Reference for Downstream Phases

- **ADR-038** (task T331): documents these decisions formally
- **T311 Specification** (task T332): formalizes bundle layout, JSON Schema, classification engine, CLI surface
- **T311 Decomposition** (task T333): breaks spec into atomic implementation subtasks
- **Research source**: `.cleo/research/T311-backup-portability-audit.md`
- **Depends on T310**: v2026.4.13 cannot ship before v2026.4.12 (conduit.db/signaldock.db split must exist)

## Scope Boundary (What This Consensus DOES NOT Decide)

- Merge mode for restore (option D in research) → explicitly deferred; v1 is abort+force only
- Redaction mode → not implemented; users who want redacted exports must manually scrub
- Cloud-sync-based backup → out of scope; this is local tarball only
- Differential/incremental backups → v1 is full-snapshot only
