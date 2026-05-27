# ADR-079 — AC Stable IDs + Programmatic AC↔Evidence Binding

**Status**: Proposed
**Date**: 2026-05-23
**Saga**: T10268 (SG-IVTR-AUTONOMY) · **Task**: T10271 (Wave 1 / Improvement Target IT-1)
**Predecessors**: T10269 steal-table (slug `ivtr-external-systems-steal-table`), T10270 current-state audit (slug `ivtr-current-state-audit`), T9154 consensus (slug `t9154-consensus`)
**Relates to**: ADR-051 (programmatic gate integrity), ADR-070 (verifier-backed AC auditor loop), ADR-066 (task taxonomy), ADR-073 (above-epic naming)
**Supersedes (partial)**: ADR-051 § "Decision 1 — evidence grammar" (atom list extended; rubber-stamp `note:` shortcut closed for AC-bound gates)

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "SHOULD NOT", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

### 1.1 The owner-identified gap

ADR-051 (`packages/core/src/tasks/evidence.ts:551`) made every gate carry programmatic evidence — a real `commit:<sha>` reachable from HEAD, a real `test-run:<json>` with `numFailedTests===0`, a real `tool:lint` exit-0. This closed the `cleo verify --all` rubber-stamp vector. **It did not close the deeper one**: a commit can be reachable + lint-clean + type-clean + test-green and *still not satisfy what AC-3 actually said*. Evidence today verifies **existence**, not **AC satisfaction** (audit doc § 1, Gap G1/G2).

The orchestrator's recourse is `CLEO_OWNER_OVERRIDE=1 … note:"...looks right"` (audit doc § 2.1, override path). That is structurally identical to a self-attested gate — the orchestrator is the worker's *parent context* (steal table § 2.3.6, mindstudio quote) and therefore inherits the worker's confirmation bias.

### 1.2 Why the existing surface is insufficient

The audit (slug `ivtr-current-state-audit` § 2.2) found:

- `task.acceptance_json` (file `packages/core/src/store/schema/tasks.ts:135`) is `(string | AcceptanceGate)[]` — **mostly free-text strings with no ID** (Gap G1).
- `AcceptanceGate.req?: string` (file `packages/contracts/src/acceptance-gate.ts:31`) is opt-in, hand-typed, and uniqueness is only enforced **within one task** (Gap G3; audit § 2.2).
- No `ac:<id>` atom kind exists in `ParsedAtom` union (file `packages/core/src/tasks/evidence.ts:186-219`, Gap G2).
- The two verification machines run in parallel and never cross-reference: `runGates` (`gate-runner.ts:81-114`) executes `AcceptanceGate` objects; `validateGateVerify` (`validation/engine-ops.ts:307-649`) verifies evidence atoms. Neither knows what the other did (Gap G16).
- The `T9245 checkCommitContentIntersect` (`evidence.ts:810-876`) regex-extracts file-path tokens from AC *text* — a fragile string-overlap heuristic, not a binding.

The steal table (slug `ivtr-external-systems-steal-table` § 3, rows "Per-AC stable ID + `passes:bool` array", "Dataset → Target → Extractor → Grader → Gate → Result") **prescribes the fix**: ADOPT Ralph's per-AC stable-ID + `passes` flag, and ADOPT Letta-Evals' typed grader pipeline. This ADR specifies that adoption for CLEO's stack.

### 1.3 Scope of this ADR

This ADR decides **only** the AC ID + AC↔evidence binding layer (Improvement Target IT-1). Three siblings handle the orthogonal concerns:
- **T10272** — Independent Validator role (IT-2 / ADR-080 forthcoming)
- **T10273** — Docs-as-validator + grader pipeline (IT-3 / ADR-081 forthcoming)
- **T10274** — CORE tool registry surface (IT-4 / ADR-082 forthcoming)

References below use those `T-` IDs as placeholders for the sibling ADRs they ship as.

