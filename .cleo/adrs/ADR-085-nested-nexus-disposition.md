---
id: adr-085-nested-nexus-disposition
tasks: [T10321, T10306, T10282, T10285]
kind: adr
summary: ADR-085 — Disposition of the nested `~/.local/share/cleo/nexus/` subdirectory. BAN — delete the nested duplicates (`nexus/nexus.db`, `nexus/signaldock.db`, `nexus/nexus-pre-cleo.db.bak`) and lock in the canonical flat XDG layout (`<cleoHome>/nexus.db`, `<cleoHome>/signaldock.db`). Ships a migration script (`scripts/migrate-nested-nexus.mjs`) plus a runtime warning at `getNexusDb()` open time.
---

# ADR-085: Nested `~/.local/share/cleo/nexus/` Disposition — BAN

- **Status**: Accepted
- **Date**: 2026-05-23
- **Tags**: database, charter, nexus, signaldock, xdg-layout, migration, ci-gate
- **Task**: T10321 (E4-T2 of Epic T10285 E4-DB-CROSS-LINKS)
- **Saga**: T10281 (SG-BRAIN-DB-RESILIENCE)
- **Extends**: ADR-068 (CLEO Database Charter) — does NOT supersede; closes a
  structural bug flagged in ADR-068 §Decision/Known structural bugs (item 1).
- **Cross-refs**: ADR-036 (CleoOS Database Topology), ADR-037 (Conduit /
  signaldock separation), ADR-013 §9 (project-tier untrack resolution)
- **Authors**: cleo-prime (2026-05-23)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in RFC 2119.

---

## §1 Context

The Saga T10281 SG-BRAIN-DB-RESILIENCE deep audit
(`sg-brain-db-resilience-deep-audit-2026-05-23` §1.2) surfaced a structural bug
in the global CLEO data layout: a **nested subdirectory** sits beside the
canonical flat-tier global DBs, holding duplicate copies of `nexus.db` and
`signaldock.db` plus a stale `-pre-cleo.db.bak` sidecar. On the audit machine:

```
$XDG_DATA_HOME/cleo/
├── nexus.db                      (canonical, openCleoDb('nexus') target)
├── signaldock.db                 (canonical, openCleoDb('signaldock') target)
└── nexus/                        (nested subdirectory — STRUCTURAL BUG)
    ├── nexus.db                  (~258 KB — duplicate, no live opener)
    ├── nexus-pre-cleo.db.bak     (~258 KB — stale half-migration artefact)
    └── signaldock.db             (~245 KB — duplicate, no live opener)
```

Neither file at `$XDG_DATA_HOME/cleo/nexus/` is reached by any production code
path. `openCleoDb('nexus')` resolves through `getNexusDbPath()` →
`join(getCleoHome(), 'nexus.db')` — the **flat** location. `signaldock.db` is
resolved through `getGlobalSignaldockDbPath()` → also flat. The nested files are
artefacts of an incomplete historical migration that moved global-tier DBs out
of a `nexus/` namespace into the flat XDG canonical layout, never deleted the
originals, and left a `*-pre-cleo.db.bak` snapshot behind for "safety".

ADR-068 (CLEO Database Charter) was amended on 2026-05-23 (T10306) to register
the nested duplicates in §Decision/Known structural bugs item 1, with explicit
deferral of the BAN-vs-ADOPT decision to this ADR (T10321 / E4-T2). ADR-068
states: *"Until then, the duplicates are CHARTER-FLAGGED but not
OPENCLEODB-REGISTERED."*

This ADR closes the deferral.

### Why a decision is needed

Two viable dispositions exist:

- **BAN**: delete the nested files, treat their presence as a migration bug,
  install a runtime warning at `getNexusDb()` open time, ship a migration
  script.
- **ADOPT**: canonicalize the nested location as `nexus/<role>.db`, migrate
  the flat-layout copies into the nested subdirectory, retire the flat-layout
  inventory rows, amend ADR-068 to flip the inventory paths.

Without a verdict, every audit / fleet survey / backup pack tool has to
special-case the structural bug, every new developer sees an inconsistent
layout, and the `getNexusDb()` warning telemetry never closes.

---

## §2 Decision: **BAN**

The canonical CLEO global-tier layout is **flat**:

```
$XDG_DATA_HOME/cleo/
├── nexus.db
├── signaldock.db
├── brain.db                      (global-brain, T10282 cleanup pending)
├── tasks.db                      (global-tasks, T10282 cleanup pending)
├── skills.db
├── telemetry.db                  (lazy, opt-in)
└── backups/
    └── sqlite/                   (VACUUM INTO rotation)
```

The nested subdirectory `$XDG_DATA_HOME/cleo/nexus/` MUST NOT exist on any
post-T10321 install. Any tooling that detects its presence MUST treat the
nested files as **deletable migration debris** with no recoverable value
beyond historical curiosity.

### §2.1 What is deleted

The migration tool delivered by T10321
(`scripts/migrate-nested-nexus.mjs`) targets exactly the following paths:

| Path | Status |
|---|---|
| `$XDG_DATA_HOME/cleo/nexus/nexus.db` | Duplicate of canonical flat `nexus.db` — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/nexus.db-shm` | SQLite shared-memory sidecar of the duplicate — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/nexus.db-wal` | SQLite WAL sidecar of the duplicate — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/nexus-pre-cleo.db.bak` | Stale pre-migration snapshot — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/signaldock.db` | Duplicate of canonical flat `signaldock.db` — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/signaldock.db-shm` | SQLite shared-memory sidecar of the duplicate — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/signaldock.db-wal` | SQLite WAL sidecar of the duplicate — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/signaldock-pre-cleo.db.bak` | Stale pre-migration snapshot — DELETE |
| `$XDG_DATA_HOME/cleo/nexus/global-salt` | Per-directory salt artefact — DELETE only if the nested directory is otherwise empty after the DB sweep |
| `$XDG_DATA_HOME/cleo/nexus/cache/` | Per-directory cache — DELETE only if otherwise empty after the DB sweep |
| `$XDG_DATA_HOME/cleo/nexus/` (the directory itself) | Removed via `rmdir` after the directory is empty |

The script MUST NOT delete the parent `$XDG_DATA_HOME/cleo/` directory, MUST
NOT touch any flat-tier sibling file (`nexus.db`, `signaldock.db`, etc.), and
MUST refuse to delete any file under the nested directory that does NOT appear
in the explicit allowlist above (defence-in-depth against accidental layout
expansion).

### §2.2 Runtime warning

`getNexusDb()` in `packages/core/src/store/nexus-sqlite.ts` MUST detect the
presence of `$XDG_DATA_HOME/cleo/nexus/nexus.db` on every open and emit a
**single warning** (one-shot per process, gated by an in-memory `Set` keyed on
the absolute path) via the canonical logger naming:

- the nested path that was detected,
- the canonical flat path that IS being used by the open,
- the migration command (`node scripts/migrate-nested-nexus.mjs`).

The warning MUST NOT block, throw, or alter the open. The canonical flat
`nexus.db` open proceeds normally regardless.

### §2.3 ADR-068 follow-on

After T10321 lands, ADR-068 §Decision/Known structural bugs item 1 MUST be
updated (in the same PR or a small follow-up) to reference this ADR as the
authoritative disposition. The "CHARTER-FLAGGED but not OPENCLEODB-REGISTERED"
language remains accurate — the BAN verdict simply means the duplicates will
be removed by the migration tool, not adopted into the inventory.

---

## §3 Rationale

### §3.1 Canonical layout is flat

ADR-036 / ADR-068 both describe the global tier as a flat XDG-resolved
directory. Every live opener (`openCleoDb('nexus')`,
`openCleoDb('signaldock')`, `openCleoDb('skills')`, `openCleoDb('brain')`
when global-tier orphans are addressed by T10282) resolves to
`join(getCleoHome(), '<role>.db')`. There is **no live opener** anywhere in
production that touches `getCleoHome() + '/nexus/<role>.db'`. Adopting the
nested layout would force every opener to be rewritten — a refactor with
zero functional benefit, motivated only by retroactively legitimising
migration debris.

### §3.2 The nested files have no recoverable value

Both nested `*.db` files were created on 2026-04-28 (per audit-host filesystem
timestamps), predating the v2026.4.11 migration that flattened the layout.
They have not been written to since. Any data they contain has been superseded
by the live flat-layout copies, which have been receiving writes continuously
through every subsequent release.

The `*-pre-cleo.db.bak` sidecars are double-debris: they are themselves
historical safety snapshots of the duplicates. By T10309 (ADR-013 retention
policy ratification), `*-pre-cleo.db.bak` files at the **flat** tier are
already targeted for deletion by `detectAndRemoveLegacyGlobalFiles()`. The
nested `nexus-pre-cleo.db.bak` is the same category of file in the wrong
location.

### §3.3 ADOPT would inflate ADR-068's inventory

Adopting the nested layout requires:

- Adding new inventory rows (`nested-nexus`, `nested-signaldock`).
- Or rewriting the existing rows 5 + 9 to point at nested paths.
- Updating `getNexusDbPath()` + `getGlobalSignaldockDbPath()` + every SSoT
  path helper.
- Re-running every test that asserts `getNexusDbPath()` ends in `nexus.db`
  flat.
- Migrating every existing user's flat-layout DB into the nested location,
  which is itself a real migration with real risk.

The BAN verdict requires:

- Deleting 8 files + 1 directory on installs that have them.
- Adding a one-shot runtime warning.
- Documenting the decision.

BAN is strictly cheaper, strictly safer, and aligns with the existing
canonical layout. ADOPT is more work for a worse result.

### §3.4 Defence-in-depth: warning + migration script + future CI gate

The warning catches users who upgrade past T10321 without running the
migration script. The migration script is the one-shot resolution path. A
follow-on CI gate (tracked under Saga T10281 as a doctor enhancement) MAY add
a `cleo doctor db-substrate` finding for nested-nexus presence, escalating
visibility further.

---

## §4 Consequences

### §4.1 Positive

- **Layout drift closed**: one fewer structural bug in the global tier;
  ADR-068 §Decision/Known structural bugs item 1 can be retired.
- **Audit tooling simplified**: `cleo doctor db-substrate`, `cleo backup
  pack`, the fleet survey, and any future inventory walker no longer need to
  special-case the nested directory.
- **Migration story is precedented**: identical pattern to the v2026.4.11
  `workspace.db` cleanup (see `detectAndRemoveLegacyGlobalFiles`) — same
  idempotent-existence-check + explicit-allowlist + audit-log discipline.
- **Telemetry close-out**: the runtime warning emits a recognisable
  subsystem tag so install-base health can be tracked in aggregate before
  the warning is removed in a future release.

### §4.2 Negative

- **One-shot delete is irreversible**: by definition the migration script
  permanently removes files. The audit upstream (§3.2) establishes that no
  recoverable value is at stake, but users who want to inspect the nested
  files for forensic curiosity MUST do so before running the script.
- **Migration script must be invoked manually**: T10321 does NOT auto-run
  the migration on `cleo init` / `cleo upgrade`. The runtime warning carries
  the user-facing remediation hint; auto-invocation can be wired later as a
  follow-on once telemetry confirms the warning fires on real installs.

### §4.3 Neutral

- ADR-068's inventory does NOT change as a result of T10321 — the nested
  duplicates were never registered. T10306 amended ADR-068 to flag them;
  T10321 closes the flag by ratifying their disposition.

---

## §5 Alternatives Considered

### §5.1 ADOPT — canonicalize the nested layout

Treat `$XDG_DATA_HOME/cleo/nexus/<role>.db` as the canonical layout, migrate
the flat-tier copies into the nested subdirectory, retire the flat-tier rows
in ADR-068, rewrite every path helper.

**Why rejected**: §3.3. Strictly more work, strictly worse outcome — both the
ADR-068 inventory and the runtime path-resolution surface inflate to no
functional benefit. ADOPT only makes sense if the nested layout offers some
organisational property (e.g. namespacing) that the flat layout lacks. It
does not: the role names (`nexus`, `signaldock`, `skills`, `brain`,
`tasks`) are already globally unique within the flat tier.

### §5.2 Auto-delete on `cleo init` / `cleo upgrade`

Roll the migration script's logic into the existing
`detectAndRemoveLegacyGlobalFiles()` chain so users never see the warning.

**Why deferred**: this is the natural follow-on once telemetry confirms the
warning fires on real installs. Shipping it in T10321 would conflate two
decisions: (a) "is BAN correct?" (this ADR) and (b) "is auto-invocation
correct?" (a follow-on). Keeping them separate lets the warning + manual
script land as a reversible step. Auto-invocation can be wired with `cleo
doctor --fix` first, then `cleo init` second, after the warning has had at
least one release cycle to gather signal.

### §5.3 Move the nested files to a quarantine directory

Migrate `$XDG_DATA_HOME/cleo/nexus/` → `$XDG_DATA_HOME/cleo/quarantine/nested-nexus-<iso>/`
instead of deleting.

**Why rejected**: §3.2. The files are double-debris (duplicate DBs plus
already-superseded `*-pre-cleo.db.bak` sidecars). Quarantining adds disk
clutter without preserving any recoverable value. The migration script's
dry-run mode lets a curious user inspect what would be deleted before
committing — sufficient forensic affordance without permanent quarantine.

### §5.4 Do nothing — leave the nested files in place

Accept the structural bug indefinitely; rely on ADR-068's CHARTER-FLAGGED
status to document the deferral forever.

**Why rejected**: deferral-as-resolution is the failure mode that produced
this bug in the first place (an incomplete 2026-04-28 migration left the
nested files behind). The Saga T10281 mandate is to **close** structural
bugs, not to perpetuate them.

---

## §6 Implementation

### §6.1 Deliverables

- `scripts/migrate-nested-nexus.mjs` — detect + delete + audit-log, with
  `--dry-run` and `--no-confirm` flags. Idempotent. Skips no-op cases
  silently. Returns non-zero only on unrecoverable I/O errors.
- Runtime warning in `packages/core/src/store/nexus-sqlite.ts` —
  `detectAndWarnOnNestedNexus()` called from `getNexusDb()` before
  `mkdirSync()`. Gated by a one-shot in-memory `Set` keyed on the absolute
  nested path so the warning fires exactly once per process even if
  `getNexusDb()` is called repeatedly.
- `packages/core/src/store/__tests__/nested-nexus-migration.test.ts` —
  unit tests using `mkdtempSync` fixtures covering: (a) no nested directory
  → no-op + no warning, (b) nested DBs present → warning fires + idempotent
  one-shot, (c) migration script-equivalent core helper deletes the
  expected files only, (d) defensive allowlist refuses unknown nested
  files, (e) repeat-invocation no-op.
- `.changeset/T10321.md` — release-note coverage citing this ADR + Saga
  T10281 + Epic T10285.

### §6.2 Out of scope for T10321

- Auto-invocation of the migration on `cleo init` / `cleo upgrade` — see
  §5.2.
- `cleo doctor db-substrate` integration — natural follow-on once T10310
  (per-DB pragma drift) and T10311 (per-DB migration coverage) close.
- ADR-068 §Decision/Known structural bugs item 1 amendment — best done in a
  small follow-up to keep the T10321 PR diff scoped to the ADR + migration
  surface.

---

## §7 References

- **ADR-068** — CLEO Database Charter (12 DBs · ownership · lifecycle ·
  concurrency); §Decision/Known structural bugs item 1 is the flagged
  predecessor of this ADR.
- **ADR-036** — CleoOS Database Topology (flat global tier definition).
- **ADR-037** — Conduit / signaldock separation (precedent for global-tier
  renames).
- **ADR-013 §9 / §10** — Project-tier untrack + canonical backup path
  ratification (precedent for `*-pre-cleo.db.bak` deletion).
- **T10306** — ADR-068 amendment that flagged the nested-nexus structural
  bug and deferred resolution to T10321.
- **T10282 (E1-DB-INVENTORY)** — sibling epic owning the orphan disposition
  for rows 11/12 (`global-brain`, `global-tasks`).
- **T10285 (E4-DB-CROSS-LINKS)** — owning epic of T10321.
- **`sg-brain-db-resilience-deep-audit-2026-05-23`** (research doc) —
  audit evidence; §1.2 documents the on-disk state.
- **`packages/core/src/store/cleanup-legacy.ts`** — precedent implementation
  pattern (idempotent existence-checked deletion + audit log).
- **`scripts/migrate-rogue-worktrees.mjs`** — precedent migration script
  shape (CLI flags, dry-run, audit-log discipline).