---

## 2. Decisions (RFC 2119 binding)

### D1 — AC ID format: `<taskId>-ac<n>` positional + content-hash tag

**Decision**: Every AC MUST carry a positional ID `<taskId>-ac<n>` where `n` is the zero-based index in `task.acceptance_json` (1-padded to two digits for stable ordering: `T9614-ac03`). Each AC MUST additionally carry an immutable content hash `acHash` (SHA-256 over the canonical text representation, base32-truncated to 12 chars: e.g. `H7K3MXQ9D2NR`). The pair `(taskId-ac<n>, acHash)` MUST be persisted.

**Display ID** (CLI / human-facing): `T9614-ac03`. Positional, predictable, sortable.

**Stable ID** (`satisfies:` evidence atom binding): `T9614-ac03@H7K3MXQ9D2NR`. The `@hash` suffix is **OPTIONAL** in user input; when omitted, CLEO MUST look up the current `acHash` for that position and synthesize the full ID before persisting the evidence row. The hash MUST be re-computed and re-stored on any AC text edit; the *prior* hashes MUST be retained in `task_acceptance_criteria_history` for evidence-staleness detection (D6).

**Rationale**:
- Positional IDs (`T9614-ac03`) match human muscle memory from ADR-051's existing `--gate implemented` UX (cite: audit doc § 2.1, `cleo verify` syntax). Ralph's `prd.json` proves the per-story addressable model works (steal-table § 2.1.1).
- Pure hashes (`H7K3MXQ9D2NR`) are unrememberable; agents would just stop using them.
- Pure positional IDs break under AC reordering. The `@hash` suffix lets evidence detect AC text drift (steal-table § 2.1.4, Ralph's weakness: "binary flag; no failure rationale per AC"; we leapfrog by detecting drift).
- 12-char base32 SHA-256 truncation gives `2^60` collision space — sufficient for ≤ 50 ACs per task with negligible collision risk.

**Rejected alternatives**:
- *UUID v4*: zero human-readability; agents would type-error constantly. Rejected.
- *Hash-only IDs* (`H7K3MXQ9D2NR`): survives reorder but unmemorable + breaks `cleo verify T9614-ac3` ergonomics. Rejected.
- *Pure positional* (`T9614-ac3`): re-ordering ACs silently rebinds evidence. Catastrophic for audit. Rejected.

### D2 — AC↔evidence binding: new `satisfies:` atom kind

**Decision**: ADR-051's atom grammar (`evidence.ts:186-219`) MUST be extended with a new atom kind:

```
satisfies:<ac-id>(,<ac-id>)*
```

Where each `<ac-id>` is the full stable ID (`T9614-ac03@H7K3MXQ9D2NR`) or the display ID (`T9614-ac03`, hash auto-resolved at parse time).

**Binding rule**: An evidence atom carrying `satisfies:` MUST be paired with at least one *substantive* atom in the same `--evidence` invocation. "Substantive" means any of `commit`, `files`, `test-run`, `tool`, `pr`, `decision`, `callsite-coverage`, `loc-drop`, `url`. **A `satisfies:` atom MUST NOT be paired only with `note:` for gates `implemented` and `testsPassed`** (closing the override-via-note loophole the audit identified in § 2.1 / G9).

**Example**:
```bash
cleo verify T9614 --gate implemented \
  --evidence "commit:abc123;files:src/timer.ts,src/timer.test.ts;satisfies:T9614-ac03,T9614-ac05"
```

**Storage**: A new table `evidence_ac_bindings` (`evidence_id, task_id, ac_id, ac_hash_at_bind, atom_kinds, created_at`) MUST persist each `(evidence row × satisfied AC)` edge. `validateGateVerify` (`engine-ops.ts:307-649`) MUST write to this table inside the same transaction that writes the gate state.

**Rationale**:
- Steal-table § 3 row "Per-AC stable ID + `passes:bool`" (verdict ADOPT) gives the row shape.
- Audit Gap G2 ("No atom binds evidence to a specific AC") is closed directly.
- Pairing requirement prevents the cosmetic-binding antipattern: `note:"I think ac-3 is satisfied"; satisfies:T9614-ac03` is **rejected** at validator time because `note` alone is not substantive for the listed gates.
- Steal-table anti-pattern #4 ("Tests-as-AC-proxy") is mitigated because each test-run can be bound to specific ACs, not blanketly to "the task".

**Rejected alternatives**:
- *Structured mapping on the task record (`task.evidence_to_ac_map`)*: breaks the audit-log model (gates.jsonl is append-only). A separate table is consistent with ADR-051's audit posture. Rejected.
- *Embed AC list inside `commit:` syntax* (`commit:abc123#ac03,ac05`): nested syntax bloats the parser (`evidence.ts:242-441` already has 11 cases per audit § 2.1). Atom-level is cleaner. Rejected.

### D3 — AC↔commit partial-satisfaction declaration

**Decision**: When a commit partially satisfies a task's ACs, the `satisfies:` atom MUST list **only the ACs that commit advances**, not the entire AC set. Multiple `cleo verify` invocations against the same gate are additive — they MUST accumulate `satisfies:` coverage in `evidence_ac_bindings` until every AC is bound by ≥ 1 substantive evidence atom. The gate MAY only flip to `passed` when AC coverage is complete (D5 governs).

The `implemented` gate state machine MUST grow a third intermediate state: `partial` (current states: `pending | passed | failed`). New transitions:
- `pending → partial`: at least one `satisfies:` recorded, AC coverage < 100%
- `partial → passed`: AC coverage reaches 100% with all bound atoms re-validating
- `partial → failed`: any bound atom becomes stale (D6) and re-verify fails

**CLI surface**:
```bash
cleo show T9614            # MUST display per-AC coverage table
cleo show T9614 --ac json  # MUST emit machine-readable [{acId, hash, status, evidence: [{atomKind, ref}]}]
```

**Rationale**:
- Steal-table § 2.1.1 (Ralph `passes: bool` per story) — adopt the per-AC bookkeeping.
- Audit Gap G16 (two parallel verification paths) — by routing both `runGates` results and atom evidence through `evidence_ac_bindings`, the audit's "saga-level unification" recommendation lands here without a separate epic.
- Allows wave-based development where Worker A satisfies AC-1/AC-2 and Worker B satisfies AC-3/AC-4 of the same task.

### D4 — Migration from `acceptance: (string | AcceptanceGate)[]` to typed `AcceptanceCriterion[]`

**Decision**: A new normalized table `task_acceptance_criteria` MUST be introduced:

```sql
CREATE TABLE task_acceptance_criteria (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,              -- 0-indexed; canonical order
  ac_id          TEXT NOT NULL,                 -- 'T9614-ac03'
  ac_hash        TEXT NOT NULL,                 -- 'H7K3MXQ9D2NR'
  text           TEXT NOT NULL,                 -- canonicalized free-text
  gate_kind      TEXT,                          -- nullable; 'test'|'file'|'command'|'lint'|'http'|'manual' if structured
  gate_json      TEXT,                          -- nullable; serialized AcceptanceGate payload
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open'|'bound'|'satisfied'|'stale'|'rejected'
  bound_atom_count INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT,
  PRIMARY KEY (task_id, position),
  UNIQUE       (task_id, ac_id)
);

CREATE INDEX idx_ac_hash ON task_acceptance_criteria(ac_hash);
CREATE INDEX idx_ac_status ON task_acceptance_criteria(task_id, status);
```

And a history table for D6's drift detection:

```sql
CREATE TABLE task_acceptance_criteria_history (
  task_id        TEXT NOT NULL,
  position       INTEGER NOT NULL,
  ac_hash        TEXT NOT NULL,
  text           TEXT NOT NULL,
  superseded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, position, ac_hash)
);
```

**Migration steps** (forward-only; covered by drizzle-kit migration `<ts>_t10271_ac_stable_ids/`):

1. **Schema introduction (no-data)** — create both tables, no `acceptance_json` modifications.
2. **Backfill pass** — single batch over all tasks where `acceptance_json != '[]'`:
   - Parse JSON; for each item compute canonical text (string → trim+collapse-ws; gate → JSON.stringify with sorted keys).
   - Compute `ac_hash = base32(sha256(canonicalText))[:12]`.
   - Generate `ac_id = '${taskId}-ac' + String(position).padStart(2,'0')`.
   - Insert into `task_acceptance_criteria`; preserve gate kind/json if structured.
   - **`acceptance_json` is NOT deleted** — it remains the legacy projection (parallel to GSD-2's "markdown projection" pattern, steal-table § 2.3.5). On task `update --acceptance` the new table is the writer and `acceptance_json` is regenerated from it.
3. **Code refactor scope** (estimated):
   - `packages/contracts/src/task.ts:39` — introduce `AcceptanceCriterion { id, hash, text, gate?, status, ... }`. Keep `AcceptanceItem` exported as a deprecated alias.
   - `packages/core/src/tasks/req.ts:174-280` — `reqAdd`/`reqMigrate` now write through `task_acceptance_criteria`; the per-task uniqueness check now becomes an `(taskId, position)` PK enforcement automatically.
   - `packages/core/src/tasks/evidence.ts:186-219` — add `satisfies` atom kind to `ParsedAtom`.
   - `packages/core/src/tasks/evidence.ts:307-649` — add `evidence_ac_bindings` writes inside the gate transaction.
   - `packages/core/src/tasks/gate-runner.ts:81-114` — `runGates` now reads structured ACs from `task_acceptance_criteria` (not from `acceptance_json`), and writes results back as evidence atom bindings.
   - `packages/cleo/src/cli/commands/show.ts` — render per-AC table.
   - `packages/cleo/src/cli/commands/verify.ts:54-128` — parse `satisfies:`, resolve display IDs.
4. **Deprecation timeline**:
   - **v + 1 release**: schema landed, dual-write, reads still from `acceptance_json` for legacy callers
   - **v + 2 release**: reads switch to `task_acceptance_criteria`; `acceptance_json` becomes derived/diagnostic
   - **v + 4 release**: `AcceptanceItem` alias removed from `@cleocode/contracts`; bumps minor SemVer

**Rationale**:
- ~10,000+ existing tasks: a parallel table with backfill is cheaper than rewriting JSON in place + safer (rollback is `DROP TABLE`).
- Steal-table § 3 row "DB-authoritative `gsd.db`" (verdict ADOPT) — preserves the SSoT direction CLEO already affirmed in T9685 (memory: `MEMORY.md` "T9685 SSoT shipped v2026.5.83").
- Audit Cross-Cutting Risk #1 explicitly calls out this option ("parallel `acceptance_criteria` table"); we take it.

**Rejected alternatives**:
- *In-place JSON rewrite*: 10k+ row rewrite is a single `UPDATE tasks SET acceptance_json = ...` per task — atomic but un-rollbackable without backups. Rejected.
- *Lazy migration on first read*: bug-class is leaky; some tasks get migrated, some don't, evidence atoms have inconsistent resolution. Rejected.

### D5 — `cleo complete` enforcement: REJECT if any AC unbound

**Decision**: `cleo complete <taskId>` MUST reject with new error `E_AC_COVERAGE_INCOMPLETE` (exit code 11) when **any** AC in `task_acceptance_criteria` has `status NOT IN ('satisfied', 'rejected')`.

Override paths:
- `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON=...`: MAY override with `force-bypass.jsonl` audit line (per-session cap from T1501 still applies; shared-evidence flag T1502 still applies).
- `--ac-defer <ac-id>:<reason>`: declares an AC explicitly out-of-scope-for-this-task; writes to `task_acceptance_criteria.status='deferred'` and audit-logs the defer. Deferred ACs MUST be carried over to a follow-up task via `cleo add … --inherit-defers <originalTaskId>` (referenced and detailed in T10272 / ADR-080).
- Marking an AC `rejected` (with reason) means "this AC was attempted and is acknowledged as not satisfiable in this scope" — different from `deferred` (which means "this AC is being moved to another task"). Both are exit ramps with full audit.

**Warn-only is REJECTED**: ADR-051 already proved that warn-only gates regress to rubber-stamp ("any agent can write 'all gates pass'", ADR-051 § Context). The same regression applies here — soft enforcement is non-enforcement.

**Rationale**:
- Steal-table § 3 row "`<promise>COMPLETE</promise>` stop-hook contract" (verdict ADAPT) — `cleo complete` IS the stop-hook in CLEO's model.
- Steal-table anti-pattern #2 ("Override-as-gate") — override remains exceptional and audited; not normalized.
- Audit § 1 Gap G9 ("`CLEO_OWNER_OVERRIDE` still bypasses 4 of 6 gates") — this ADR adds a NEW gate (AC-coverage) that is also auditable but NOT bypassable by the gate-level override path; it has its own narrower override (`--ac-defer`).

**Trade-off analysis**:
| Approach | Risk if too strict | Risk if too loose | Verdict |
|---|---|---|---|
| Hard reject (this ADR) | High friction; agents will request override for spurious ACs | Auditable; explicit | CHOSEN |
| Warn-only | Low friction; regresses to ADR-051 problem | Rubber-stamp returns | REJECTED |
| Conditional (reject for `implemented`, warn for others) | Mixed; partial enforcement | AC-2 (UX) gates get ignored | REJECTED — see D2 pairing rule |

### D6 — AC text drift detection

**Decision**: When an AC's `text` field is edited (via `cleo update --acceptance` or `cleo req edit`), CLEO MUST:
1. Re-compute `ac_hash` from the new canonical text.
2. Append the OLD `(position, ac_hash, text)` tuple to `task_acceptance_criteria_history`.
3. Update `task_acceptance_criteria.ac_hash` to the new value.
4. Mark all `evidence_ac_bindings` for that `ac_id` as **stale** (`status='stale'`).
5. Re-run `validateGateVerify` for any gate that previously had a `satisfies:` binding to that AC. If the *substantive* paired atom (commit, files, etc.) re-validates AND the new AC text still matches the evidence's semantic intent: human-confirm via `cleo ac rebind T9614-ac03 --confirm`. If not: the gate flips to `failed` and the parent task re-opens.

**Hash-vs-positional resolution**:
- `satisfies:T9614-ac03` (display ID, no hash): always resolves to the CURRENT positional AC. Subject to silent rebinding on reorder. CLI MUST emit a WARN when accepting this form alongside an AC-edit within the last 24h.
- `satisfies:T9614-ac03@H7K3MXQ9D2NR` (full stable ID): pinned to the historical text. If the current `ac_hash` for that position differs, the gate flips to `stale` immediately on next `cleo show` or `cleo complete`. This is the **preferred** form for orchestrator HITL approvals and audit trails.

**Rationale**:
- Steal-table § 3 row "`gsd.db` DB-authoritative + `deriveStateFromDb()`" (verdict ADOPT): the DB is the source of truth, and projections (canon docs, markdown, agent prompts) MUST resync on AC edits.
- Audit Cross-Cutting Risk #4 ("Override audit-log noise") — drift detection adds events to an existing audit channel without inventing a new one.
- The steal-table § 4.3 (Letta Code memory-as-git) was REJECTED for storage, but its **insight** (memory MUST be diffable) lands here as the `_history` table.

**Rejected alternatives**:
- *Soft rebind on edit (just update the hash silently)*: the entire ADR collapses; an orchestrator could rewrite ACs post-hoc to "match" already-shipped evidence. Catastrophic. Rejected.
- *Forbid AC editing on tasks with bound evidence*: blocks legitimate refinement. Rejected.

---

## 3. Consequences

### 3.1 Migration cost

- **DB**: Two new tables (`task_acceptance_criteria`, `task_acceptance_criteria_history`) + one new junction table (`evidence_ac_bindings`). Plus history table. Total: 3 new tables. Drizzle-kit migration is straightforward; backfill is single-pass over `tasks` table (~10k rows on flagship CLEO project; well under 1 minute on local SQLite).
- **Contracts**: One additive type (`AcceptanceCriterion`); `AcceptanceItem` becomes a deprecation alias (no breaking change in v + 1; removal in v + 4).
- **Core code**: ~6 files modified (per D4 list); LOC change estimated ≤ 800 lines net (most is `task_acceptance_criteria` accessor + `satisfies:` parser).
- **CLI surface**: One new sub-command (`cleo ac` family — `show`, `list`, `rebind`, `defer`), two flag extensions (`--ac-defer`, `--ac json` on `cleo show`).
- **Documentation**: Pre-Complete Gate Ritual block in `~/.cleo/templates/CLEO-INJECTION.md` MUST be updated; ADR-051 § "Pre-Complete Gate Ritual" is partially superseded.

### 3.2 Breaking changes

- **None in v + 1 dual-write window**.
- **In v + 2**: any third-party tool reading `acceptance_json` directly sees stale projection; they MUST migrate to reading `task_acceptance_criteria` via the dispatch surface.
- **In v + 4**: `AcceptanceItem` alias removed — SemVer minor bump (additive removal of legacy alias following 4-release deprecation runway).

### 3.3 Performance impact

- **Read path**: `cleo show <id>` adds one `SELECT … WHERE task_id = ?` to `task_acceptance_criteria`; indexed PK; negligible.
- **Verify path**: `cleo verify` parses `satisfies:` atoms (string-split + 3 SHA-256 hash-checks per AC). Cost: < 1ms per verify call on local SQLite.
- **Complete path**: `cleo complete` adds one `SELECT COUNT(*) WHERE task_id = ? AND status NOT IN (...)`. Indexed; < 1ms.

### 3.4 Agent UX changes

**Before**:
```bash
cleo verify T9614 --gate implemented --evidence "commit:abc;files:src/timer.ts"
cleo complete T9614  # silently succeeds even if AC-3 was never touched
```

**After**:
```bash
cleo verify T9614 --gate implemented \
  --evidence "commit:abc;files:src/timer.ts;satisfies:T9614-ac01,T9614-ac02"
cleo verify T9614 --gate implemented \
  --evidence "commit:def;files:src/timer.test.ts;satisfies:T9614-ac03"
cleo complete T9614
# E_AC_COVERAGE_INCOMPLETE: AC T9614-ac04 has no bound evidence.
# Run: cleo show T9614 --ac
# Or: cleo complete T9614 --ac-defer T9614-ac04:"superseded by T9700"
```

Agents MUST learn to think AC-by-AC, not commit-by-commit. **This is the intended cognitive shift**; it directly implements the steal-table § 2.1.4 critique ("ralph's `passes:bool` is self-attested by the same agent — we leapfrog by binding to evidence atoms").

### 3.5 Auditability

- `evidence_ac_bindings` becomes the primary table for "did the worker actually satisfy AC-X?" queries.
- `task_acceptance_criteria_history` becomes the primary table for "did the AC text drift after evidence was bound?" queries.
- Combined with ADR-051's `.cleo/audit/gates.jsonl` + Ed25519 signing (T947), this gives end-to-end AC↔commit↔gate provenance.

### 3.6 Interactions with sibling ADRs (this saga)

- **T10272 / Validator role**: when shipped, the Validator agent's verdict MUST be expressible as a per-AC pass/fail array, writing rows to `evidence_ac_bindings` with `atom_kinds='validator-verdict'`. This ADR's `satisfies:` atom kind is the natural interface.
- **T10273 / Docs-as-validator**: when shipped, a `spec:<docId>` atom MUST be addable to the substantive-atom set for `satisfies:` pairing. This ADR's `evidence_ac_bindings.atom_kinds` is the seam.
- **T10274 / CORE tools**: when shipped, the `validateAcCoverage` function MUST be exposed as a first-class SDK tool (Category A LLM-callable). This ADR ships the function in `packages/core/src/tasks/ac-coverage.ts`.

---

## 4. Migration plan (concrete)

### Step 1 — Schema migration (1 PR)

- Drizzle-kit generate: `<ts>_t10271_ac_stable_ids/migration.sql` + `revert.sql`.
- Creates `task_acceptance_criteria`, `task_acceptance_criteria_history`, `evidence_ac_bindings`.
- No data touched. Idempotent.

### Step 2 — Contracts + types (1 PR)

- `packages/contracts/src/task.ts:39`: add `AcceptanceCriterion` interface; keep `AcceptanceItem` alias.
- `packages/contracts/src/evidence-atom.ts` (new file or extension): add `satisfies` to `ATOM_KINDS`.
- `packages/contracts/src/ac-coverage.ts` (new): `AcCoverageReport`, `AcStatus` enum.
- Register new types in `BOUNDARY_REGISTRY` (audit § 5 Cross-Cutting Risk #6).

### Step 3 — Core write/read path (1 PR per scope)

- 3.a: `packages/core/src/store/accessors/ac-store.ts` — CRUD + history append on edit.
- 3.b: `packages/core/src/tasks/evidence.ts:186-219` — parse `satisfies:` atom; pairing-rule validator.
- 3.c: `packages/core/src/validation/engine-ops.ts:307-649` — write `evidence_ac_bindings` rows inside gate transaction.
- 3.d: `packages/core/src/tasks/complete.ts:1089` — call `validateAcCoverage(taskId)` before status flip; emit `E_AC_COVERAGE_INCOMPLETE` on failure.
- 3.e: `packages/core/src/tasks/req.ts:174-280` — `reqAdd`/`reqMigrate` write through new accessor.
- 3.f: `packages/core/src/tasks/gate-runner.ts:81-114` — `runGates` consumes new table.

### Step 4 — Backfill (1 PR, blocking on Step 3)

- One-shot script (`scripts/backfill-ac-criteria.mjs`): iterate `tasks` with non-empty `acceptance_json`; for each item compute canonical text + hash + ID; bulk insert into `task_acceptance_criteria`.
- Idempotent (uses `INSERT OR IGNORE ON (task_id, position)`).
- Reversible via `DELETE FROM task_acceptance_criteria` — `acceptance_json` is untouched.

### Step 5 — CLI surface (1 PR)

- `cleo verify` parser extended.
- `cleo show` per-AC table render.
- `cleo ac` sub-command (show / list / rebind / defer).
- `cleo complete --ac-defer <ac-id>:<reason>` flag.
- Update `cleo --help` strings.

### Step 6 — Tests (gates this saga at the testsPassed evidence level)

- Unit: `evidence.ts` `satisfies:` parser; `validateAcCoverage`; AC hash canonicalization; drift detection on edit.
- Integration: end-to-end `cleo add → cleo verify with satisfies → cleo complete` happy path AND the rejection path.
- Regression: existing ~30 `cleo verify` tests MUST still pass with `acceptance_json` reads (legacy code path during v + 1).

### Step 7 — Doc updates (1 PR)

- `AGENTS.md` "Pre-Complete Gate Ritual" — add `satisfies:` to example.
- `~/.cleo/templates/CLEO-INJECTION.md` — same.
- `.cleo/spec/ac-stable-ids.md` — full grammar spec (canon doc, kind `spec`, published via `cleo docs add --type spec --slug ac-stable-ids`).
- ADR-051 — add "See also: ADR-079" pointer in § Pre-Complete Gate Ritual.

### Step 8 — Release gating

- AC of T10271 (this task) requires: schema landed, dual-write working, backfill verified on a sample project (e.g. `t9685-ssot` epic's 12 tasks). Per-task evidence: `commit:<sha>;files:<list>;tool:test;tool:lint;tool:typecheck;satisfies:T10271-ac01,T10271-ac02,...`.
- Ships in release `v2026.6.x` (no earlier than 1 release cycle after T10271 closes).

---

## 5. References

### Slugged research artifacts (Wave 0 inputs)
- `ivtr-external-systems-steal-table` (T10269): § 2.1 Ralph `prd.json`, § 2.2 Letta-Evals, § 2.3 GSD-2 DB-authoritative, § 3 STEAL TABLE rows for ACs and `<promise>COMPLETE</promise>`, § 4 Anti-Patterns #1–#10.
- `ivtr-current-state-audit` (T10270): § 1 Top 5 Gaps, § 2.1 ADR-051 atom grammar, § 2.2 AC handling, § 3 GAP TABLE rows G1, G2, G3, G9, G16, § 5 Cross-Cutting Risks #1, #6, #7.
- `t9154-consensus` (T9154): § 2.7 Critical Fixes Before Swarm (validates orchestration substrate is ready for this layer).

### ADRs cited
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` — atom grammar, override audit, --force removal (this ADR extends).
- `.cleo/adrs/ADR-070-verifier-backed-ac-auditor-loop.md` — verifier-backed AC auditor (this ADR provides the schema it consumes).
- `.cleo/adrs/ADR-066-task-taxonomy-consolidation.md` — `--acceptance` is required on ALL tasks; this ADR makes that requirement structurally enforceable.
- `.cleo/adrs/ADR-073-above-epic-naming.md` — task hierarchy charter; ACs are at the Task tier per I1.

### Code anchors (file:line)
- `packages/contracts/src/task.ts:39` (`AcceptanceItem` union)
- `packages/contracts/src/acceptance-gate.ts:31` (`GateBase.req`)
- `packages/contracts/src/spawn-types.ts:90-123` (`CLEOSpawnAdapter`)
- `packages/core/src/store/schema/tasks.ts:135` (`acceptance_json`)
- `packages/core/src/tasks/evidence.ts:186-219` (`ParsedAtom`), `:307-649` (`validateGateVerify`), `:551-622` (`validateCommit`), `:810-876` (`checkCommitContentIntersect`)
- `packages/core/src/tasks/req.ts:174-280` (`reqAdd/reqMigrate`)
- `packages/core/src/tasks/gate-runner.ts:81-114` (`runGates`)
- `packages/core/src/validation/engine-ops.ts:307-649` (gate.set entry), `:463-485` (critical-gate override block)
- `packages/core/src/tasks/complete.ts:1089` (complete handshake)
- `packages/cleo/src/cli/commands/verify.ts:54-128` (CLI parser)

### Open questions deferred (NOT this ADR)
- **DEFERRED — needs spike T10275**: should `satisfies:` atom support cross-task binding (`satisfies:T9614-ac03,T9700-ac01`)? Would enable a task's evidence to count toward a related task's AC. Risk: turns the AC graph into a DAG. Spike to scope before deciding.
- **DEFERRED — needs spike T10276**: should AC text canonicalization include lowercase normalization, or only whitespace? Affects hash stability under "typo-fix" edits. Spike to gather data on real-world AC-edit patterns from `.cleo/audit/gates.jsonl`.

---

*End of ADR-079.*
