# T12342 + T12343: HLC replication metadata and the captured, signed change journal

**Status**: v11.7 (v11.7 narrows `triggerSetHash` to owned triggers, T13298; v11.6 lets the origin of a settled uid collision re-mint the loser's counter key, T13405; v11.5 makes a `retire` count only once the server confirms it, T13366; v11.4 narrows the K trigger so an identity fill never captures a K, T13311). v11.1 was APPROVED by cleo-dev (round 10), 2026-09-29; v11.2 adds the §3.6 summary of the T12859 write-validator inventory (not yet reviewed); v11.3 records cleo-dev's S2 rulings (a)–(c) from the shadow-mode measurements (§0.13). Design only; implementation follows `t12343-journal-builder-checklist`.
**Tasks**: T12342 (HLC, origin, version, tombstones, uniform timestamps), T12343 (signed outbox covering every synced mutation, with a per-write bypass check). Epic T12323, saga T12320.
**Builds on**: Gate A registry (`packages/core/src/store/table-classification.ts`, T12332), the uid scheme (`t12341-uid-scheme` v7, T12341), Gates B/C (`cleo-nexus/docs/research/gates-b-c-spec.md`), ADR-095 and the cloud contract (`cleo-nexus/packages/shared/src/api.ts`, `ids.ts`), the core cloud client (`packages/core/src/cloud/*`), the write chokepoints (`openDualScopeDb`, `sqlite-data-accessor.ts` with #1698 CAS, #1701 claim leases, #1706 `insertNewTask`), and gate 28 (`scripts/lint-no-raw-table-writes.mjs`).
**Consumed by**: T12344 (merge engine), T12338 (checkpoints and elected writers), T12345 (shared projects).
**Read at**: cleocode `origin/main` 7e752fb68 (2026-09-29 15:15 PDT). The local checkout at `~/projects/cleocode` is 141 commits behind; every file reference below was read from `origin/main`.
**Decisions**: schema and design choices are team decisions reviewed by cleo-dev. Section 7 lists the open ones as options with a recommendation.

## Goal

Every change to a row that syncs is recorded, in the same SQLite transaction, as an op that carries a hybrid logical clock, its origin, and a before-image. No writer can skip the record: a raw SQL site, a Drizzle call outside an accessor, Studio's own connection, or an older CLEO build. Ops are netted, grouped by transaction, built into signed and encrypted segments, pushed idempotently, and handed to the merge engine on receive. The bypass check makes every write that skipped the chokepoint visible, and it drives gate 28's raw-writer baseline down to zero for synced tables.

## Requirements

- R1 (T12342 AC1): every sync-set row carries an HLC, an origin replica and a version.
- R2 (T12342 AC2): deleting a sync-set row or edge leaves a tombstone.
- R3 (T12342 AC3): one timestamp format across the sync-set tables, migrated.
- R4 (T12343 AC1): an op row is written in the same transaction as every sync-set mutation, whoever wrote it.
- R5 (T12343 AC2): a cross-check proves, in the test suite, that no sync-set change bypassed capture.
- R6 (T12343 AC3): ops carry the replica id, a before-image, and a signature.
- R7 (T12341 §5.2): no HLC is ever read from a uid.
- R8 (T12341 §6.3): a delete and a re-insert of the same uid inside one transaction net to "no change" or to an update of non-key columns. They never become a tombstone plus an insert.
- R9 (T12341 §12.1): `row_identity_synced` is written before the first uid leaves the device, and on the first receive.
- R10 (T12341 D3): the merge key is (project, uid).
- R11 (cleo-dev condition 1): capture goes through the existing chokepoints only. Domain code gets no new write API and no parallel write path.
- R12 (condition 2): the bypass check rides on gate 28 and drives its baseline down. Every raw writer is moved behind a chokepoint or exempted with a reason.
- R13 (condition 3): every slice ships behind a flag that is OFF by default until Gate B replay passes on cleocode, llmtxt and claude-todo.
- R14 (condition 4): slices that touch the hot add, update and complete paths are named in advance (§5.3).
- R15 (review H4): no structural state (missing tables, dropped columns, renames) can leave a capture trigger that breaks writes; DDL owners drop and reinstall triggers (§2.3a).

## Non-Goals

- Merge rules, conflict typing, apply order across references, and display-id re-mint authority belong to T12344. This spec defines what T12343 hands over (§3).
- Checkpoint authoring, the manifest's uid-keyed content hash (Gate D) and elected writers belong to T12338. This spec only guarantees that segment deltas satisfy the server's regression rule.
- Uids, birth fingerprints and aliases belong to T12341.
- Memberships and per-project key distribution belong to T12345.
- The git transport (`refs/cleo/ledger`) reuses the same segments. Its ref plumbing is out of scope.

## Out-of-Scope

- Tables whose uid is still pending in `ROW_IDENTITY` (T12341 §10). They join the sync set when their identity is declared (§2.1).
- `frozen-legacy` bare twins. They never capture.
- Changing column DEFAULTs from `datetime('now')`: that needs a table rebuild (T12541). The sealer canonicalizes instead (§1.7).
- Current learned weights for STDP (the registry's follow-up). `brain_plasticity_events` and `brain_weight_history` stay local-only.

## 0. Inputs, rulings and review map

### 0.1 Classification facts used here (registry on `origin/main`)

| Scope | portable-project | portable-personal | portable-secret | local-only | derived |
|---|---|---|---|---|---|
| project | 69 tables | 32 | 1 (`tasks_agent_credentials`) | 25, plus 35 frozen-legacy | 10, plus the FTS5 and vec0 pattern families |
| global | 0 | 38 | 6 (`accounts`, `agent_registry_accounts`, `agent_registry_org_agent_keys`, `agent_service_grants`, `service_configs`, `service_connections`) | 28 | 4, plus the patterns |

Column overrides matter to capture:
- `tasks_tasks`: the claim-lease columns (`claimed_by_session`, `claimed_by_agent`, `claimed_at`, `lease_expires_at`, #1701) are local-only. `verification_json` is `strip` at `$.evidence.*.atoms[*].resolvedPath`.
- Secret columns: `tasks_playbook_approvals.token`, `tasks_sessions.owner_auth_token`, `agent_registry_agents.{webhook_secret, api_key_hash, api_key_encrypted}`, plus every column of the whole-table secrets.
- Local-only columns on portable tables: `tasks_commits.project_hash`, `nexus_project_registry` path and stat columns, `skills_skills` path columns, and others.
- Row routing: `peer_scope` on the brain families. Its value-to-class map is still pending.

Volumes (Gate B baseline, 2026-09-28): cleocode has 118,483 project rows, 6,126 personal, 3 secret, 132,078 local-only and 996,241 derived. llmtxt has 18,229 project rows and 1,739 personal. claude-todo (a scratch copy of the migration-share store, 157 tables, 5,330 tasks) has 21,227 project rows, 7,364 personal and 19,031 local-only.

### 0.2 Classification rulings this spec follows

cleo-dev decided these rulings in the v2 review, under the owner's rule. The following tables are **portable-personal**:
- `brain_patterns`;
- `token_usage` and `tasks_token_usage`;
- `brain_plasticity_events` and `brain_weight_history`.

Where other documents still disagree:
- The registry on `origin/main` still marks the two STDP tables `local-only` and `token_usage` `needs-owner-call`. The registry change lands in its own PR before S2, and the Gate A test pins it. Gate 28's class split changes with it (§4.6).
- ADR-095 §1 and the Gates B/C spec ("Risk 4") call `brain_patterns` derived and `token_usage` local-only. ADR-095 also calls embeddings derived, but the registry has `brain_embeddings` as `portable-personal`; only its vec0 shadow tables are derived.
- The team lead corrects ADR-095 in cleo-nexus PR #12. The Gates B/C spec needs the same correction.

Consequences for this spec:
- `brain_patterns` has in-place counters. They need a field-level merge rule (sum or max), which is noted for T12344. Ops carry counter columns as increments (§2.6).
- The STDP event tables are append-only and have seen 14M+ inserts over their lifetime. They set the op-rate ceiling (§6), and their retention is Q15.

### 0.3 What the cloud contract already fixes

- `Hlc` (`ids.ts`) is `^\d{13}-\d{6}-[0-9a-f-]{36}$`: 13-digit wall milliseconds, a 6-digit counter and the replica id, so lexical order is causal order.
- `ReplicaId` is a UUIDv7 per `cleo.db` store, not per machine. A worktree copy is a separate replica.
- Streams: `project:<projectId>` carries portable-project ops. `home:<userId>` carries portable-personal ops.
- `AppendSegmentRequest`:
  - `replicaSeq` is gap-free per replica;
  - (replica, segmentHash) is the idempotency key;
  - it carries `schemaVersion`, `opCount`, `hlcMin`/`hlcMax`, and `deltas: TableDeltas` (`{created, deleted}` per table name matching `^[a-z][a-z0-9_]{0,62}$`);
  - the Ed25519 signature is `segment/v2` over the metadata hash today; §2.11 moves it to `segment/v3`, which covers `txnDeltas`.
- The checkpoint regression rule (`manifest-check.ts:34-61`) is `rows == parent + Σcreated − Σdeleted` for every table. It holds only for a single writer; §2.11 proposes the change.
- `Journal.push` is safe to retry only with the same `sealed` bytes: re-sealing uses a random salt and nonce, which changes the hash.
- `Journal.pull` verifies ordering, signature, pins and hash. It returns a `PullCursor` that the caller must persist in the same local transaction as what it applies.

### 0.4 Review response map (v2 → v3, cleo-dev FIX-FIRST)

cleo-dev tracks H1–H5 as tasks under T12323, and T12343 depends on all five. T12755 also depends on T12341.

| Item | Task | Fix | Where |
|---|---|---|---|
| H1 the echo stamp deleted local captures | T12751 | The trigger never deletes. The stamp records `kind='apply'`. The sealer drops only captures matched, image for image, to an inbox op applied in that frame. Apply bodies are synchronous. The frame is validated by a main-table frame row. | §2.3, §2.5, §3.2, §3.3 |
| H2 `checkManifest` holds only for a single writer | T12752 | Applied-effect accounting: checkpoints carry signed, bounded adjustments (void and pending counts), verified exactly by endorsing devices. The server change is specified. Must be agreed with T12338/T12344 before S4. | §2.11 |
| H3 copies re-emit inherited ops; `st_dev` unstable | T12753 | A new replica never re-emits inherited rows. It reconciles via a checkpoint diff. Binding is inode + birthtime + a persisted nonce, plus a device high-water mark. Retire announcements. Backup, scratch and `VACUUM INTO` opens skip the sync open pass. | §1.5, §2.9 |
| H4 "never fails a write" is false | T12754 | Structural-safety rules: the migration runner drops and reinstalls triggers in the same transaction; tables are created before triggers and triggers dropped before tables; a doctor check for orphaned triggers; the T12341 rollback is amended; DROP COLUMN, RENAME and missing-table tests. | §2.3a, §5.2 |
| H5 T12341 dependency, invisible re-keys, `bfp` only on I, refs at seal, fill order | T12755 | Explicit dependency gate. A `K` (re-key) op captured by an identity trigger, with row-meta migration. `bfp` on every minted-row op. Refs translated at capture in pure SQL. A capture reads the uid from the live row, and a fill-patch trigger covers both trigger orders. | §2.3, §2.4, §2.6, §5.2 |
| M1 REPLACE through a secondary UNIQUE loses the D | — | `recursive_triggers=ON` on chokepoint connections after a trigger audit. Foreign REPLACE is caught by the ledger. The lineage carry-forward marks the table suspect. | §2.3 |
| M2 skew hold | — | Per replica, FIFO behind the held head. | §1.3 |
| M3 kill switch flaps triggers | — | The env var stops seal and push only. Triggers change only through the persisted flag. | §2.3 |
| M4 TZ-dependent parsing; CAS token rewrite | — | A strict canonicalizer refuses zoneless `T` values. No seal-time local rewrite. `tasks_tasks.updated_at` is excluded from the migration. | §1.8 |
| M5 synthetic groups vs 1 MiB | — | Never split below the blob cap. The split rule and atomicity loss are stated. | §2.4 |
| M6 `chash` leaks secret hashes | — | Secret columns excluded from `chash`. A separate `shash` is an HMAC under a device key and is stripped from checkpoint bundles. | §1.6, §2.7 |
| M7 exemption granularity, W3 sites, AGENTS.md | — | Exemptions per (file, table). W3 staged-snapshot sites are marked per site. The AGENTS.md row 28 update is in the S0 PR. | §4.6 |
| M8 changeset blind spots | — | Listed, each with its compensating check. | §4.5 |
| L1–L5 | — | twin-collapse precedent; ADR-095 embeddings note; json_object chunking; −0.0 test; `.backup` keeps the inode | §2.2, §0.2, §2.3, §2.3, §1.5 |
| Q9, Q11 | — | Decided (portable-personal). Counters are a T12344 note. STDP retention is Q15. | §0.2, §7 |

### 0.5 Round 2 response map (v3 → v4, cleo-dev APPROVE-WITH-CONDITIONS)

S0 and S1 may proceed. Each item below is a blocking task that T12343 depends on.

| Item | Task | Fix | Where |
|---|---|---|---|
| H1 completion: enforce "synchronous" | T12751 | `withApplyFrame` and `sealPending` phase B go through `taskTransactionQueue`; a `PromiseLike`-excluding type plus a runtime thenable check does ROLLBACK and throws; all crypto (secret key derivation, machine-key encrypt and decrypt) happens before the frame (phase A) | §2.5, §2.7, §3.2 |
| L4 completion | — | `-0.0` becomes `0.0` (sign not kept, documented); the `$r` parser accepts `Inf` / `-Inf` / `+Inf` | §2.3, §2.6 |
| N1 exact-image echo under-drops | T12757 | `_sync_apply_intent` per (frame, tbl, uid, col, enc); the sealer subtracts field by field; only residual fields get new HLCs; secret sentinel; declared trigger-derived columns | §3.2, §3.3, §2.4, §2.7 |
| N2 live tallies differ per replica | T12758 | Tallies by deterministic replay from the parent checkpoint plus the window, run by author and endorser alike; a pending age bound the server can check; bugs-not-malice stated; single-device self-check | §2.11 |
| N3 a ref subquery breaks a rebuild of the referenced table | T12759 | `SYNC_TRIGGER_REFS`; suspend all capture triggers around DDL on captured **or referenced** tables; the doctor compares referenced tables; Gate B with a real released binary | §2.3a |
| N4 NEW.uid / NEW.birth_fp NULL in AFTER INSERT | T12760 | Identity read from the live-row subquery; `_f` patches `birth_fp` too | §2.3 |
| N5 birthtime 0 or equal to ctime | T12761 | Store NULL at bind in those cases; compare only when both are non-NULL | §1.5 |
| N6 registry path and authority | T12762 | Path from `packages/paths` (gate 2), machine-local, keyed by device id; the server's `lastReplicaSeq` is authoritative (same seq, different hash → rebind); registry loss alone never rebinds; same nonce at a new realpath while the original exists → copy | §1.5 |
| N7 reconcile rule | T12763 | Three-way per field; the break of per-replica HLC monotonicity for `via: 'rebind'` is stated; S4 gated on T12344 and T12338 | §1.5, §5.2 |
| N8 clear-and-refill K storm | T12764 | Refill with capture suspended and pending captures remapped; K(x→NULL)+fill nets to K(x→y); K on never-sent uids dropped (`sent` flag) | §2.4, §1.6 |
| N9 recursive_triggers fires DELETE triggers on REPLACE | T12765 | Audit of AFTER DELETE triggers × REPLACE writers; UPSERT at those sites **before** recursion is on; a lint rule forbids new REPLACE on such tables | §2.3 |
| N10, N11 frame rows; `_f` scope | T12766 | Read-only transactions delete their frame row; the sealer GCs frame rows; frame cost in §6; `_f` patches only the latest live I capture of that key | §2.3, §6 |
| Q15–Q18 | — | Decided (a); Q15 prune keyed on a replicated column with void late inserts; Q17 doctor prompt; Q18 hard requirement | §7, §3.2 |

### 0.6 Round 3 response map (v4 → v5, cleo-dev APPROVE-WITH-CONDITIONS)

S0 and S1 proceed. S2 is blocked on A and B, and S4 on C and D. T12343 depends on T12774–T12780.

| Item | Task | Fix | Where |
|---|---|---|---|
| Wording: registry hwm in §2.9 | — | §2.9 now defers to the server-authoritative rule | §2.9 |
| Wording: N7 case 1 | — | Also counts inherited sealed-but-unpushed `_sync_op` rows | §1.5 |
| Suspension concurrency | — | Single-transaction brackets are **required** (a second connection waits, and its later write is captured); staged rewriters hold the writer lease and mark tables suspect | §2.3a rule 1 |
| A: FK cascade in migrations (HIGH) | T12774 | `foreign_keys=OFF` **before** BEGIN, `foreign_key_check` before COMMIT, then restore; the same for exodus migrate/reconcile; a CASCADE-child rebuild test in S2 | §2.3a rule 2 |
| B: data written inside suspension | T12775 | Migration backfills are not emitted (chash re-baselined by `SYNC_SET_VERSION`); other rewriters compare `total_changes()` and mark their declared touch set suspect → repair ops; optional session conversion | §2.3a rule 3 |
| C: voiding loses data (HIGH) | T12776 | Window defined by cadence; no age voiding; cross-stream and cross-project refs are soft; split parts never voided while their replica lives; void is revivable, and the author re-emits | §2.11 §5–6, §3.2 |
| D: guards in replay | T12777 | A guard refusal becomes void plus a conflict; replay pinned to `schemaVersion` and `guardSetHash`; the endorser reports `cannot-verify`, not tamper; note for T12341 on `session_handoff_no_update` | §2.11 §7, §3.2 |
| E: FK-action echoes | T12778 | Intents for the FK-action closure plus child-first D ordering; a non-deterministic trigger write in apply is a hard test error | §3.2 |
| F, G: intent value; remap propagation | T12779 | Intents from `RETURNING enc(...)` (the stored value); `remapPending` rewrites ref-uids and `bfp` in pending captures and unsegmented ops | §3.3 |
| H, I: seal-time refs fallback; genesis cut | T12780 | Replay-the-capture-log ref translation held as the fallback if S2's Gate B fails; genesis cut folds pre-genesis captures and ops | §2.3a rule 6, §2.11 §10 |
| Q19 = (b), Q20 = (a) | — | Exact TxnRef pending with per-transaction declared deltas; the self-check replays from the server-downloaded bundle; unendorsed stays visible | §2.11, §7 |

### 0.7 Round 4 response map (v5 → v6, cleo-dev FIX-FIRST)

Three of the four HIGH findings were introduced by v5 fixes. S0 and S1 are unaffected. T12343 depends on T12781–T12786.

| Item | Task | Fix | Where |
|---|---|---|---|
| NEW-1 FK check fails on pre-existing orphans (HIGH, measured) | T12781 | Snapshot the violations on the scope (rebuilt tables plus FK children) before the DDL; fail only on new ones; `fk_orphans` doctor check | §2.3a rule 2 |
| NEW-2 pending can't tell never-seen from deleted (HIGH) | T12782 | Never-seen pends; tombstoned is `dangling-ref` plus a revivable void; aliased resolves; GC keeps minimal tombstones and full ones referenced by pending or void; dependency-scoped holds, not head-of-line | §3.2, §1.7, §2.11 §5 |
| NEW-3 fresh-HLC re-emit overrides merge winners (HIGH) | T12783 | Never re-emit merge-decided voids; revival replays the original op; conflict voids resolved by an explicit write frame or re-emitted with ORIGINAL HLCs | §2.11 §6 |
| NEW-4 FK-closure intents hide a third replica's child (HIGH) | T12784 | Intents only for children whose D is in the transaction; a parent with live children is a void plus a `delete-with-live-children` conflict; cascade accounting class in replay | §3.2 |
| NEW-5 `migrateSync` has its own BEGIN; exodus rules contradict | T12785 | Statement loop with our own journal inserts (parity test); the bracket owns BUSY retry; exodus is one bracket per stage plus lease and suspect for the run | §2.3a rules 1–2 |
| NEW-6 FK OFF persists on a pooled handle | T12786 | Restore in `finally`, read back, assert `!isTransaction`; open and accessor assert `foreign_keys = 1` | §2.3a rule 2 |
| NEW-7 fk_check cost (1.3 s / 3M rows) | T12786 | Scoped, and only when the batch rebuilds | §2.3a rule 2 |
| NEW-7(d) REPLACE into FK-CASCADE parents (live bug) | T12787 (cleo-dev), T12765 | The audit and lint also cover REPLACE into FK parents | §2.3 |
| NEW-8 order, determinism, touch sets | T12786 | Repair diff before the `chash` re-baseline; lint for non-deterministic functions in migration DML; touch sets generated from the FK and trigger closure | §2.3a rule 3 |
| NEW-9 `guardSetHash` undefined | T12786 | `replayPin = {drizzleHead, triggerSetHash}` with normalized hashing; `cannot-verify` only above the endorser's head | §2.11 §7 |
| Contradictions | T12786 | §0.3 and §2.8 say `segment/v3`; §7 Q15 and Q16 updated; §4.5 backfill row aligned with B; `_sync_inbox.status` gains `pending` and `void`, with retention; `_sync_capture.state` gains `folded`; §2.4 part order is the hard requirement | as listed |
| LOW: soft refs, genesis | T12786 | `_sync_soft_ref` side table; genesis cut per stream, with `genesis_source_seq` | §3.2, §2.11 §10 |

### 0.8 Round 5 response map (v6.1 → v7, cleo-dev FIX-FIRST, narrower)

Already fixed in v6: NEW-6, NEW-7 (except the DML scope), NEW-8, the contradictions, and the soft-ref and genesis LOWs. S0 and S1 are unaffected. T12343 depends on T12794–T12797.

| Item | Task | Fix | Where |
|---|---|---|---|
| R5-1 void decisions depend on apply order; own echo skipped (HIGH) | T12794 | Predicates evaluated on stream-derived state only; own echoes staged and applied; rewind, apply and replay rebase of unsequenced local transactions; compensating frame for a voided own transaction; 3-replica, both-orders test plan | §3.1, §3.5, §3.2 |
| R5-2 violation snapshot keyed by rowid (HIGH, measured) | T12795 | Multiset keyed by (table, child PK values, fkid, parent, FK values), or the full row for PK-less tables; rowid-gap rebuild test | §2.3a rule 2 |
| R5-3 statement loop must be journal-identical | T12796 | Select by name; hash the raw file; `created_at = folderMillis`, name, `applied_at`; `upgradeSyncIfNeeded` and `reconcileJournal` inside the bracket; T12687 guard and duplicate-column recovery kept; multi-folder; drizzle pinned; parity tests on fresh, v0, stamped, drifted and two-folder stores; live count read via `cleo doctor migrations`, never a literal | §2.3a rule 2, §5.1 |
| R5-4 DML under FK OFF doesn't cascade | T12797 | FK OFF only for rebuild batches; DML-touched tables and their FK children in scope; lint for parent DELETE in a rebuild batch | §2.3a rule 2 |
| R5-5 tombstone size and growth | T12797 | ~190 B corrected; S2 measures delete rates; no per-row tombstones for append-only and pruned tables; exact horizon fold into `_sync_tomb_fold` | §1.7 |
| R5-6 author can't see other inboxes; double apply | T12797 | Bundles carry unresolved void and pending entries; revival and re-emit deduplicated by TxnRef (`reemitOf`) | §2.11 §6 |
| R5-7 only sync-set children count; hard deletes | T12797 | Sync-set children only, judged on stream state; per-table `onRemoteParentDelete` (`conflict` / `cascade-with-ops`) with a Gate test; resolutions are LWW writes; purge, GC and conduit topics are `cascade-with-ops` | §3.2 |
| R5-8 `replayPin` gaps | T12797 | Whole ordered journal `(folderMillis, name)`; transition points for mid-window migrations; unknown-migration and drift classes (never tamper); literal-safe tokenizer | §2.11 §7 |
| R5-9 wording | T12797 | Holds versus guard triggers and K ops; soft-ref rows store NULL or the local key, with the uid only in the side table | §3.2 |

### 0.9 Round 6 response map (v7 → v8, cleo-dev FIX-FIRST, scoped to §3.5 plus R5-4)

R5-2, R5-3 and R5-5 to R5-9 are fixed. S2 may proceed once R6-6 (T12809) is fixed. T12343 depends on T12807–T12810.

| Item | Task | Fix | Where |
|---|---|---|---|
| R6-1 rewind releases live claims (HIGH) | T12807 | Own-echo fast path (no rewind); side-effect triggers suspended in rewind and replay, guards only in apply and replay; local-only columns restored from `after_full` | §3.5 Rules 3–4 |
| R6-2 rewind source undefined (HIGH) | T12807 | Local undo log `_sync_undo` with full before and after images (local-only, secret ciphertext, strip columns); dropped when the echo applies; fallback refuses secret and strip rows with `cannot-compensate`; FK-safe order under deferred FKs | §3.5 Rule 2, Rule 4 |
| R6-3 rewound-not-replayed rows cause spurious repair D (HIGH) | T12808 | `held` flag in row meta and the ledger; the ledger check, repair diff and Gate D skip held rows | §3.5 Rule 5, §4.3, §4.4, §1.6 |
| R6-4 full-backlog rebase blocks writers (HIGH) | T12808 | Footprint-scoped rebase in bounded pages; append-only tables never rewound; own-echo fast path; 7-day offline benchmark | §3.5 Rule 3 |
| R6-6 per-batch FK mode (MED-HIGH, blocks S2) | T12809 | One bracket per migration file, with its own FK mode and journal row; ON UPDATE CASCADE covered | §2.3a rule 2 |
| R6-5 held insert vanishes | T12810 | `E_SYNC_HELD` with a conflict preview; held transactions listed in pull results and `cleo sync status` | §3.5 Rule 5 |
| R6-7 replay ignores newer stream HLCs | T12810 | Per-field LWW in replay; superseded local ops recorded | §3.5 Rule 4 |
| R6-8 side-effect residuals; fold; mixed versions; endorsement | T12810 | No side-effect triggers in rewind or replay; receive-watermark fold horizon; stalled fold stated; returning retired replica rebinds, edit-vs-delete conflicts; folded uid = tombstone at the horizon, removed on re-creation; folds per checkpoint with `foldHorizon`; mixed versions replay against the max schema seen; `cannot-verify` never endorses | §3.5, §1.7, §2.11 §7 |
| LOWs | T12810 | PK affinity normalization in the violation key; T12687 and Scenario 3 wording (reuse existing functions); `cleo doctor migrations` in the command manifest; dedupe registry only for voided and re-emitted TxnRefs | §2.3a rule 2, §2.11 §6 |

### 0.10 Round 7 response map (v8 → v9, cleo-dev FIX-FIRST, scoped to §3.5 mechanics)

R6-6 (S2 may proceed), R6-3, R6-5, R6-7, R6-8 and the LOWs are fixed. T12343 depends on T12813–T12815.

| Item | Task | Fix | Where |
|---|---|---|---|
| R7-1 DDL-swap suspension too slow (HIGH, measured) | T12813 | MAIN `_sync_suspend` flag rows inserted and deleted inside the frame; `WHEN NOT EXISTS` on capture, guard and side-effect triggers; a migration rewrites the owned triggers (feeds `triggerSetHash`); every trigger classified (FTS is derived-maintenance, always active; the handoff mirror is a side effect); COMMIT and open assert the table is empty | §3.5 Rule 4, §2.3 |
| R7-2 replay restores stale claims and leases (HIGH) | T12813 | Undo excludes local-only columns; rewind and replay never write them; a rewound and replayed insert restores a snapshot of the CURRENT local-only values | §3.5 Rules 2 and 4 |
| R7-3 FK in the rebase frame (HIGH, measured) | T12814 | (a) orphan snapshot excludes and holds orphan rows; a failed COMMIT does explicit ROLLBACK plus a bounded `fk_orphans` repair; (b) the NEW-4 predicate applies to replay, so a local parent D with uncovered live children is held; (c) `defer_foreign_keys` set after each BEGIN; (d) `foreign_keys = 1` asserted | §3.5 Rule 4 |
| R7-4 undo unbounded | T12815 | Undo written only while push and pull are on; a cap marks the store non-rewindable (in-scope transactions held) | §3.5 Rule 2 |
| R7-5 apply-frame undo never dropped | T12815 | The stamp fills `txn_local` and `kind`; the sealer drops non-`write` undo | §3.5 Rule 2 |
| R7-6 size, pages, fast path, guard footprints | T12815 | Append-only undo keeps rk and uid only; doctor reports; disk budget; S2 bytes-per-day estimate; pages break on transaction boundaries with part-sets whole; declared large-transaction exemption; bounded `_sync_foreign_touch` with fallback; a Gate test for guard footprints | §3.5 Rules 2 and 3 |
| R7-7 watermark ping-pong; v1 → v2 op mapping; nit | T12815 | Piggybacked watermarks, standalone only after real progress and at most once per checkpoint interval; `upgradeOp` in T12344, unmappable means void plus a conflict; §1.6 comment fixed | §1.7, §2.11 §7, §1.6 |

### 0.11 Round 8 response map (v9 → v10, cleo-dev APPROVE-WITH-CONDITIONS)

R7-1, R7-2, R7-3(b)(c)(d), R7-6 and R7-7 are fixed. The hot path is measured at about +0.5 µs per write, and a 9.24 binary works on the newer store. T12343 depends on T12819–T12821.

| Item | Task | Fix | Where |
|---|---|---|---|
| C2 flag table and live trigger text (HIGH, blocks S2) | T12819 | (a) `cleo_trigger_suspend`, created in the same drizzle migration as the WHEN clauses, schema-owned, never dropped, outside the `_sync_` prefix, with a DROP lint; (b) open and doctor verify each classified trigger's live text and repair from the owned DDL; (c) migration-SQL lint; (d) rebuild-then-open Gate test | §3.5 Rule 4, §2.3a rules 4, 9, 10 |
| C1 non-rewindable mode incoherent (HIGH, before S3/S5) | T12820 | Mode dropped; undo on exactly while push is on (from the genesis cut), independent of pull; toggled only at transaction boundaries; 80% warning, and at 100% a forced rebind plus three-way reconcile; S5's first pull drains own echoes through the fast path | §3.5 Rule 2 |
| C3 "held orphan" ill-defined (MED, before S3) | T12821 | Distinct `fk_excluded` state: in place, counted in Gate D and the ledger; `fk_orphans` repair re-parents to a sentinel, NULLs, or reports, never deletes; doctor lists holds over 7 days | §3.5 Rules 4 and 5, §1.6 |
| C4 suspension test; apply-frame undo volume (LOW) | T12821 | The test asserts COMMIT refusal and crash-emptiness; a frame-validated TEMP stamp deletes non-write undo at insert | §3.5 Rule 2, tests |

### 0.12 Round 9 response map (v10 → v11, cleo-dev APPROVE-WITH-CONDITIONS)

C1–C4 are in the text. S2 may proceed once D4 is in. T12343 depends on T12825–T12828.

| Item | Task | Fix | Where |
|---|---|---|---|
| Flag table missing (answer) | — | Created at open-pass step 0 before migrations; partial restore and bundle import create it; doctor message; 9.24 fails closed | §3.5 Rule 4 |
| D1 stamp deleted undo of pushed kinds (HIGH) | T12825 | Delete only for `apply` and `rebase`; repair, import, exodus, remint, rekey and reconcile repair keep undo until their echo | §3.5 Rule 2 |
| D2 U rewind reverts earlier-page stream writes (HIGH) | T12825 | U rewind and replay write only the columns the local transaction changed; cross-page test | §3.5 Rule 4 |
| D3 sentinel (MED-HIGH) | T12826 | Deterministic synced natural uid; satisfies `parent_type_matrix` and the cycle guard; merged-state lookup first (live elsewhere → restore locally, emit nothing; tombstoned → conflict; unknown → sentinel or NULL plus conflict); report-only pre-sync | §3.5 Rule 4 |
| D4 lint on released files; freeze triggers (MED, blocks S2) | T12827 | Forward-only lint by `folderMillis`; released files never edited (#1719); `frozen-guard` class with no clause and never rewritten | §3.5 Rule 4 |
| D5 forced rebind needs the network (MED) | T12828 | At 100%: warn and keep writing undo; rebind at the next connectivity; the rebind retires the old id; late old-id segments are inherited history | §3.5 Rule 2 |
| D6 drain order; per-stream genesis (LOW-MED) | T12828 | Drain never reorders the stream (fast path per echo, in `seq` order); undo dropped for folded captures and for captures routed only to non-pushing streams | §3.5 Rule 2 |

### 0.13 S2 rulings (v11.2 → v11.3, cleo-dev, 2026-09-30)

The S2 shadow-mode measurements ("T12341 sync set (10 tables)", scratch copies of cleocode, llmtxt and claude-todo; Gate B passed with released 9.23, 9.24 and 9.25) raised three decisions. cleo-dev ruled:

| Ruling | Decision | Where |
|---|---|---|
| (a) Insert-path budget | Optimise first, then set the budget from the result. Implemented: (1) the per-capture TEMP stamp UPDATE is replaced by ONE labelling UPDATE per frame at `finishCaptureFrame`, over the frame's seq range (a persistent trigger cannot read a TEMP table, so the label cannot be folded into the capture INSERT itself; the write lock makes the range the frame's); (2) I and D images omit NULL columns (tasks I 921 → 393 B, AC I 295 → 171 B). Measured after both (interleaved on/off, n = 3000 × 5, host load ~16): task-add + 3 AC p95 1.53–2.67 ms (median 2.02; was 2.8–3.5) against 1.0–1.4 ms off; task update p95 0.07–0.09 ms; session touch p95 0.07–0.12 ms. **Budget: p95 ≤ 3.5 ms for insert-heavy transactions, ≤ 2 ms for updates and session touches.** Rationale: the insert tail is WAL-checkpoint driven (with checkpoints deferred the on/off gap is 0.3 ms at p95), so it scales with bytes captured, not with trigger CPU (≈ 18 µs per captured row). | §2.3, §6 |
| (b) Undo U images | An update's undo row holds the old and new values of **exactly the changed columns** (secret ciphertext included, Rule 2); a D keeps the full row; an I keeps the full after-image. This is the D5 amendment; it matches D2 (rewind writes only the changed columns) and removes the ~79 KB full-row undo pair a session touch cost on cleocode. Test: a multi-column update is restored exactly from its before image. | §2.3 Undo log, §3.5 Rule 2, §6 |
| (c) Unframed captures | The sealer (S3) seals each unframed capture as a **singleton transaction flagged `unframed`** and never claims atomicity for it (this replaces the §2.4 maximal-run synthetic groups). Turning capture on writes `_sync_meta.min_writer_version` (the enabling build's version, never lowered); every build from S2 on checks it at open, before any write, and refuses with `E_STORE_WRITER_TOO_OLD`. Builds released before S2 do not know the marker: their writes stay unframed. The release notes name that mixed-version window. | §2.3, §2.4, §5 |

Related S2 decisions recorded here: the open-time identity fill, refill and graveyard relink are derived rewrites run with the capture triggers dropped and their tables marked suspect; an identity that a captured write cleared (T12806 snapshot-overwrite import, K old → NULL) gets a re-mint K NULL → new in a `remint` frame, so the pair nets to old → new. Suspending the `guard` class is allowed only to rewind or undo (T12344 AC5, `E_GUARD_SUSPEND_FORWARD`). Nits N1 and N2 were already fixed in v11.1.

## 1. HLC and replication metadata (T12342)

### 1.1 Format

The wire format is fixed by the contract: `PPPPPPPPPPPPP-CCCCCC-<replica uuid>`.
- `P`: physical milliseconds since the Unix epoch, zero-padded to 13 digits (valid to the year 2286).
- `C`: the logical counter, 0 to 999,999.
- The replica id is the lowercase UUIDv7 of the store that issued the timestamp.

In memory an HLC is `{ phys: number, ctr: number, replica: string }`. Comparison is `(phys, ctr, replica)` in tuple order, which is exactly the lexical order of the encoded string, so SQL `ORDER BY hlc` and `MAX(hlc)` are correct. The replica tiebreak is arbitrary but deterministic, and every replica evaluates it identically.

The module is `packages/core/src/store/sync/hlc.ts`: `encodeHlc`, `parseHlc`, `compareHlc`, `tick`, `receive`, `genesisHlc`. It is pure apart from the clock row (§1.4). It MUST NOT import the uuid or uid helpers. A lint test asserts that it never parses a uid, which is R7.

### 1.2 Where the physical time comes from

| Event | Physical candidate |
|---|---|
| A captured row change (§2) | `at_ms`, stamped by the capture trigger: `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`. This is pure SQL and valid on every SQLite version shipped by 9.20–9.24. `unixepoch('subsec')` needs 3.42 and is avoided. |
| A chokepoint event with no row change (re-mint op, alias op) | `Date.now()` |
| Genesis of an existing row (first enable, §1.6) | the row's own modification column (`updated_at`, else its birth column), parsed by `parseStoreTimestamp` and clamped to `[0, now]`. It is never the uid timestamp (R7) and never `birth_fp`. |
| A received op | the op's own HLC, through `receive` |

### 1.3 Clock rules

- **tick(w)**:
  - `phys' = max(last.phys, w)`;
  - `ctr' = (phys' == last.phys) ? last.ctr + 1 : 0`;
  - if `ctr'` exceeds 999,999, then `phys' += 1` and `ctr' = 0`.

  HLCs therefore increase strictly per replica, even when the wall clock steps backwards (NTP) or a batch writes 10^6 rows in one millisecond.
- **receive(h)**: `phys' = max(last.phys, h.phys, now)`. The counter follows the standard HLC rule:
  - `max(last.ctr, h.ctr) + 1` when all three are equal;
  - `last.ctr + 1` or `h.ctr + 1` when `phys'` equals only one of them;
  - 0 otherwise.
- **Skew bound, per replica and FIFO (M2).** `MAX_DRIFT` defaults to 5 minutes (Q6). A received transaction whose HLC has `phys > now + MAX_DRIFT` is staged `held-skew`:
  - it is not applied and does not advance the clock;
  - **every later transaction from the same origin replica is held behind it**, in (replicaSeq, txn index) order, even when its own HLC is in bounds, so that replica's causal order is preserved;
  - transactions from other replicas keep applying;
  - the held head is re-evaluated at every pull, and the queue releases in order once the head is within bounds;
  - it is reported by `cleo doctor sync` and as a conflict of kind `clock-skew` naming the replica;
  - it is never dropped.
- **Local clock ahead.** Every `Journal` HTTP response carries a `Date` header. If `now − serverDate > MAX_DRIFT`:
  - push pauses and `cleo doctor` reports `clock_ahead`, so future-stamped HLCs do not spread;
  - local writes are never refused, and captures keep accumulating;
  - sealing clamps the physical candidate to `min(at_ms, serverDate + MAX_DRIFT)` when a server date from the last 24 h is known.

### 1.4 Persistence and concurrency

- `_sync_clock(replica_id PK, phys INTEGER, ctr INTEGER)` is local-only. It is updated in the same transaction as every seal (§2.5) and every apply (§3), under `BEGIN IMMEDIATE`, so two processes serialize on the SQLite write lock. No clock state lives in process memory across transactions.
- On open, the clock is healed to `max(_sync_clock, MAX(hlc) of this replica in _sync_op and _sync_row_meta)`. That covers a restore of a store copied between those writes.

### 1.5 Replica identity (H3)

```sql
CREATE TABLE _sync_replica (          -- local-only
  replica_id  TEXT PRIMARY KEY,       -- UUIDv7
  scope       TEXT NOT NULL,          -- project | global
  nonce       TEXT NOT NULL,          -- 128-bit random, minted with the replica
  file_ino    INTEGER NOT NULL,
  file_birth  INTEGER,                -- st_birthtime in ns; NULL where the filesystem has none
  bound_at    TEXT NOT NULL,
  retired_at  TEXT,
  successor   TEXT                    -- replica id that retired this one
);
```

**Binding.** A store is bound to its replica by `(st_ino, file_birth, nonce)`.
- **Not `st_dev`.** It is unstable: macOS external volumes such as `/Volumes/Migration` get new device numbers on remount, OS updates renumber devices, and btrfs subvolumes, overlayfs, NFS and Docker bind mounts all vary.
- **`file_birth` (N5, T12761).** Node reports `birthtimeNs` as 0 when `statx` has no btime, and libuv falls back to ctime on some platforms. At bind time the sealer stores `NULL` when the reported birthtime is 0 or equals ctime. At check time it compares birthtimes only when **both** the stored and the current value are non-NULL. Otherwise the binding is `(st_ino, nonce)`.
- **Device registry (N6, T12762).**
  - Location: a machine-local path from `packages/paths` (gate 2, paths SSoT), under the CLEO data dir as `sync/replicas.json`. It is never synced and never inside a store.
  - Keyed by device id, then replica id: `{nonce, dbRealpath, hwm: {stream: lastPersistedReplicaSeq}}`.
  - Written after each segment persist (§2.8) with file-then-rename.
  - It is **advisory**. A restore of the home directory rolls its `hwm` back as well, so it can't prove the absence of a rollback. The server is authoritative (rule 3).

**Rebind conditions.** Evaluated by the sync open pass (canonical opens only; see below):
1. **File identity.** `st_ino` differs from the bound row, or both birthtimes are known and differ. This covers a copy, `VACUUM INTO` output, a restore to a new file, a worktree copy, and a cross-filesystem move. A rename within one filesystem keeps the replica.
2. **Copy at a new path.** The registry records this nonce at a different realpath, and that path still exists and holds a store with the same nonce. That is a copy, even if the inode check passed (for example on a filesystem that preserves inodes on copy). If the old path no longer exists, it was a move: keep the replica.
3. **Rollback, where the server is authoritative.** Before any push, the replica pulls to head (it must anyway). If the pull cursor shows a `replicaSeq` for this replica at or above the store's next one:
   - if the server's segment at that seq has the same `segmentHash` as the locally persisted segment, it is an unmarked push: mark it pushed;
   - if the hash differs, or the store has no such segment, the store was rolled back (`upgrade.ts` `.backup()` into the same inode (L5), or a file or home-directory restore): rebind.

   The registry `hwm` is only a fast local pre-check. If it exceeds the store's maximum, rebind at once, without waiting for the pull.
4. **Not a rebind: losing only the registry.** A missing registry file, or a nonce missing from it, just re-registers the store. A new home directory or a wiped CLEO data dir must not cost a reconcile, which v3's condition 2 did.

**A new replica never re-emits inherited rows (H3).** On rebind the sealer:
- mints a new replica id and nonce;
- marks every inherited row `inherited`: `_sync_capture`, sealed or unsegmented `_sync_txn`/`_sync_op`, and unpushed `_sync_segment` rows. Inherited rows are never sealed, built or sent;
- discards the inherited cursor and pauses push.

**Reconcile (N7, T12763).**
- The new replica restores the latest verified checkpoint into a scratch store (`sync: 'off'`), pulls the stream to head there with T12344's engine, and diffs its own sync-set state per (table, uid, column) against the merged state.
- Each differing field is decided by a **three-way rule**:
  1. **The field was changed by an inherited capture or by an inherited sealed-but-unpushed op** (`_sync_op` rows in transactions never carried by a pushed segment): an edit made on the copy that never left it. Emit it with `tick(at_ms)` of that capture, or of the op's source capture time (the op's HLC physical part when the capture is gone), under the new replica's clock.
  2. **The field was not touched by any inherited capture, and the local row meta's field HLC is below the merged field HLC:** adopt the merged value locally, in an `apply` frame. Nothing is emitted.
  3. **Otherwise** (the local value carries a meta HLC at or above the merged one, which is a value the original replica sealed but the stream never saw): emit it with **that meta HLC unchanged**.
- These are `repair` transactions with `via: 'rebind'`.
- **This deliberately breaks the per-replica monotonic-HLC promise (§1.3) for `via: 'rebind'` transactions.** Case 3 re-publishes HLCs issued earlier under the old replica id, and case 1 can sit below HLCs this replica has already issued. Receivers and T12344 must not assume HLC order within a replica's segments for rebind transactions. Ordinary transactions keep the promise.
- The cost is one scratch restore per rebind.
- **Gating.** The reconcile needs T12344's apply and T12338's checkpoint restore, so it (and therefore S4) is gated on both.

**Retirement.**
- In case 3 (rollback of the same file), and after a cross-filesystem move (case 1 with the registry's old path gone), the new replica emits a signed `retire` control transaction naming the retired id, the successor, and the last `replicaSeq` of the retired replica known from the cursor.
- A copy retires nothing, because its original is still live.
- A replica with no segment for 90 days of HLC physical time is listed by `cleo cloud replicas`, and **`cleo doctor` shows a prompt listing the retirement candidates** (Q17). `cleo cloud replicas retire <id>` emits the same transaction after owner confirmation. Only the device pinned to that replica, or a project owner or admin (server role check, T12345), may retire it.
- Retired replicas are excluded from tombstone GC (§1.7), so GC does not stall on them.
- They are excluded from T12341's `remintAuthority` active-member set, so the fallback authority is not distorted.
- **Trust (v11.5, T13366).** A receiver honours a `retire` only once the server confirms it. Any device on the account holds a valid signing key, so a signed `retire` naming its emitter as successor proves nothing by itself, and a confirmed retire moves the fold horizon and quiets the retired replica's late conflicts. The bound is the server's E31 check: it stores a retirement only from the replica's pinned device or, on a project stream, a project owner's device (refusal `not-pinned-or-owner`; on a home stream any device of the account may retire). Confirmation sources: the emitter's own E31 answer (`ReplicaRetirement`), and for the home stream the `retiredAt` and `successor` on `GET /v1/account/home/replicas`. The successor must match. Until confirmed (`_sync_retired.confirmed_at` NULL), late segments apply normally with their conflicts recorded, and the fold horizon and remint authority still count the replica. A project stream has no server read of retirements yet, so its receivers keep every retire unconfirmed. A receiver that applies a late transaction before the confirmation arrives records its conflicts; only conflict records differ between receivers, never the applied values.

**Opens that skip the sync open pass.**
- `openDualScopeDbAtPath(path, { sync })` takes a sync mode, `'off' | 'live' | 'test'`. The default is `'off'` for every path other than the canonical project and global store.
- These always use `'off'`: backup and snapshot (`VACUUM INTO`, `.backup`), Gate B scratch copies and fingerprinting, exodus dedicated handles, bundle staging, credential-transfer snapshot handles, and the reconcile scratch.
- In `'off'` mode nothing is installed, verified or dropped, no stamp is created, no rebind happens and nothing seals. Existing triggers in a copy keep capturing into the copy's own `_sync_capture`. That is harmless: if the copy is ever opened live, it rebinds and those rows are inherited.
- Gate B capture runs use `'test'`: a scratch-bound replica that never pushes to a real stream.

Other rules:
- This is not T12675's store-instance id, which `VACUUM INTO` copies by design. The replica id identifies a physical store file.
- The project store and the global store are separate replicas. A project store emits to `project:<id>` and to `home:<user>`, and `replicaSeq` is counted per (stream, replica).

### 1.6 Where HLC, origin and version live (R1)

Recommended (Q3a): a side table, not columns on each synced table.

```sql
CREATE TABLE _sync_row_meta (         -- local-only; carried in checkpoint bundles
  tbl        TEXT NOT NULL,
  uid        TEXT NOT NULL,
  hlc        TEXT NOT NULL,           -- max field HLC = HLC of the last change
  fhlc       TEXT,                    -- JSON {col: hlc} only for columns whose HLC < hlc; NULL when all equal
  origin     TEXT NOT NULL,           -- replica id of the last writer (= replica part of hlc)
  actor      TEXT,                    -- JSON {agent, session_uid, command} of the last local or remote writer
  version    INTEGER NOT NULL,        -- count of ops applied to this row on this replica (diagnostic, not a merge input)
  deleted    INTEGER NOT NULL DEFAULT 0,   -- 1 = tombstone
  key_json   TEXT,                    -- natural rows: key with refs as uids (tombstones need it; T12341 §5.3)
  sent       INTEGER NOT NULL DEFAULT 0,   -- 1 once any persisted segment carried an op on this uid (§2.4 N8, §2.8)
  fk_excluded INTEGER NOT NULL DEFAULT 0,  -- 1 for rows tied to a pre-existing FK orphan: never rewound, still counted (§3.5 Rule 4, C3)
  held       INTEGER NOT NULL DEFAULT 0,   -- 1 while a rebase holds this row's local write unreplayed (§3.5 Rule 5)
  chash      TEXT,                    -- sha256 of the last sealed/applied canonical image WITHOUT secret columns (§2.7, M6)
  shash      TEXT,                    -- HMAC-SHA256 (device-local key) over secret columns; stripped from checkpoint bundles
  PRIMARY KEY (tbl, uid)
) WITHOUT ROWID;
CREATE INDEX _sync_row_meta_tomb ON _sync_row_meta(deleted, hlc) WHERE deleted = 1;
```

Why a side table:
- Adding columns to about 140 tables would change every Gate B fingerprint (it would need another `--omit` mode).
- Older builds would see columns they cannot maintain.
- Every `SELECT *` clone and `INSERT … SELECT` in tests and imports would copy clocks that belong to another row. T12341 §12 already has to clear cloned uids.
- Per-field HLCs, which T12344 needs for per-field LWW, fit a side table naturally.

Cost: about 124.6k rows for cleocode (§6). T12342 AC1 is satisfied as "every sync-set row has a row-meta entry". A gate test asserts one live meta row per live sync-set row once sync is enabled.

The existing T12503 CAS token (`updatedAt`, `task-version.ts`) is untouched. It stays the local optimistic-concurrency version. `_sync_row_meta.version` is diagnostic only, and the merge decides by HLC. Q13 covers how CAS interacts with remote apply.

### 1.7 Tombstones (R2)

- A delete of a sync-set row, including a hard-deleted edge (`tasks_task_dependencies`, `tasks_task_relations`, `tasks_task_labels`, `brain_page_edges`, …), sets `deleted = 1`, `hlc = delete HLC`, and keeps `key_json` and the before-image hash. The row itself stays hard-deleted in its table, so no reader changes.
- Resurrection guard (a rule for T12344, recorded here): an incoming insert or update of a uid whose tombstone has a greater HLC does not resurrect it. An update concurrent with a delete is a conflict under T12344's typed rules.
- GC: retired replicas (§1.5) are ignored. A tombstone is compacted once every live replica in the latest verified checkpoint's `ReplicaHeads` has a `lastReplicaSeq` covering a segment whose `hlcMax` is at least the tombstone HLC, and 30 days have passed. The grace period covers replicas offline since before the checkpoint. A replica that comes back after its tombstones were GC'd must restore from a checkpoint (T12338).
- **GC never forgets that a uid was deleted (NEW-2, T12782; sizes corrected by R5-5, T12797).**
  - Compaction keeps a minimal tombstone (`tbl`, `uid`, `hlc`, `deleted = 1`). With the WITHOUT ROWID key and the index, that is about **190 B per row**, not the 60 B v6 stated.
  - A receiver can therefore always tell a deleted uid from a never-seen one, and a late op can never resurrect a row.
  - A full tombstone is never compacted while any `pending` or `void` inbox transaction references its uid.
- **Bounding tombstones (R5-5).** Minimal tombstones grow without bound, and every checkpoint bundle carries them. So:
  1. **S2 measures** the per-table delete rate on the three release stores in shadow mode, before S3.
  2. **Append-only and range-pruned tables** (the STDP events, logs: `ROW_IDENTITY.appendOnly` or a Q15 prune policy) **get no per-row tombstones**. Their deletions are range prunes, and "deleted vs never seen" is decided by the prune cutoff.
  3. **Horizon fold (R5-5, corrected by R6-8, T12810).**
     - Tombstones below the fold horizon move into a compact per-table set, `_sync_tomb_fold(tbl, horizon_hlc, uids BLOB)`: sorted, delta-encoded and deflated 16-byte uids, about 3–6 B each. Membership is an exact lookup.
     - **The horizon is a RECEIVE watermark.** Each checkpoint records, per live replica, the highest stream seq that replica has **applied** (`receiveWatermarks: {replica: {appliedSeq, hlc}}`). The horizon is the minimum `hlc` over live replicas, minus 90 days. v7 used `lastReplicaSeq`, which is push-side: a replica that pushes but never pulls would let others fold tombstones it has not yet seen.
     - **No idle ping-pong (R7-7, T12815).** v8 had every replica send a watermark control transaction after each pull. Two idle replicas would then trade them forever: each pull sees the other's watermark transaction and emits its own. So:
       - the watermark is **piggybacked** on the replica's next ordinary segment as a metadata field (`recvWatermark`, covered by the segment signature), never sent on its own for that reason;
       - a standalone watermark transaction is emitted only when the watermark advanced over at least one **non-control** transaction from another replica **and** no piggyback happened within one checkpoint interval;
       - applying a watermark or other control transaction never advances the watermark's trigger condition.
       - Test: two idle replicas pulling in a loop exchange no segments after the first round.
     - **Folds are deterministic.** They happen only at checkpoint boundaries, with `foldHorizon` recorded in the manifest, so every replica derives the same fold from the same checkpoint.
     - **A folded uid is a tombstone at `horizon_hlc`.** A later re-creation of the same uid with a greater HLC removes it from the fold: for example, a natural-key label re-added. The removal is recorded in `_sync_tomb_fold_removed(tbl, uid)` and merged at the next fold.
     - **A replica offline more than 90 days but not retired stalls folding** (its watermark holds the horizon back). That is safe, and it only costs space. `cleo doctor` names the replica and suggests retirement (Q17).
     - **A retired replica that returns** finds its id retired in the stream. It must rebind and reconcile (§1.5). Its edits to rows that were folded while it was away arrive as ordinary ops against tombstoned uids, so they become **edit-vs-delete conflicts**, never silent resurrections.
  4. Bundles carry the folded sets, not individual rows.

### 1.8 Uniform timestamp format (R3, M4)

Canonical form: ISO-8601 UTC with milliseconds and `Z` (`YYYY-MM-DDTHH:MM:SS.sssZ`).

**Strict canonicalizer.** `canonicalStoreTimestamp`, a new pure function, accepts exactly:
- ISO-8601 with `Z` or an explicit `±hh:mm` offset, at any fractional precision;
- SQLite's `YYYY-MM-DD HH:MM:SS[.fff]` space form, which `datetime('now')` defines as UTC.

It **refuses** the following. The value is left unchanged and flagged `timestamp_ambiguous` in `cleo doctor`, and its op carries the raw text:
- zoneless `T` forms (`2026-09-14T19:56:01`);
- date-only values (1 row in cleocode);
- anything else.

It does not use `parseStoreTimestamp` (`split-brain-import.ts:217-224`), which reads zoneless `T` values as local time. Canonicalizing with it would give different results in different time zones.

**One-time migration (before genesis).**
- An open-pass step under the marker `timestamp_canon_v1` in `tasks_row_identity_meta`.
- It rewrites accepted legacy values in `SYNC_TIMESTAMP_COLUMNS` to canonical form, deterministically: two copies agree.
- It runs before the capture triggers are installed.
- It **excludes `tasks_tasks.updated_at`**, the #1698 CAS token, so no caller's `--if-match` version is invalidated.
- It is refused once `row_identity_synced` exists.

**After genesis: on the wire only.**
- The sealer canonicalizes timestamp values in op after-values and before-images.
- It **never rewrites local rows**. The v2 seal-time rewrite is removed, because rewriting `updated_at` mid-session would change a CAS token under a running caller.
- Local legacy text from older builds and column defaults stays until this build next writes the row. Merge compares timestamps by canonical value. Receivers write canonical values.

**Gate B.** `fingerprint-store.mjs --canon-timestamps` applies the same function on both sides. Pre-migration vs post-migration must PASS, and two independent migrations must agree.

### 1.9 Alias tables

`tasks_display_id_aliases.displaced_hlc` and `tasks_uid_aliases.displaced_hlc` (T12341 §9.3) are NULL until HLC exists. The sealer fills them with the HLC of the op that records the displacement, and the alias rows themselves travel as ordinary portable-project ops.

## 2. Capture and the outbox (T12343)

### 2.1 The sync set

`syncSet(scope)` is every table that meets all of these:
- its class is `portable-project`, `portable-personal` or `portable-secret`;
- its status is not `frozen-legacy`;
- it is declared in `ROW_IDENTITY` (not pending);
- it is not a virtual table.

Captured columns are every physical column except:
- columns overridden `local-only` (the claim leases, path and stat columns);
- identity columns (`uid`, `birth_fp`, `ac_uid`, `ac_text_hash`). These are recorded in the image but do not fire an update capture: filling a NULL uid is identity, not a data change (T12341 §6.1).

Secret columns are captured as a change marker only (§2.7). `strip` columns are captured whole and stripped at seal. The set and the column lists are versioned as `SYNC_SET_VERSION`, which feeds the segment `schemaVersion` (§2.9).

`brain_embeddings` is a vec0 virtual table and SQLite cannot put a trigger on it. Its only writer (`memory/retrieval/observe.ts`, 2 raw sites) moves into the brain accessor, which writes the capture row explicitly in the same transaction. This is the one accessor-level capture, and bypass detection for it relies on the count ledger (§4.3).

### 2.2 Choosing the capture mechanism

Measured facts that drive the choice (`origin/main`):
- Gate 28's baseline holds **226 raw SQL write sites in 72 files**. 139 of them, in 52 files, write sync-class tables.
- Gate 28 does not see Drizzle builder writes. A heuristic scan (`.insert(X)`, `.update(X).set`, `.delete(X).where` outside the sanctioned accessor files) finds about **337 Drizzle write sites in 105 files** outside the accessors: for example `release/reconcile.ts` 12, `lifecycle/index.ts` 11, `nexus/registry.ts` 18 and `store/session-store.ts` 13. That count includes some false positives and needs confirming.
- Foreign connections write synced tables: Studio's own `DatabaseSync` in the three `/api/memory/*-store` routes, `credential-transfer.ts` raw handles, and exodus dedicated handles. The Rust supervisor writes only `_writer_leases`.
- Releases 9.20–9.24 run in the field and write shared stores without any capture.
- `node:sqlite` exposes `createSession`, `changeset`/`patchset` and `applyChangeset`, but no changeset iterator. ADR-095 records that a newer-schema changeset is silently skipped.

| Criterion | A. Accessor-level capture | B. Persistent SQLite triggers → outbox | C. Session changeset API |
|---|---|---|---|
| Raw SQL sites (139 sync-class) | missed until every site is refactored | captured | captured only on connections with a session attached |
| Drizzle writes outside accessors (~337) | missed | captured | captured on attached connections |
| Older builds 9.20–9.24 | missed | **captured** (pure-SQL triggers run under any build; the T12341 graveyard trigger set the precedent) | missed |
| Foreign connections (Studio, raw handles, `sqlite3` shell) | missed | captured | missed |
| Same transaction (R4) | yes | yes, the trigger runs inside the writing statement | only if the changeset is extracted and written before every COMMIT on every connection |
| Before-images (R6) | needs an extra SELECT per write | free (`OLD.*`) | changed columns plus the PK |
| Netting (R8) | application code | sealer (§2.4) | built in, per local PK only (not per uid) |
| Actor and command context | rich | from the chokepoint's provenance stamp (§2.3) | per connection |
| Virtual tables (vec0) | yes | **no** (the one gap, closed by A for `brain_embeddings`) | no |
| Failure modes | incomplete by construction; relies on discipline | a table rebuild drops triggers (detected, §4.3); the exodus effect inspector must allow the side effect | rowid tables without a PK are skipped; a JS parser is needed for the binary format; misses older builds |
| Hot-path cost | lowest | about 10–30 µs per captured row (§6) | low per write, plus extraction per commit |

**Decision (Q1a): B, capture by persistent pure-SQL triggers.** A per-connection provenance stamp comes from the chokepoint, and sealing is lazy.
- A only for `brain_embeddings`.
- C as the test-suite cross-check for R5 (§4.5), which is what the T12343 description already proposes.
- This amends ADR-095's line "kept as the capture source inside core" to "kept as the capture cross-check inside core". Q1 asks cleo-dev to confirm.

Why B satisfies condition (1), "no parallel write path":
- Domain code gets no new write API.
- The triggers are installed, verified and removed only by the open pass of `openDualScopeDb`, the chokepoint.
- The frame (actor, command, kind) is opened only by `accessor.transaction()` and the other sanctioned accessors.
- The outbox tables are written only by the triggers and by the sealer, which lives in `store/sync/` and joins gate 28's `SANCTIONED` set.

What B cannot do in pure SQL, and where each piece is done instead:
- Compute an HLC or a uid, or call a function. The trigger records `at_ms`, and the sealer does the rest (§2.5). A function-calling persistent trigger would break older builds, as T12341 §6.1 found.
- Identify a transaction. The chokepoint's frame identifies its own transactions, and foreign runs are grouped conservatively (§2.4).

### 2.3 Capture schema and triggers

```sql
CREATE TABLE _sync_capture (          -- local-only
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl    TEXT NOT NULL,
  op     TEXT NOT NULL CHECK (op IN ('I','U','D','K')),   -- K = uid re-key (H5)
  rk     TEXT NOT NULL,               -- JSON array of the local key values (enc()-encoded)
  uid    TEXT,                        -- read from the live row (I) / OLD.uid (U, D) / old uid (K)
  img    TEXT NOT NULL,               -- I: {col: enc(NEW)} non-NULL cols; U: {col: [enc(OLD), enc(NEW)]} changed cols;
                                      -- D: {col: enc(OLD)} non-NULL cols; K: {uid:[old,new], birth_fp:[old,new]};
                                      -- an absent I/D column is NULL (v11.3 (a); the column set is pinned by the trigger set)
                                      -- ref columns hold [enc(local key), target uid] (H5)
  at_ms  INTEGER NOT NULL,            -- julianday-based wall ms (§1.2)
  conn   TEXT,                        -- labelled at frame finish (v11.3 (a)); NULL = unframed
  frame  TEXT,                        -- labelled at frame finish over the frame's seq range; NULL = unframed
  kind   TEXT,                        -- labelled at frame finish: write | apply | repair | exodus | import | remint | ...
  state  TEXT NOT NULL DEFAULT 'live' -- live | inherited (H3) | folded (genesis cut, §2.11 §10)
);
CREATE TABLE _sync_frame (            -- local-only; one row per chokepoint transaction, inside it
  frame TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT, first_seq INTEGER
);
```

**Value encoding.** `enc(v)` = `CASE typeof(v) WHEN 'real' THEN 'r' || printf('%!.17g', v) ELSE quote(v) END`.
- `quote()` is lossless for INTEGER beyond 2^53, TEXT, BLOB (`X'..'`) and NULL.
- **REAL (L4, verified by cleo-dev on 3.53.4):** `printf('%!.17g')` renders `-0.0` as `0.0` and ±Inf as `Inf` / `-Inf`.
  - The sign of negative zero is therefore **not preserved**. This is documented, and it is harmless because SQLite compares `-0.0 = 0.0`.
  - The `$r` parser (§2.6) accepts `Inf`, `-Inf` and `+Inf` besides decimal text, and maps them to ±Infinity. SQLite stores NaN as NULL.
  - Tests: round trips of 17-digit values, subnormals and ±Inf; `-0.0` becomes `0.0`.
- `json_object` over a raw BLOB would raise an error, which is why values are encoded before they reach any JSON function.

**Suspension flag (R7-1).** Every capture trigger carries `WHEN NOT EXISTS (SELECT 1 FROM main.cleo_trigger_suspend WHERE scope IN ('capture','all'))`, combined with its own conditions. Guard and side-effect triggers carry the same clause for their scope (§3.5 Rule 4).

**Undo log.** Every capture trigger (I, U, D, K) also inserts the `_sync_undo` entry for the same `seq` in the same statement: `enc()` of the sync-captured columns, including secret ciphertext and strip columns, but **excluding local-only columns** (§3.5 Rules 2 and 4). I and D entries hold the full row; a U entry holds **only the changed columns**, old and new (v11.3 (b), the D5 amendment). It is written only while `undo_enabled` is set (push on, from the genesis cut, C1), and the row is dropped when its transaction is sequenced.

**Per sync-set table, generated deterministically** from the Drizzle schema, the registry and `ROW_IDENTITY`. All are `AFTER` triggers in pure SQL.
- **`_sync_cap_<t>_i`** reads **all identity columns from the live row**, never from `NEW` (N4, T12760, verified). In a persistent AFTER INSERT trigger, `NEW.uid` and `NEW.birth_fp` are NULL when a fill set them on the live row. So `uid = (SELECT uid FROM <t> WHERE <pk> = NEW.<pk>)` and `birth_fp = (SELECT birth_fp FROM <t> WHERE <pk> = NEW.<pk>)`, and the image's identity entries use the same subqueries.
- **`_sync_cap_<t>_u`** is `AFTER UPDATE OF <captured cols>` with `WHEN OLD.c IS NOT NEW.c OR …`. Local-only columns (claim leases), identity columns and no-op updates do not fire it. It stores only changed columns, via `json_group_object` over a `UNION ALL` of per-column terms.
- **`_sync_cap_<t>_d`** records the full before-image.
- **`_sync_cap_<t>_k`** (re-key, H5) is `AFTER UPDATE OF uid, birth_fp` with `WHEN OLD.uid IS NOT NULL AND (OLD.uid IS NOT NEW.uid OR (OLD.birth_fp IS NOT NULL AND OLD.birth_fp IS NOT NEW.birth_fp))`. It captures `op='K'` with the old and new uid and `birth_fp`. `rekeyRowUid` and its cascades (T12341 §6.4), by any writer, are no longer invisible.
  - **A `birth_fp` going NULL → value is a fill, not a re-key (v11.4, T13311).** T12341's per-connection TEMP fill sets `uid` and then `birth_fp` in two UPDATEs, so by the second one `OLD.uid` is already set. The v11.3 condition (`OLD.birth_fp IS NOT NEW.birth_fp`) therefore captured a stray K on every insert of a minted row once row uids were on by default (T13305). Decision: no stray K at all, rather than a K the sealer must recognise and drop. `_f` alone patches the filled `birth_fp` into the I (both trigger orders), which keeps "identity-fill updates capture nothing" (S2 test list) true. A `birth_fp` that changes from one value to another, or is cleared, is still a K.
- **`_sync_cap_<t>_f`** (fill patch, H5, N4, N11) is `AFTER UPDATE OF uid, birth_fp` with `WHEN (OLD.uid IS NULL AND NEW.uid IS NOT NULL) OR (OLD.birth_fp IS NULL AND NEW.birth_fp IS NOT NULL)`. It patches **both** `uid` and the image's `birth_fp`, and it is scoped to **the current insert only**: `UPDATE _sync_capture SET uid = coalesce(uid, NEW.uid), img = json_set(img, '$.birth_fp', NEW.birth_fp) WHERE seq = (SELECT max(seq) FROM _sync_capture WHERE tbl = '<t>' AND rk = <key json> AND op = 'I' AND state = 'live') AND (uid IS NULL OR json_extract(img, '$.birth_fp') IS NULL)`. An older capture of the same key (a deleted, different row) is never patched with the new row's identity.
  - A persistent trigger cannot read the TEMP ctx, so "current frame" is approximated by "the latest live I capture of that key", which is the insert that caused the fill.
  - The open-pass fill of older-build rows runs with the capture triggers dropped (a derived rewrite; its tables are marked suspect, v11.3). A row whose identity a captured write cleared gets a re-mint K. Anything still NULL is resolved by the sealer's step 0.

**Why the fill needs two triggers.** T12341's per-connection TEMP fill trigger and the capture trigger fire on the same INSERT, and SQLite does not guarantee their relative order:
- if the fill runs first, the `_i` subquery reads the filled uid;
- if the capture runs first, it records NULL, and the fill's UPDATE fires `_f`, which patches it.

Both orders give a non-NULL uid. A store test creates the triggers in both orders. Older builds insert NULL uids that nothing patches, so the sealer's step 0 fills them and resolves the captures by `rk` (§2.5).

**References are translated at capture time (H5).** For every reference column declared in `ROW_IDENTITY` (FK columns, `keyRefs`, owners), the image stores `json_array(enc(NEW.col), (SELECT uid FROM <target> WHERE <key> = NEW.col))`, for example `(SELECT uid FROM tasks_tasks WHERE id = NEW.parent_id)`. The uid is taken at write time, before the target can be deleted or re-keyed.
- If the target's uid is NULL at that moment (an older build inserted both rows), the sealer resolves it at seal time from the local key, using the batch's own captures (D images carry `OLD.uid` and `rk`) and then the live table.
- JSON-array reference columns are translated at seal time, because pure SQL can't map an array's elements without a function.

**JSON argument limit (L3).** SQLite 3.43's default `SQLITE_MAX_FUNCTION_ARG` is 127, which is 63 key/value pairs. Full images (I, D) are built as `json_patch(json_object(<≤60 pairs>), json_object(<next ≤60>), …)`. The per-column `UNION ALL` form used for U has no argument limit.

**Provenance labels (per frame; v11.3 (a) replaces the TEMP stamp trigger).** A persistent trigger cannot read a TEMP table, so the capture triggers write rows unlabelled. `accessor.transaction()` opens a frame right after `BEGIN IMMEDIATE` (insert `_sync_frame(frame, kind, actor, first_seq)`, with `first_seq` = the next capture seq), and before COMMIT `finishCaptureFrame` labels the frame's rows in one statement each:

```sql
UPDATE _sync_capture SET conn = :conn, frame = :frame, kind = :kind WHERE seq >= :first_seq AND frame IS NULL;
UPDATE _sync_undo SET txn_local = :frame, kind = :kind WHERE seq >= :first_seq AND txn_local IS NULL;
-- apply / rebase frames instead: DELETE FROM _sync_undo WHERE seq >= :first_seq AND txn_local IS NULL (D1)
```

- The write lock serializes writers, so every capture from `first_seq` on in the frame's transaction is the frame's.
- **Labels never delete a capture (H1).** A transaction that commits without finishing its frame leaves its captures unframed, never mislabelled; a rolled-back frame leaves nothing, so the v11 stale-ctx case cannot arise.
- **Frame row cost and GC (N10, T12766).**
  - Every `accessor.transaction()` inserts one `_sync_frame` row, including read-only transactions (§6).
  - Before COMMIT, the accessor deletes its own frame row if no capture carries that frame (`_sync_capture(frame)` has a partial index `WHERE frame IS NOT NULL`), so read-only transactions leave no rows.
  - The sealer deletes frame rows that no live capture references and whose `first_seq` is at or below the last sealed seq, and `cleo doctor` reports a leftover count.
- **`min_writer_version` (v11.3 (c)).** Turning capture on writes `_sync_meta.min_writer_version`; every build from S2 on refuses to write an older-writer store at open (`E_STORE_WRITER_TOO_OLD`).

**`recursive_triggers` (M1, N9, T12765, verified).**
- Chokepoint connections will set `PRAGMA recursive_triggers = ON`, so that a REPLACE that displaces a row through a secondary UNIQUE index fires the capture DELETE trigger.
- **cleo-dev verified the hazard.** With recursion on, DELETE triggers also fire for a **same-PK** `INSERT OR REPLACE`. A `REPLACE` into `tasks_sessions` for a live session would fire `tasks_sessions_release_claims_on_delete` and clear that session's live claims (#1701). The same applies to the AC graveyard trigger (T12341 §6.5: a false graveyard entry, then a wrong relink) and to every FTS `_ad` trigger (index churn).
- **Prerequisite, before recursion is turned on:** an audit of every AFTER DELETE trigger against every REPLACE writer.
  - AFTER DELETE triggers: the claim-release trigger on `tasks_sessions`, the AC graveyard trigger, the FTS `_ad` triggers, `t12535_track_*_delete`, and the capture `_d` triggers.
  - REPLACE writers: `legacy-tasks-lineage.ts:193` (carry-forward), the `_agent_registry_meta` and `_conduit_meta` stamps, `brain_embeddings` (vec0; virtual, no triggers, but listed for completeness), the frozen-AC writes in `tasks/backfill-child-projections.ts`, and every other `INSERT OR REPLACE` / `REPLACE INTO` from the gate 28 scan (`release/reconcile.ts`, `migration-sqlite.ts`, `db-helpers.ts`, `memory/graph-auto-populate.ts` and others).
  - **FK-CASCADE parents (NEW-7(d), live bug T12787, critical, independent of sync):** a same-PK `INSERT OR REPLACE` into a table that is the parent of an `ON DELETE CASCADE` or `SET NULL` foreign key deletes the old row, and the FK action deletes (or nulls) its children **even with `recursive_triggers` off**. FK actions are not triggers. The audit therefore also covers every REPLACE into an FK parent, and those sites move to UPSERT as well. cleo-dev is fixing the live instances under T12787. The lint rule covers FK parents too.
  - Every REPLACE site that targets a table with an AFTER DELETE trigger is rewritten to an UPSERT (`INSERT … ON CONFLICT(<pk>) DO UPDATE SET …`), which fires UPDATE triggers and no DELETE trigger. REPLACE sites on tables without DELETE triggers are listed and left as they are.
  - A new lint rule forbids `INSERT OR REPLACE` / `REPLACE INTO` on any table that has an AFTER DELETE trigger.
  - A test runs every audited writer with recursion on and asserts that live claims, the graveyard and the FTS row counts are unchanged.
- **Only after the audit** do chokepoint connections set recursion on. Foreign connections keep it off, and their secondary-UNIQUE REPLACE is caught by the ledger (§4.3).
- `legacy-tasks-lineage.ts:180-193` drops every trigger on its table, so its carry-forward is uncaptured by construction. It marks the table `suspect:` and the repair diff runs before the next seal. It is also rewritten to UPSERT under the audit above, because it recreates its triggers mid-flight.

**Flags and the kill switch (M3).**
- Capture is enabled by the persisted store-level flag `_sync_meta.capture_enabled`, set only by `cleo sync capture on|off`.
- The open pass installs or drops triggers **only** to match that persisted flag.
- `CLEO_SYNC_CAPTURE=0` never touches triggers. In that process it stops sealing and pushing. Triggers keep capturing, and later runs seal what accumulated. Per-process trigger dropping is gone, so two processes cannot make the triggers flap.

**Mixed-version specifics.**
- A REPLACE by a foreign connection shows up as an I on a key or uid the sealer already knows. It is treated as a U against the last image.
- 9.2x exodus recovery (`inspectEffects`) refuses untracked trigger side effects. It aborts, safely, on a store that has capture triggers. This build's `inspectEffects` allows inserts into `_sync_capture` and `_sync_frame` with kind `exodus`, the same way T12341 allowed the graveyard trigger.

### 2.3a Structural safety (H4)

v2 claimed that a capture trigger never fails a write. That is **false for structural damage** (cleo-dev verified this on node:sqlite 3.53.4):
- if `_sync_capture` is missing, every write to a captured table fails, and so does every `ALTER TABLE … RENAME` on **any** table, because SQLite re-validates all triggers;
- `ALTER TABLE … DROP COLUMN` fails for a column a trigger references.

What remains true is that no *value* can make a trigger fail (the type fuzz test). The rules:

1. **Single-transaction brackets are REQUIRED** (cleo-dev round 3, verified).
   - Suspension is safe only when the trigger drop, the DDL or data rewrite, and the reinstall all commit **in one transaction**. A second WAL connection that tries to write during the bracket waits (`database is locked` on its `BEGIN IMMEDIATE`), and its later write is captured by the reinstalled triggers.
   - `withSyncTriggersSuspended(db, fn)` asserts that it opens and commits the only transaction, and throws if `fn` commits.
   - **The bracket owns BUSY handling (NEW-5):** it retries the whole bracket with backoff when `BEGIN IMMEDIATE` returns BUSY, and it never retries mid-bracket.
   - **Staged rewriters (exodus migrate and reconcile) — resolving the v5 contradiction:** each **stage** is its own rule-1 bracket (single transaction: drop, stage work, FK check, reinstall, commit). The **whole run** holds the writer lease and marks its touch set `suspect:` (rule 3). No stage ever commits with the triggers dropped.
2. **Migration runner and foreign keys (A, T12774; NEW-1, NEW-5, NEW-6, T12781, T12785, T12786).**
   - **Why:** drizzle rebuilds a table with `PRAGMA foreign_keys=OFF; …; DROP TABLE old; ALTER TABLE new RENAME …`. Inside a transaction `PRAGMA foreign_keys` is a no-op, so the rebuild's `DROP TABLE` would cascade-delete child rows while capture is suspended.
   - **No `migrateSync` inside the bracket (NEW-5), and the runner is journal-identical to drizzle (R5-3, T12796).** Drizzle's `migrateSync` issues its own BEGIN/COMMIT (drizzle-orm rc.4 `sqlite-core/async/session.js:204-212`, reached through `migrateSanitized`, `migration-manager.ts:1516`), so it can't run inside the bracket. The runner's own statement loop must leave **exactly** the journal drizzle would, or #1719's `E_MIGRATION_HASH_DRIFT` check bricks every store migrated after the cutover at its next open. Requirements:
     1. **Select pending migrations by NAME**, exactly as `migrateSanitized` does today, not by count or by `created_at`.
     2. **Hash the RAW migration file** as `readMigrationFiles` returns it, never the sanitized statement list.
     3. Write each journal row with the same columns and values: `hash`, `created_at = folderMillis`, `name`, and `applied_at`.
     4. Run **`upgradeSyncIfNeeded`** (v0 journals, for example claude-todo's legacy store) and **`reconcileJournal`** **inside the bracket**, before selecting pending migrations.
     5. **Reuse, don't re-describe, the existing journal protections:** the loop calls the same functions `migration-manager.ts` uses today for the T12687 handling (a store a pre-release build touched) and for journal Scenario 3 (journal-probe stamping, Cases A and B), plus the duplicate-column recovery (an ADD COLUMN that already exists is treated as applied). Their behaviour is unchanged, and the parity tests cover it.
     6. Handle **every migration folder that shares a journal**. `migration-sqlite.ts` runs two folders against one `__drizzle_migrations` table. The loop processes them in drizzle's order within one bracket.
     7. **Pin the drizzle version** (rc.4) in the runner. A test fails when the installed drizzle differs, so an upgrade must re-run the parity suite.
   - **Parity tests (T12796).** On each of these stores, the journal written by the loop equals the journal `migrateSync` writes on an identical copy, row for row, with `applied_at` excluded from the comparison:
     - a fresh store;
     - a v0 journal (claude-todo shape);
     - a stamped store (journal ahead of files: Scenario 3);
     - a drifted store (a hash that differs from its file);
     - a two-folder store.

     The next open on each store passes #1719's drift check.
   - **Journal safety check (live cleocode).** The live count is read through a **named CLI command, never a literal**. T12796 adds a read-only `cleo doctor migrations` report per scope and folder: applied count, head name and hash, and any drift. `cleo doctor migrations` is registered in the generated command manifest (`packages/cleo/src/cli/generated/command-manifest.ts`) and the operations registry like every other doctor subcommand, and it is read-only.
     - On 2026-09-29 (cleo 9.24, after the T12736 repair) it would report **116** for cleocode. That figure is an observation, not a constant; the team lead confirmed it.
     - Every S2+ acceptance run on a cleocode scratch copy reads the count from the command on the live store, then asserts that the copy starts at that count. It asserts that it ends at that count plus exactly the migrations the run added, with no deletions and no duplicate hashes.
     - Nothing opens `.cleo/*.db` directly.
     - A mismatch stops the run.
   - **The bracket:**
     1. **One bracket per migration FILE (R6-6, T12809).** A store several releases behind would otherwise get one batch holding M1's rebuild and M2's parent DELETE, with the DML running under FK OFF, orphans appearing, and the store unable to migrate.
        - Each migration file gets its own bracket and its own FK mode, and its journal row is written inside that bracket.
        - Read and remember `PRAGMA foreign_keys` (`prev`). Set `foreign_keys=OFF` **before** `BEGIN` **only if that file rebuilds a table**. Files without a rebuild run with **FK ON**, so their DML cascades as at runtime (R5-4).
        - **ON UPDATE CASCADE is covered too.** FK OFF also disables `ON UPDATE CASCADE`, so a rebuild file that updates a parent's key must update its children explicitly. The R5-4 lint also flags a parent key UPDATE in a rebuild file, and the FK scope includes the children of every table whose key the file updates.
     2. `BEGIN IMMEDIATE`, then determine the **FK scope**:
        - the tables the batch rebuilds (parsed from its statements: `CREATE TABLE __new_*`, `DROP TABLE`, `ALTER TABLE … RENAME`);
        - **plus every table its DML statements touch (R5-4, T12797)**: in a rebuild batch FK is OFF, so a DELETE on a parent does not cascade. cleo-dev measured 2 new orphans with the parent not rebuilt;
        - plus every table with an FK to any of those, from the reverse `PRAGMA foreign_key_list` map.

        Migration authors must delete children explicitly in a rebuild batch. A lint rule flags a DELETE on an FK parent in a batch that also rebuilds a table.
     3. **snapshot the existing violations** for that scope, via `PRAGMA foreign_key_check(<table>)` per scoped table, as a **multiset keyed by rowid-independent identity (R5-2, T12795, measured)**:
        - the key is (table, primary-key values of the child row, fkid, parent table, the child's FK column values). All values are **normalized by column affinity** before encoding (`enc(CAST(v AS <declared affinity>))`), so text `'5'` and integer `5` in an INTEGER-affinity PK key the same row (R6 LOW);
        - tables without a declared PK use the full row's `enc()` values;
        - a rowid is never used, because a rebuild renumbers rowids (a TEXT-PK table with rowid gaps: rowid 3 becomes 1), which made an old orphan look new;
        - duplicates are counted.
     4. drop the capture triggers and run the statements;
     5. re-run `foreign_key_check` on the scope. **Fail only on NEW violations** (multiset difference by the key above, NEW-1 and R5-2): ROLLBACK and throw. Pre-existing orphans exist in the field (`exodus/migrate.ts:1543-1554`; `memory-accessor.ts:694` notes FK may be off on some handles). They never block a migration. `cleo doctor` reports them as `fk_orphans`, with a separate bounded repair;
     6. reinstall the triggers; `COMMIT`;
     7. **`finally` (NEW-6, measured: FK OFF otherwise persists on a pooled handle after a throw):** if `db.isTransaction`, ROLLBACK. Then set `PRAGMA foreign_keys = prev`, read it back, and assert it equals `prev` and that `!db.isTransaction`.
   - **Cost (NEW-7, measured 1.3 s for 3M rows in a 1.5 GB store):** the FK check runs **only** when the batch contains a rebuild, and only on the scope. A batch of ADD COLUMN and CREATE INDEX statements skips it.
   - **Handle invariant:** `openDualScopeDb` and `accessor.transaction()` assert `PRAGMA foreign_keys = 1` on every handle they hand out or use, and throw `E_STORE_FK_OFF` otherwise. The handles `memory-accessor.ts:694` describes are brought in line or excluded from the chokepoint.
   - The same bracket applies to exodus migrate and reconcile per stage (`exodus/migrate.ts:1318`, `exodus/reconcile.ts:290, 380`) and to every other rebuild path.
   - **S2 tests:**
     - **an orphan in a rebuilt child table with rowid gaps (TEXT PK, rowid 3 → 1) is not reported as new (R5-2)**;
     - **a DML-only batch deletes a parent with FK ON and cascades; a rebuild batch whose DML deletes a parent without its children rolls back (R5-4)**;
     - a CASCADE-child rebuild keeps every child;
     - a store with a pre-existing orphan still migrates, and the orphan is reported;
     - a new violation rolls back;
     - a throw mid-bracket leaves `foreign_keys = 1` on the pooled handle;
     - an ADD-COLUMN-only batch runs no FK check.
3. **Data written inside a bracket (B, T12775; NEW-8, T12786).**
   - **Order at a migration (NEW-8):** first run the sealer's pending work (seal live captures, and run the repair diff for every `suspect:` table); then the migration bracket; then the `chash` re-baseline. Re-baselining first would hide earlier uncaptured writes.
   - **Migration backfills are not emitted.** They are deterministic, and every replica runs them itself. After the bracket, `chash` of the affected sync tables is re-baselined, keyed by the new `SYNC_SET_VERSION`.
   - **Lint for determinism (NEW-8):** migration SQL may not use `datetime('now')`, `CURRENT_TIMESTAMP`, `random()`, `randomblob()` or other non-deterministic functions in DML on sync tables. A backfill that is not emitted must produce identical values on every replica. DDL defaults are exempt.
   - **Other rewriters** that write data inside a bracket (bundle import, partial restore, twin collapse, exodus, lineage carry-forward) record `total_changes()` before and after. If it changed, every sync table in their **touch set** is marked `suspect:`, and the sealer runs the repair diff over those tables before sealing anything else, emitting `repair` ops.
   - **Touch sets are generated, not hand-written (NEW-8):** the rewriter's directly written tables, plus the FK-action closure (children with CASCADE or SET NULL), plus every table written by triggers on any table in the set, computed transitively from `sqlite_master` and `PRAGMA foreign_key_list`. For bundle import and partial restore, the touch set is the whole sync set.
   - Alternatively, a rewriter may convert a session changeset into repair captures.
4. **Ordering.** The `_sync_*` tables are created before any trigger, and every trigger is dropped before any `_sync_*` table. One helper, `dropSyncMachinery(db)` in `store/sync/`, is the only code allowed to drop `_sync_*` tables. A lint rule forbids `DROP TABLE _sync_` anywhere else. **`cleo_trigger_suspend` is not part of the sync machinery:** it is schema-owned, created by a drizzle migration, and never dropped by `dropSyncMachinery` or any rollback (§3.5 Rule 4, C2).
5. **Referenced tables, not only captured ones (N3, T12759, verified).** A capture trigger on table C that translates a reference with a subquery on table P breaks any rebuild of **P**: a drizzle rebuild (create `new_p`, copy, drop `p`, rename) fails with `no such table: main.p`. `tasks_tasks` alone is referenced by about 10 capture triggers.
   - The generator emits `SYNC_TRIGGER_REFS`: for each trigger, every table its text references.
   - Every DDL path drops **all** `_sync_cap_%` triggers before any DDL on a captured **or referenced** table, and reinstalls them after, in the same transaction. That covers the migration runner, twin collapse, exodus, lineage carry-forward, bundle import and partial restore.
   - The helper is `withSyncTriggersSuspended(db, fn)`.
   - Tests include a drizzle-style rebuild of a referenced table, `tasks_tasks`.
6. **Fallback design if S2's Gate B fails (H, T12780).** Capture-time reference subqueries are the only reason a capture trigger references a table other than its own, and that is the whole N3 class of breakage, including a downgrade risk: an older build rebuilding a referenced table with a newer build's triggers present bricks its writes.
   - The alternative: triggers capture only local keys, and the sealer translates references at seal time by **replaying the capture log**. It walks captures in `seq` order and keeps a key → uid map built from I, D and K images, falling back to the live table and to row meta.
   - That removes every cross-table trigger reference. The cost is resolving references for rows deleted before sealing, which the D images already provide.
   - It is held as the fallback: if S2's released-binary Gate B run fails, S2 switches to it before `sync.capture` turns on.
7. **Other schema rewriters** must use the rule-1 bracket (or the lease-and-suspect rule for staged rewriters) around their DDL: exodus, the twin-collapse rebuilds, bundle import, partial restore, and `legacy-tasks-lineage.ts`. A state with triggers but without `_sync_capture` must never be committed. Such a state would also break older builds, which can't repair it.
8. **The triggers are outside the Drizzle snapshot.** This is the same class of problem as T12740: drizzle-kit neither generates nor sees them. The open pass is their only owner, and a Gate test asserts that no migration SQL file mentions `_sync_cap_`.
9. **Doctor check `sync_triggers`.** Every `_sync_cap_%` trigger must reference existing objects: `_sync_capture` exists, and every table and column it references exists, **including referenced tables per `SYNC_TRIGGER_REFS` (N3)** (checked by comparing the trigger text with the text generated for the current schema). `--repair` drops orphaned triggers and reinstalls them when the flag is on. The open pass runs the same check, cheaply, before any write. It also verifies the live text of every classified guard and side-effect trigger for its suspension clause, and repairs it by re-running the owned DDL (C2(b)).
10. **T12341 §13 rollback is amended.** Step 0 is `cleo sync capture off` (drop every trigger); then `dropSyncMachinery` if sync is being removed; then the rollback's `DROP COLUMN uid`. Before sync, the rollback is otherwise unchanged. It never drops `cleo_trigger_suspend`, which the owned guard and side-effect triggers reference (C2).
11. **Tests (S2):**
   - a migration with `DROP COLUMN` on a captured column;
   - `RENAME TABLE` on a captured table and on an uncaptured one;
   - a store missing `_sync_capture` with triggers present: the doctor detects and repairs it, and the open pass heals it before any write;
   - exodus, twin collapse, bundle import and partial restore with capture on;
   - a legacy-lineage carry-forward marks its table suspect;
   - a drizzle-style rebuild of a referenced table (`tasks_tasks`) with capture on (N3);
   - a rebuild of a parent table with `ON DELETE CASCADE` children inside the bracket: every child row survives, `foreign_key_check` is clean, capture count unchanged (A);
   - a second WAL connection writing during a bracket waits (`database is locked` on its BEGIN) and its later write is captured (rule 1);
   - bundle import and partial restore mark their touch set suspect and the repair emits the difference; a migration backfill emits nothing and leaves no repair diff (B);
   - **Gate B with a real released binary (N3):** the published v2026.9.23 package (and every later release before S2 ships) opens a capture-enabled scratch store (`sync: 'test'`) and runs its full open DDL: migrations, twin collapse, lineage and exodus checks. It must not fail, and this build's next open must restore the triggers and report nothing orphaned.

### 2.4 Grouping and net-out rules

**Grouping.**
- A **validated frame** (its `_sync_frame` row exists) is one transaction.
- **Unframed captures (v11.3 (c)):** every capture with no validated frame (a released pre-S2 binary, an autocommit statement, Studio) is sealed as a **singleton transaction** and its segment is flagged `unframed`. The sealer never claims atomicity it did not observe. (v11 grouped maximal contiguous runs; that is withdrawn.)
- The provenance of an unframed capture is `foreign`.

**Splitting (M5).**
- A transaction, real or synthetic, is **never split while it fits in one segment blob**. Up to 1 MiB of ciphertext goes inline. Beyond that it becomes a blob segment of up to the client's `maxSegmentBlobBytes` (256 MiB), so a normal oversized group costs one blob upload and keeps its atomicity.
- Only a group larger than that cap is split. The split points are at `seq` boundaries, preferring points where `at_ms` jumps by at least 1 ms, where a real transaction boundary is likely. Each part is marked `part: i/n` and all parts share the same `txn` id.
- **Apply order (hard requirement, Q18):** receivers stage parts as they arrive and apply a split transaction **only when all parts 1..n are staged**, all in one apply frame and in order. No part is ever visible without the others. The only atomicity cost is latency: nothing of an oversized transaction is visible until its last part arrives. Real framed transactions larger than 256 MiB (bulk import, exodus) follow the same rule and are kind `import` or `exodus`.

**Netting per (table, uid) inside one transaction or group (R8).**

| Sequence in one transaction | Result |
|---|---|
| I, then any U | I with the final image |
| U, U, … | one U: per column, the first before and the last after; drop columns where before = after; drop the op when nothing changed |
| I … D | nothing |
| D, then I of the same uid | **U** of the non-key columns that differ, or nothing. Never a tombstone plus an insert. |
| D, I, D | D (before-image from the first D) |
| U … D | D (before-image from the first U's before) |
| I on a key or uid that row meta knows (foreign REPLACE) | U against the last image |
| K (re-key), uid already sent (`_sync_row_meta.sent = 1`) | **never netted away**. Ops on the old uid before the K and on the new uid after it keep their order. |
| K(x → NULL) followed by a fill NULL → y of the same row (T12341 clear-and-refill, N8, T12764) | nets to **one K(x → y)** |
| K on a uid that **never left the device** (no persisted segment ever carried it: `sent = 0`, or no row meta) | **dropped**. Earlier unsent ops of the row are rewritten to the final uid, because nobody else knows the old one. Before `row_identity_synced` exists, every uid is in this state, so T12341's ~124k-row clear-and-refill produces **no K ops at all**. |
| captures in a validated `apply` frame | subtracted field by field against `_sync_apply_intent` (§3.3, N1); only residual fields remain, as local writes |

**Clear-and-refill (N8).** T12341's open pass refuses clear-and-refill once `row_identity_synced` exists, and before that nothing has been sent. As a second guard, the refill runs inside the §2.3a trigger bracket (capture off). In the same transaction it rewrites the `uid` of pending `_sync_capture` rows through its old → new map, so no K(x → NULL) capture is produced. The netting rows above are the safety net if a refill ever runs with capture on.

**Older builds.**
- Label and dependency delete+reinsert: the D carries `OLD.uid`, and the I's NULL uid is recomputed from the natural key (T12341 §5.3), giving the same uid, so the pair nets to nothing.
- AC rewrites: the sealer's step 0 runs T12341's fill and graveyard relink before netting, so the reinserted AC takes the dead uid and the pair nets to a U of `text`.

**Compaction across transactions** applies only to ops not yet in a segment and not `inherited`:
- consecutive U ops on one uid merge, keeping per-field HLCs in `fhlc`;
- counter increments add up (§2.6);
- an I and a later D of a uid that never left the device drop both.

### 2.5 The sealer

`sealPending(scope, budget)` lives in `store/sync/sealer.ts`. It runs in two phases, and only in a process whose kill switch is not set.

**Phase A (async, outside any transaction).** This is everything that awaits:
- deriving the secret-values key from the master key;
- decrypting live secret values with the machine key (`encryptProjectSecret` / `decryptProjectSecret` and the global equivalents are async, `crypto/credentials.ts:321, 466`);
- sealing them for the home stream.

The results are held in memory, keyed by (table, uid, column, `shash`).

**Phase B (synchronous, one transaction).** It goes through the accessor's `taskTransactionQueue` (`sqlite-data-accessor.ts:208, 1405-1440`), so it serializes with every foreground and background writer on the handle. It runs `BEGIN IMMEDIATE` … `COMMIT` with **no `await`** inside (the same guard as §3.2). If a secret's current `shash` differs from the one phase A prepared, that row's ops are left for the next run instead of awaiting inside the transaction. Phase B's steps:

0. **Preconditions:**
   - **dependency:** T12341 must have landed (§5.2);
   - `row_identity_recipe` must be current (T12341 §12.1); otherwise refuse and report;
   - the replica binding must be valid; otherwise rebind and reconcile first (§1.5);
   - the triggers must be structurally sound (§2.3a).

   Then run the identity fill and graveyard relink for rows referenced by pending captures, and the repair diff for every `suspect:` table (§2.3, §4.4).
1. Read `live` `_sync_capture` rows in `seq` order, up to `budget`, ending on a group boundary. Validate each frame against `_sync_frame`. **Subtract apply intents field by field** (§3.3). Then group and net (§2.4).
2. Canonicalize timestamps in op values only (§1.8). Strip `strip` paths. Route by `peer_scope` once its map is ruled (a class change emits a D to the old stream and an I to the new one). Split out secret columns (§2.7). Turn counter columns into increments (§2.6).
3. References: use the uids captured at write time. Resolve the NULL ones from the local key, then translate JSON-array references. Refuse to emit a minted row whose `uid` or `birth_fp` is NULL: the group stays pending and is reported.
4. Assign HLCs with `tick(at_ms)` per op in `seq` order. The transaction's HLC is its maximum.
5. Write `_sync_txn` and `_sync_op`. Upsert `_sync_row_meta`. On a **K op, move `_sync_row_meta` from (tbl, old) to (tbl, new)**: keep `hlc`, `fhlc`, `version` and `chash`, and record the mapping in T12341's `tasks_uid_aliases` if the re-key path did not. Update `_sync_clock` and `_sync_ledger`.
6. Delete the consumed captures, their `_sync_apply_intent` rows, and `_sync_frame` rows that no live capture references (N10). Set `_sync_row_meta.sent = 1` for every uid in a segment when that segment is persisted (§2.8).

Sealing is lazy (Q4a). It runs before a push, before every pull-apply, from `cleo sync seal` and `cleo doctor sync`, and from the idle tick. It never runs inside the user's write transaction.

### 2.6 Op and transaction shape (R6)

Op types live in `contracts/src/ledger` as types plus zod schemas. Encoding is canonical JSON, with keys sorted and typed values:
- a string, or `null`;
- a number when the value is a safe integer;
- `{"$i": "<decimal>"}` for an integer beyond 2^53;
- `{"$r": "<%!.17g text>"}` for a REAL, where the parser also accepts `Inf`, `+Inf` and `-Inf` (L4), and `-0.0` arrives as `0.0`;
- `{"$b": "<base64>"}` for a BLOB;
- `{"$inc": <number>}` for a counter delta.

```ts
interface LedgerTxn {
  v: 1;
  txn: string;                // `${replicaId}:${localTxnSeq}`
  part?: [number, number];    // only for split oversized groups (§2.4)
  hlc: Hlc;
  project: string | null;     // merge key = (project, uid) (R10)
  scope: 'project' | 'global';
  via: 'accessor' | 'connection' | 'foreign' | 'repair' | 'rebind';
  kind: 'write' | 'remint' | 'rekey' | 'repair' | 'exodus' | 'import' | 'retire';
  actor: { agent?: string; session?: string; op?: string } | null;
  ops: LedgerOp[];
  retire?: { replica: string; successor: string; lastReplicaSeq: number };   // kind 'retire' only
  sig: string;                // Ed25519, txnSigningMessage (§2.8)
}
interface LedgerOp {
  t: string;
  u: string;                  // row uid (for K: the OLD uid)
  o: 'I' | 'U' | 'D' | 'K';
  h: Hlc;
  nu?: string;                // K only: the new uid
  bfp?: string;               // birth_fp: on EVERY op of a minted row (I, U, D, K); for K, the new value
  obfp?: string;              // K only: the old birth_fp
  fh?: Record<string, Hlc>;
  k?: Record<string, Value>;  // natural rows: key with refs as uids
  a?: Record<string, Value>;  // after-values (refs as uids); counters as {$inc}
  b?: Record<string, Value>;  // before-image (secrets excluded)
}
```

- **`bfp` on every minted-row op (H5).** A receiver that first learns of a row from a U, a D or a checkpoint can still classify it with T12341 §6.4. A carry, which gives an existing uid to a new row, or a re-key that changes `birth_fp`, reaches receivers through the K op or the next op's `bfp`. Cost: 32 hex characters per op.
- **K ops.** A receiver applies a K by moving the row's uid, re-keying its local references, and writing its alias (T12341 §9.3). If the old uid is unknown, the K is recorded as an alias only. A re-key cascade is several K ops in one transaction, owners first.
- **Counters (brain_patterns and others).**
  - `SYNC_COUNTER_COLUMNS` in the registry declares in-place counters, such as `brain_patterns` frequency and hit counts and `citation_count`.
  - For them the sealer emits `{"$inc": new − old}` instead of the absolute value. The before-image still carries the old value.
  - T12344 applies increments by summing, or uses `max` for columns declared monotonic-max.
  - This is recorded as a requirement on T12344.

### 2.7 Portable-secret handling

- **Secrets never enter the project stream.**
  - A whole-table secret row, whether project scope (`tasks_agent_credentials`) or global, goes to the owner's `home:` stream.
  - A secret column of a project row (`tasks_playbook_approvals.token`) is removed from the project op, and a companion op `{t, u, o: 'U', a: {col: sealedValue}}` goes to the home stream.
- **The outbox holds no secret copies.** Capture records only `<changed>`. At seal the sealer reads the live value, decrypts it with the machine key (credential-transfer's primitive, behind the credentials accessor from W3), and seals it with `seal(deriveKey(masterKey, 'secret-values'), plaintext, 'secret', "<table>\n<uid>\n<column>")`.
- **No crypto inside a frame (H1).** The receiver unseals the value and re-encrypts it under its own machine key **before** the apply frame opens. The key derivation and `encryptProjectSecret` / `encryptGlobal` are async (`credentials.ts:321, 466`). `fnSync` receives the finished ciphertext. The sealer does the same in phase A (§2.5).
- Before-images never include secret values.
- **Echo of secrets (N1).** The apply records a secret column write in `_sync_apply_intent` with the sentinel `enc = '<secret>'`, which matches the capture's `<changed>` marker. An applied secret is therefore never re-emitted, and secrets do not ping-pong between devices.
- **Hashes (M6).**
  - `_sync_row_meta.chash` is computed over the image **with every secret column removed**.
  - Secret columns get a separate `shash`: an HMAC-SHA256 under `deriveKey(machineKey, 'sync-shash')`, a device-local key.
  - `shash` is **stripped from checkpoint bundles**, so no collaborator or stream key holder gets a hash they could use to confirm a guessed token.
  - The repair diff (§4.4) uses `chash` plus `shash` locally.

### 2.8 Segments: building, signing, encrypting, uploading

- **Build.** `buildSegments(stream)` packs sealed, non-inherited transactions in `txn` order. Inline segments carry up to 1 MiB of ciphertext; larger ones are blob segments. Transactions are split only per §2.4. Plaintext is `deflate-raw(canonical JSON of LedgerTxn[])`.
- **Metadata.** `opCount`; `hlcMin`/`hlcMax`; `txnDeltas`, the per-transaction declared deltas (§2.11, Q19b); `schemaVersion = SYNC_SCHEMA_VERSION`; `deltas[t] = {created: count of I, deleted: count of D}` for this stream. U and K count as neither. A routing move is a D in one stream and an I in the other. These are **declared intents**, and §2.11 defines how a checkpoint reconciles them with applied effects.
- **Signing.** Each transaction's `sig` is Ed25519 by the device key over `cleo-nexus/txn/v1\n<stream>\n<txn>\n<sha256(canonical txn without sig)>`. The segment signature becomes `segment/v3`, whose metadata hash also covers `txnDeltas` (§2.11 §9).
- **Encryption.** `Journal.sealSegment` seals under the project data key or `homeStreamKey(masterKey)`.
- **Persist before push.** One local transaction:
  - writes `row_identity_synced` if absent (R9);
  - inserts `_sync_segment(stream, replica_id, replica_seq, meta_json, sealed BLOB, segment_hash, state='sealed')`;
  - marks the transactions `segmented`.

  Then the device registry's `hwm` for the stream is advanced (§1.5). If the process dies between the commit and the registry write, the store is ahead of the registry, which is the safe direction: only a store *behind* the registry triggers a rebind.
- **Upload.** `Journal.push(replicaSeq, plaintext, meta, sealed)` always passes the persisted `sealed` bytes. `duplicate: true` counts as success.

### 2.9 Idempotency, retry, ordering and gaps

- **Idempotency.**
  - A crash before persist: nothing left the device.
  - A crash after persist: push the same bytes.
  - A crash after the server stored the segment: the retry returns `duplicate: true`.
  - Nothing is ever re-sealed.
- **Retry.** Backoff honours `Retry-After`. Only the lowest unpushed `replicaSeq` of a stream is in flight at a time.
- **A store behind the server** (restore or rollback) is detected by the **server-authoritative** rule in §1.5: after pulling to head, the server holds this replica's `replicaSeq` with a different hash, or holds one the store lacks. The registry `hwm` is only a fast local pre-check, and its absence proves nothing. The store rebinds to a new replica, which never re-emits inherited rows and reconciles through a checkpoint diff (H3). The old replica is retired by a `retire` transaction.
- **Ordering.** Within a replica, transactions follow local commit order and HLCs never decrease. Across replicas, receivers apply in stream `seq` order (subject to the per-replica skew FIFO, §1.3) and decide by HLC.
- **Schema version.** A receiver refuses a higher `SYNC_SCHEMA_VERSION`: the segment is staged `refused-schema` with `E_SCHEMA_AHEAD`, the cursor advances, and it is replayed after an upgrade.

### 2.10 Local-only and derived exclusion

- Local-only and derived tables get no triggers.
- Local-only columns are not in any trigger's column list.
- The sealer asserts that every op's table is in the sync set and every column is captured. A violation is a hard error and is tested.
- `_sync_*` tables are themselves classified local-only in Gate A, with the note "sync machinery; `_sync_row_meta` travels inside checkpoint bundles". The Gate A test covers them. They are backed up under tier 1 like every table.

### 2.11 Deltas and the checkpoint regression rule under concurrency (H2, N2, C, T12752, T12758, T12776)

**Problem.** `checkManifest` (`manifest-check.ts:34-61`) requires `rows == parent.rows + Σcreated − Σdeleted`. Deltas are the *declared intents* of each writer, and the manifest is the merged state. They diverge whenever writers race: concurrent inserts of the same uid, double deletes, resurrection-guard drops, a D that loses to a U, guard refusals, and ops not yet applicable.

**Terms.**
- **Window:** the stream segments with `parent.coversSeq < seq ≤ coversSeq`. It is defined by checkpoint cadence, never by time.
- **TxnRef:** `(replicaId, replicaSeq, txnIdx)`, which names one transaction inside one segment.

**Decision (Q19 = (b), cleo-dev round 3): exact references, no voiding by age.** Of the options, only this one meets the owner's no-data-loss rule.

**1. Per-transaction declared deltas in segment metadata.**
- `SegmentMetaFields` gains `txnDeltas: Array<{ txn: number; deltas: TableDeltas }>`, one entry per transaction in the segment.
- The server checks that they sum to the segment's `deltas`.
- They are covered by the metadata hash (`segmentMetaCanonical` v3 → `segment/v3` signing message).
- This reveals no content beyond today's per-segment deltas, only the transaction boundaries.

**2. Tallies by deterministic replay (N2).** `replayTallies(parentBundle, window)`:
- restores the parent checkpoint's bundle into scratch;
- applies the window in stream `seq` order with T12344's apply in replay mode, **pinned to the checkpoint's `schemaVersion` and guard set** (D, T12777; see below);
- returns the manifest fields.

Author, endorsers and the single-device self-check all run it. The live inbox is never an input.

**3. Manifest fields per checkpoint:**

```ts
pending: TxnRef[];                                  // declared at or below coversSeq, not yet applied (whole txn)
voided:  Array<{ ref: TxnRef; deltas: TableDeltas }>;  // effects of applied txns that did not land, this window
revived: Array<{ ref: TxnRef; deltas: TableDeltas }>;  // previously voided effects that landed now
pruned:  Record<string, number>;                    // rows removed by replicated range-prunes (Q15)
replayPin: { journal: string; triggerSetHash: string;       // §7 below (NEW-9, R5-8)
             transitions: Array<{ seq: number; schemaVersion: number; journal: string }> };
unresolved: Array<{ ref: TxnRef; status: 'void' | 'pending'; op: LedgerTxn; conflict?: string }>;  // R5-6
```

**4. Server rule.** The server stores every segment's `txnDeltas` and each stream's cumulative voided set. Let `Decl(S)` be the sum of declared deltas over a set of TxnRefs `S`, and `A = (window txns ∪ parent.pending) − pending`, the transactions applied in this window. Per table:

```
rows == parent.rows + Decl(A).created − Decl(A).deleted
                   − Σ voided.created + Σ voided.deleted
                   + Σ revived.created − Σ revived.deleted
                   − pruned
```

Checks:
- `pending ⊆ window txns ∪ parent.pending`;
- every `voided.ref ∈ A`, and every `voided.ref` table count ≤ that transaction's declared count;
- every `revived.ref` is in the cumulative voided set, with counts ≤ what is still voided there;
- `0 ≤ pruned ≤ parent.rows + Decl(A).created`.

It is exact: no aggregate slack for pending, and no age bound.

**5. Nothing is voided by time or by missing data.**
- Same-stream references to **never-seen** uids stay `pending`, however long. References to **tombstoned** uids are void plus a `dangling-ref` conflict (§3.2, NEW-2).
- Cross-stream and cross-project references are soft (§3.2) and never block.
- **Split transactions:** a part-set with missing parts stays pending, and parts from a non-retired replica are **never voided**. Only if the replica is retired with parts still missing does the set become void plus a conflict. That void is revivable if the parts appear, for example from a restored segment.
- Void is a *merge outcome* of an applied transaction:
  - a duplicate insert, a double delete, a D that loses to a U, a resurrection-guard drop, a late insert behind a replicated prune (all **merge-decided**, and final unless the state changes);
  - a guard refusal, a reference to a tombstoned uid, a parent D with live children (NEW-4), or missing parts from a retired replica (all **conflict-raising**).

**6. Void is revivable; nothing is re-emitted with fresh HLCs (C, NEW-3, T12783).**
- A voided effect stays in `_sync_inbox` with status `void`, never deleted, together with its conflict record when there is one.
- **Revival is by replay of the original op.** When a later transaction makes a voided op valid (the parent re-created, the guard now passes, the missing parts arrive), replay applies the **original** op with its **original HLCs** and lists it in `revived`.
- **Merge-decided voids are never re-emitted.** v5's rule, that the author re-emits current values with fresh HLCs, would override merge winners. For example: A's D loses to B's concurrent U, A re-emits its D with a fresh HLC, B's update is lost, and the two sides can loop. So for LWW losses, D-vs-U, duplicate inserts and prune voids, the author adopts the merged state it pulls, and emits nothing.
- **Conflict-raising voids** (guard refusal, tombstoned reference, parent with live children, missing parts from a retired replica) are resolved in one of two ways:
  - **explicitly**, by an owner or agent decision executed as a new `write` frame. That decision is a new event, so a fresh HLC is correct for it;
  - **automatically, only by re-emitting the original op with its ORIGINAL HLCs** (a `repair` transaction, `via: 'reemit'`, carrying `reemitOf: TxnRef`), when the cause has cleared and the original op is no longer present in any bundle or inbox the author can see.
- **What the author can see (R5-6, T12797).** An author sees only its own inbox. So **checkpoint bundles carry every unresolved `void` and `pending` inbox entry**: TxnRef, op payload and conflict record. A device that restores or verifies a checkpoint therefore holds them too, and a revival can happen on any device.
- **Revival and re-emit are deduplicated by TxnRef.** A small registry `_sync_dedupe(txnref, op_idx, applied_seq)` holds entries **only for voided TxnRefs and for re-emits (`reemitOf`)**, not for every applied effect (R6 LOW). If the original is revived and its re-emit also arrives (or the other way round), the op applies **once**, so a `$inc` can't be counted twice. An entry is dropped once the checkpoint covering the revival or re-emit is verified.
- `sent = 1` still means the uid left the device. Re-emission never mints new HLCs for old intents.

**7. Guard triggers in replay (D, T12777; NEW-9, T12786).**
- **What is pinned (NEW-9, R5-8, T12797).** `replayPin`:
  - **`journal`**: the **whole ordered migration journal** of the checkpoint's store, as a list of `(folder, name, hash)`, ordered by `(created_at = folderMillis, name)`, which is drizzle's order, and hashed. A single head is not enough: stamped and drifted stores differ below the head.
  - **`triggerSetHash`**: sha256 over the normalized DDL of the store's **owned** triggers only (`OWNED_TRIGGERS` in `trigger-classes.ts`: the guard triggers plus the claim-release, handoff-mirror and AC-graveyard side-effect triggers that affect replay of portable tables), sorted by name. Device-local maintenance triggers (the `t12535_*` freeze triggers, track triggers) are excluded, so two stores that differ only in those hash the same (T13298). Normalization uses a **literal-safe tokenizer**: whitespace is collapsed and keyword case lowered **only outside** string literals and quoted identifiers, so `'Done'` inside a `WHEN` clause stays `'Done'`, and identifier quoting is unified.
- **Mid-window migrations.** A replica may upgrade during a window, and its later segments carry a higher `schemaVersion`. The manifest records the **transition points**: each seq at which the **maximum schema version seen so far** rises, with the journal pin in force from there. Replay applies the migrations at those points. **Mixed-version streams** (versions 1, 2, 1, 2, from replicas on different builds) replay against the **maximum schema seen so far**: a v1 segment after a v2 segment applies under the v2 schema, because transitions only rise (R6-8). Mapping a v1 op onto the v2 schema is a **deterministic T12344 function** (`upgradeOp(op, fromVersion, toVersion)`, pure and versioned with the migrations). An op it can't map (a dropped column with no mapping, a changed key) is **void plus a `schema-unmappable` conflict**, the same on every replica (R7-7).
- **Replay** restores the parent bundle, which carries its own schema, and replays with the pinned DDL. An endorser recomputes `replayPin` and requires it to match.
- **Verdict classes for an endorser:**
  - **match**: the only verdict that counts as an **endorsement**;
  - **mismatch**: the endorser knows every pinned migration (by name and hash) and the trigger set, and the result differs. That is a bug or tampering, reported as such;
  - **`cannot-verify: unknown-migration <folder/name>`**: a pinned migration's name is not in the endorser's files, because it is newer or from a fork. It is never reported as tampering, and **never counts as an endorsement** (R6-8);
  - **`cannot-verify: drift <name>`**: the name is known but its hash differs (a drifted store). Reported as drift, never as tampering.
- A guard abort in replay is void plus a conflict (§3.2), deterministic under the pinned DDL.
- **Note for T12341:** `session_handoff_no_update` is `BEFORE UPDATE` with no column list on `tasks_session_handoff_entries`. It aborts T12341's uid fill and any K on that table. T12341 must scope it (`BEFORE UPDATE OF <content columns>`) or exempt identity columns before that table joins the sync set.

**8. Single-device projects (Q20 = (a)).**
- The author's device re-runs `replayTallies` at the next sync, from the **server-downloaded** parent bundle and segments, not from local state, so it checks what the server actually holds.
- A device added later verifies the whole chain.
- A checkpoint that nobody else has endorsed stays visibly `unendorsed` in `cleo cloud status` and the web app.

**What the bounds protect against.** The server rule is exact against bugs. A malicious holder of a valid device key can still write a self-consistent false checkpoint. Only replay by another device (or the self-check from server data) detects that.

**9. Server and contract change (cleo-nexus, the team lead's side).**
- `txnDeltas` in `AppendSegmentRequest` and `Segment`, with the sum check.
- `segment/v3` signing, with the meta hash covering `txnDeltas`.
- Manifest fields: `pending`, `voided`, `revived`, `pruned`, `replayPin`.
- Server storage of per-transaction deltas and the cumulative voided set per stream.
- `manifestCanonical` v3, `checkpoint/v3` signing, and the new `checkManifest`.
- The cleocode `contracts/src/cloud` copy, with golden vectors in both repos.

S4 does not merge until T12758, T12776 and T12777 are implemented and this change is merged.

**10. Genesis cut (I, T12780; LOW, T12786), per stream.**
- Genesis is the first checkpoint authored **per stream** (`project:<id>`, and each `home:<user>` the store feeds) with `sync.push` enabled.
- Its bundle is snapshotted inside one read transaction that records `genesis_cut = max(_sync_capture.seq)` and `genesis_source_seq`, the highest capture seq whose effect the bundle includes. The two are equal by construction, and both are stored in `_sync_meta` per stream and in the checkpoint metadata.
- Every capture with `seq ≤ genesis_cut` for that stream's tables, and every sealed but unsegmented op older than the cut, is marked `folded` and never sent to that stream.
- Row meta is initialized at genesis (§1.2 genesis HLC).
- Captures after the cut seal normally. The stream's first segment has `replicaSeq` 0, and genesis has `coversSeq` 0 with an empty window.
- A store that feeds two streams may reach genesis on them at different times. The cut is tracked per stream, so a capture can be `folded` for one stream and live for the other: a row routed by `peer_scope`, or a secret companion op.

## 3. Receive and the apply boundary (T12343 → T12344)

### 3.1 Pipeline

`pullAndStage(stream)` runs in `store/sync/receiver.ts`:

1. `Journal.pull(cursor, trustedSigners)` verifies ordering, the per-replica gap rule, the replica-to-device pin, trust pins, hashes and decryption. Nothing unverified is returned. This code exists today.
2. For each segment, the receiver decompresses and parses it with the `contracts/src/ledger` zod schemas, then checks `schemaVersion` (§2.9) and every transaction's `sig` against the segment's device key.
   - A bad transaction signature refuses the whole segment (`E_FORBIDDEN`, reason `bad-txn-signature`).
   - **Segments from this replica (its own echo) are staged and applied like any other** (R5-1, T12794). Applying its own transaction confirms it against stream-derived state, and can void it (§3.5). v6 skipped own echoes, so an author never learned that its own transaction had been voided.
3. In one local transaction:
   - insert every transaction into `_sync_inbox`;
   - persist `_sync_cursor(stream, cursor_json, trust_state_json)`;
   - on the first staged transaction or checkpoint restore, write `row_identity_synced` (§3.4).

```sql
CREATE TABLE _sync_inbox (           -- local-only
  stream TEXT NOT NULL, seq INTEGER NOT NULL, txn_idx INTEGER NOT NULL,
  replica_id TEXT NOT NULL, replica_seq INTEGER NOT NULL, device_id TEXT NOT NULL,
  txn_json TEXT NOT NULL,            -- decoded LedgerTxn (secrets still inner-sealed)
  hlc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','pending','applied','void','conflict','held-skew','refused-schema')),
                                     -- retention: 'applied' rows are deleted once a verified checkpoint covers them;
                                     -- 'pending', 'void', 'conflict', 'held-skew', 'refused-schema' are kept until resolved
  applied_frame TEXT,                -- the _sync_frame of the apply (echo matching, §3.3)

  reason TEXT, staged_at TEXT NOT NULL, applied_at TEXT,
  PRIMARY KEY (stream, seq, txn_idx)
);
```

### 3.2 The contract T12343 offers T12344

- `stagedTxns(stream, limit): StagedTxn[]` returns transactions in (seq, txn_idx) order.
  - It holds a skewed replica's transactions FIFO (§1.3).
  - **Hard requirement (Q18):** a split transaction is returned only once **all** of its parts 1..n are staged, and T12344 applies the parts in one frame, in order. No part is ever visible without the others.
- **`withApplyFrame(stagedTxn, prepared, fnSync)` is enforced to be synchronous (H1 completion).**
  1. It first runs `sealPending` (async, §2.5), then every async preparation T12344 needs: unsealing and re-encrypting secret values (§2.7), and loading anything else it has to await. The results are passed in as `prepared`.
  2. It enqueues on `taskTransactionQueue` (`sqlite-data-accessor.ts:208, 1405-1440`), so it serializes with foreground transactions and `scheduleTaskBackground` work on the same handle.
  3. It runs `BEGIN IMMEDIATE`, inserts the `_sync_frame` row (kind `apply`), sets the ctx, then calls `fnSync(api, prepared)`.
  4. **Type guard:** `fnSync: (api, prepared) => SyncResult`, where `SyncResult` excludes `PromiseLike` (`T extends PromiseLike<unknown> ? never : T`).
  5. **Runtime guard:** if the returned value is a thenable (`typeof r?.then === 'function'`), the frame does `ROLLBACK`, clears the ctx and throws `E_SYNC_APPLY_ASYNC`. Any `api` call made after the frame ended throws too (`scope.assertActive()`).
  6. On success it sets `_sync_inbox.applied_frame` and the tallies, then commits.
- **The API.**
  - `uidToLocalKey`, `resolveRefs`, `rowMeta`.
  - `setRowMeta` (remote HLCs, origin, actor, chash).
  - `clockReceive`.
  - **`writeField(table, uid, column, value)`, `insertRow(...)`, `deleteRow(...)` and `rekey(...)`**: the only write calls. Each performs the SQL **and** records what it wrote in `_sync_apply_intent` (§3.3).
  - `markStaged(status, reason)`.
  - Tallies are computed by replay, not recorded live (§2.11).
  - **Guard refusals (D, T12777):** a guard trigger that aborts an apply (for example `parent_cycle_guard`, `status_pipeline` or `session_handoff_no_update`, where an LWW-merged combination is invalid) turns the op into **void plus a conflict record**. It is never an unhandled error. Void is revivable (§2.11).
  - **FK actions (E, T12778; NEW-4, T12784).**
    - The applier orders D ops children-first within a transaction, so the origin's own child D ops land before the parent's D.
    - `deleteRow(parent)` records FK-action intents **only for children whose own D is in the same incoming transaction** (normally none remain by then) and for SET NULL columns of such children.
    - **Before deleting the parent, the applier checks for remaining FK children** that the transaction does not delete, **counting only sync-set children** (R5-7, T12797).
      - Local-only and derived children (FTS rows, caches, local bookkeeping) cascade locally as SQLite does. Nothing about them is replicated.
      - Liveness is judged on **stream-derived state** (§3.5, R5-1), so every replica decides the same way.
      - What happens next is set by a per-table registry policy, **`onRemoteParentDelete`**:
        - **`conflict`** (the default: tasks, ACs, sessions, docs): if any sync-set child remains, the parent's D is **not applied** (SQLite would cascade the children away with no op). It becomes a **revivable void plus a `delete-with-live-children` conflict** listing the children. Resolutions are ordinary LWW writes in a `write` frame (delete the children, or keep the parent).
        - **`cascade-with-ops`** (hard deletes by design: `memory/brain-purge.ts` purges, row GC paths, conduit topic deletion with its messages and subscriptions): every replica deletes the remaining sync-set children deterministically inside the apply frame, with intents, so they are not re-emitted. Replay counts them in `fkCascadeDeleted` under this policy. Because the decision uses stream-derived state, every replica deletes the same children.
      - The registry declares a policy for every sync-set table that is an FK parent of sync-set children, and a Gate test fails on an undeclared one.
      - No row ever disappears without an op or a conflict.
    - **Cascade accounting class:** replay tallies FK-action effects separately (`fkCascadeDeleted`, `fkSetNull` per table). Replay asserts that every cascaded delete corresponds to a child D in the same transaction, or to the parent table's `cascade-with-ops` policy. A cascade outside that set is a replay error, never a silent count difference.
  - **Non-deterministic trigger writes in apply are a hard test error:** any residual in an apply frame that is neither declared in `SYNC_TRIGGER_DERIVED_COLUMNS` nor an explicit local write (re-mint, provisional id) fails the S5 test suite.
- T12344 owns every merge decision: LWW per field, counter sums, tombstone rules, uid collision and K handling, re-mint authority, Gate C validators, and conflict records.
- **Missing references (NEW-2, T12782)** in the same stream and project are classified by what the receiver knows about the target uid:
  - **Never seen** (no row, no tombstone, including GC-minimal ones, and no alias): the transaction is `pending` until the target arrives. There is no age limit (Q19b).
  - **Tombstoned** (deleted here, or known deleted): the op is a **`dangling-ref` conflict plus a revivable void**, never pending. A concurrent child insert under a deleted parent is surfaced at once, not held forever. It revives if the parent is re-created (through the same uid, by conflict resolution) or the delete is undone.
  - **Aliased** (re-keyed or re-minted): resolved through `tasks_uid_aliases` or the display-id aliases, then applied.
  - **Counter-key re-mint after a uid collision (v11.6, T13405).** A minted row whose uid hashes a counter key (`T####`, `D####`, `SN-###`) shares that key with the row it collided with, so after the origin re-keys its loser (the K, T13397) the winner is still held as `key-collision`. The loser's origin then re-mints the loser's key in a second local `rekey` frame, after the K's: the next counter value above every key it holds or has staged, renamed with its local references (child rows, supersession links, `decision:<id>` page nodes, page edges re-inserted under their new natural key, and `decision:<id>` evidence atoms in task verification payloads). The rename travels as ordinary U ops. A receiver holding the loser's insert behind the key folds the origin's later rename U (same origin, same uid and birth fingerprint) into that insert, so it places under the new key; a receiver that had placed the loser applies the U and points its own referencing rows at the new key through the write API. The two frames are separate transactions so a receiver applies the K (and records its alias) before it meets the rename. **Authority:** the origin, until the server path exists (T13404). Once a project syncs to the cloud the server becomes the re-mint authority (T12341 §9.2) and re-mints colliding keys at ingest; the origin rule is the fallback for projects that do not sync.
- **Holds are dependency-scoped, not head-of-line.** A pending transaction holds only:
  - later transactions whose ops touch a uid that the pending transaction inserts or modifies, or that reference such a uid, computed transitively;
  - for skew holds only, later transactions from the same origin replica (§1.3).

  Independent transactions, including later ones from the same replica, apply normally, because LWW by HLC makes their order irrelevant. `cleo doctor` shows each hold chain: the head transaction, the missing uid and the dependents.
- **Holds, guard triggers and K ops (R5-9):**
  - A guard refusal never creates a hold. It is a void plus a conflict, and dependents of a voided transaction are evaluated against state without it.
  - A hold follows its uid through K ops: when a K maps the held (missing) uid, or a uid a dependent references, to a new uid, the hold is re-keyed to the new uid through the alias, and it is released when the new uid arrives.
- **Soft references across streams and projects** (for example `brain_task_observations` in the home stream referencing `tasks_tasks` in a project stream) never pend and never void. The op applies.
  - The row's local reference column stores **NULL, or the local key when the target already exists locally**. It **never stores a uid**, which would break local key semantics and FKs.
  - The target uid lives **only** in the side table `_sync_soft_ref(tbl, uid, col, target_stream, target_tbl, target_uid, resolved_at)` (local-only).
  - A lazy resolver writes the local key into the row when the target appears, in an `apply`-kind frame with intents, so nothing is re-emitted (R5-9).
- `ConflictSummary.byKind` kinds include `clock-skew`, `refused-schema`, `dangling-ref`, `uncaptured-write`, `uid-collision` and `field`.

### 3.3 Echo suppression by field-level apply intents (H1, N1, T12751, T12757)

**v3's exact-image matching under-dropped** (cleo-dev, N1). An unmatched echo is re-sealed with fresh HLCs, which corrupts LWW, and secrets ping-pong between devices. The capture image differs from the incoming op's image whenever:
- LWW accepts only some of the fields;
- `$inc` is applied as a new absolute value;
- a secret column is re-encrypted;
- uids are remapped or carried;
- a reference points to a row inserted later in the same frame;
- a timestamp or other value is normalized.

**v4 records what the apply actually wrote and subtracts it field by field.**

```sql
CREATE TABLE _sync_apply_intent (     -- local-only; frame-scoped, deleted by the sealer with its captures
  frame  TEXT NOT NULL,
  tbl    TEXT NOT NULL,
  uid    TEXT NOT NULL,
  col    TEXT NOT NULL,               -- column name, or '*I' / '*D' for a row insert or delete, '*K' for a re-key
  enc    TEXT NOT NULL,               -- enc() of the exact SQL value written, '<secret>' for a secret column,
                                      -- the new uid for '*K'
  PRIMARY KEY (frame, tbl, uid, col)
) WITHOUT ROWID;
```

Every write the apply performs goes through the API calls in §3.2, which record the intent in the same transaction, from the **stored** value (F, T12779). Each write statement uses `RETURNING <enc(col) expressions>`, computed by the same SQL `enc()` as the capture triggers, so the intent is byte-equal to what the trigger will capture after column affinity (for example text `'5'` stored as integer `5`), defaults, CHECK coercions and trigger rewrites. Where `RETURNING` can't be used (a virtual table), the API re-reads the row with `enc()` after writing.

**Uid remaps propagate (G, T12779).** Every uid remap rewrites the reference-uid entries (`[local, uid]`) and `bfp` in **all** pending live captures and unsegmented `_sync_op` rows, in the same transaction as the remap: K ops, carries, re-key cascades, fills and N8 refills. This is the sealer's helper `remapPending(table, oldUid, newUid, newBfp)`, and the remap paths call it too.

**Subtraction by the sealer**, for each capture in a validated `apply` frame:
- **U:** each changed column whose after-`enc` equals the intent for (frame, tbl, uid, col) is removed from the capture. A reference column compares its local-key part. A secret column compares `<changed>` against `<secret>`.
- **I:** if a `*I` intent exists, every column matching an intent (or written as part of that insert) is removed. The insert itself is removed when no residual column is left.
- **D:** removed when a `*D` intent exists.
- **K:** removed when a `*K` intent names the same new uid.
- **What remains is residual:** fields the apply did not write, or wrote with a different value. Examples are a validator side effect, a re-mint, a provisional-id rename, a trigger cascade, or an interleaved writer. Residual fields are sealed as local writes **with new HLCs, and only those fields**. The rest of the row keeps the remote HLCs that `setRowMeta` recorded.

**Deterministic trigger cascades.** Some persistent triggers run identically on every replica when an op is applied, for example derived or bookkeeping columns written by a trigger from a replicated change. They would show up as residual on every replica. The registry declares them (`SYNC_TRIGGER_DERIVED_COLUMNS`), and in apply frames the sealer drops residual changes to those columns. Local-only claim columns, which the release triggers write, are never captured, so they are not an issue. A test lists every persistent trigger that writes a sync-set column and requires each to be declared or proven non-deterministic.

**Why intents rather than begin/end markers or image matching.** Intents are exact per field. They survive partial LWW, increments, secrets, remaps and normalization, because they compare what was written locally with what was captured locally. They can never drop a field that the apply did not write. The synchronous frame (§3.2) removes interleaving on the handle, and a stale ctx fails frame validation (§2.3).

A local resolution of a conflict is a new write in a `write` frame, and it travels.

### 3.4 The `row_identity_synced` marker (R9)

The marker is written to `tasks_row_identity_meta` (T12341 §12.1; local-only), with the value `{at, replicaId, stream, reason: 'send' | 'receive' | 'checkpoint'}`. Each scope store has its own marker.

- **First send**: written in the same local transaction that persists the first `_sync_segment` (§2.8). That is before any byte can be pushed, and before the git transport can write a ref from it. A segment that is persisted but never pushed still counts: its uids are committed to leaving.
- **First receive**: written in the staging transaction of the first pulled segment that holds at least one foreign transaction, or of a checkpoint restore.
- After the marker exists:
  - T12341's open pass refuses the clear-and-refill of identity values;
  - the §1.8 timestamp migration refuses to run;
  - `CLEO_DISABLE_ROW_UID_FILL` is ignored for rows that must be sealed.
- The sealer refuses to seal while `row_identity_recipe` is stale (§2.5 step 0), so no pre-release uid can ever leave.

### 3.5 Stream-derived conflict decisions and a scoped rebase (R5-1, T12794; R6-1..R6-8, T12807, T12808, T12810)

**Problem (R5-1, unchanged).** Void decisions must not depend on local apply order:
- **Case 1.** A's D(P) is sequenced before C's I(K under P). Every replica must void K, including C.
- **Case 2.** C's I(K) is sequenced first. Every replica must void A's D, including A.

**Rule 1: conflict predicates are evaluated only against stream-derived state**, as of each op's stream position. This covers live children (sync-set children only), tombstoned and never-seen references, guards, and LWW. Own echoes are staged and applied (§3.1).

**Rule 2: a local UNDO LOG is the rewind source (R6-2, T12807; R7-4, R7-5, T12815).**
- v7 did not define where rewind images came from, and nothing available had them:
  - captures are deleted at seal;
  - sealed ops and stream b-images omit secret values;
  - they drop `strip` paths;
  - they hold netted U merges.
- So the capture triggers also write the undo log, in the same statement, in pure SQL:

```sql
CREATE TABLE _sync_undo (             -- local-only
  seq         INTEGER PRIMARY KEY,    -- = the _sync_capture seq that produced it
  txn_local   TEXT,                   -- labelled at frame finish (v11.3); NULL = unframed writer
  kind        TEXT,                   -- labelled at frame finish: write | repair | import | ...
  tbl         TEXT NOT NULL,
  rk          TEXT NOT NULL,
  uid         TEXT,
  op          TEXT NOT NULL,          -- I | U | D | K
  before_full TEXT,                   -- enc() before: every SYNC-CAPTURED column (D), ONLY the changed columns (U,
  after_full  TEXT                    -- v11.3 (b)); NULL for I / D respectively; secret ciphertext and strip columns
                                      -- included; local-only columns EXCLUDED (Rule 4)
);
```

- **Local-only columns are never in the undo log (R7-2).** Claims and leases change through writes the capture triggers deliberately ignore (renewals, releases), so an image of them would be stale. Rule 4 handles them.
- **When undo is written (R7-4, revised by C1, T12820).** Undo is on exactly while **`sync.push` is on**, from the genesis cut onward.
  - The trigger `WHEN` checks `EXISTS (SELECT 1 FROM main._sync_meta WHERE key = 'undo_enabled')`.
  - Before genesis (S2's shadow mode, or push off), undo is off. Nothing then is unsequenced in the stream sense: every capture is folded into genesis (§2.11 §10) and never rewound.
  - **Pull being off or refused does not turn undo off.** Undo keeps accumulating until pull resumes. v9 turned undo off in that case, which left unsequenced writes without undo, and that was incoherent.
  - **`undo_enabled` toggles only at transaction boundaries**: in its own `BEGIN IMMEDIATE` transaction, with no frame open. It is enabled **in the same transaction that records the genesis cut and turns push on**, so every pushed transaction has undo.
- **Rollout gap (S4 before S5).** If push ships before pull, undo exists for every pushed transaction but nothing drains it. When S5's pull turns on, the first pull **does not reorder the stream (D6)**:
  - it applies staged transactions strictly in `seq` order, as always;
  - each own echo it meets is checked individually for the fast path. If no foreign transaction sequenced before it touched its footprint, it is marked sequenced and its undo dropped, with no rewind;
  - only echoes that fail that check trigger a scoped rebase, at their own position.

  "Drain first" therefore means that the fast path is tried first for each echo, not that own echoes jump the queue. The budget below still applies.
  - **Budget, not a mode (C1).** v9's "non-rewindable" mode is **dropped**. Without undo, unsequenced local writes would sit in place while stream predicates evaluate, which is R5-1's divergence again, and deferring the stream instead would deadlock.
    - `UNDO_BUDGET_BYTES` defaults to 256 MiB per store.
    - At 80% of the budget, `cleo doctor` and `cleo sync status` warn and suggest a pull.
    - **At 100% (D5, T12828): warn, and keep writing undo.** Undo grows exactly when the replica can't reach the stream: offline, pull off, or `E_SCHEMA_AHEAD`. A forced rebind at that moment would need the network it doesn't have. So:
      - the replica raises a persistent `undo_budget_exceeded` warning in doctor, status and every pull result;
      - it **keeps writing undo**;
      - it schedules a **rebind at the next connectivity**, when a pull to head succeeds.
    - **The rebind:**
      - pulls to head;
      - runs the checkpoint three-way reconcile (§1.5);
      - **emits a signed `retire` transaction for the old replica id**, because a rebind that does not retire it would pin the fold horizon (§1.7) and skew T12341's `remintAuthority`;
      - empties the undo log.
    - **Late segments of the retired replica** (pushed before the rebind but sequenced after the retire) are treated as **inherited history**: applied as ordinary stream ops by everyone, and **not** counted as new conflicts against the successor's reconcile.
    - Undo is never silently stopped while push is on.

- **Apply-frame writes don't accumulate (R7-5, C4; narrowed by D1, T12825).** `finishCaptureFrame` deletes the frame's undo rows before COMMIT **only when the frame `kind` is `apply` or `rebase`** (v11.3: at frame finish, not per row). Those are the only kinds whose writes are never pushed as this replica's own transactions.
  - **Every locally authored, pushed kind keeps its undo until its echo:** `write`, `repair` (including the `fk_orphans` repair), `import`, `exodus`, `remint`, `rekey`, and the rebind-reconcile `repair`. v10 deleted undo for all non-write kinds, which would have left those unrewindable.
  - Otherwise frame finish fills `txn_local` and `kind`.
  - Undo rows with `txn_local IS NULL` (foreign writers) are kept, grouped like their captures (§2.4), until sequenced.
- **Size (R7-6).**
  - Two images in `enc()` text or hex are about 2–3× the row size.
  - Append-only tables keep only `rk` and `uid`, because their rewind is a delete.
  - `cleo doctor sync` reports undo bytes per table and lists undo rows kept for voided transactions (Rule 6).
  - A disk budget (the cap above) applies.
  - S2 reports undo bytes per day per table in shadow measurement, computed by a dry-run estimator because undo is off there.
- **Drop rule.** Undo rows are deleted when:
  - their transaction is sequenced (own echo applied);
  - a rebind reconcile commits;
  - they were written in an `apply` or `rebase` frame (by the stamp, D1);
  - **their capture is `folded`, or is routed only to streams that are not pushing (D6)**. `undo_enabled` is per store, but genesis is per stream, so a store feeding a pushing project stream and a not-yet-pushing home stream writes undo for both. The sealer drops the undo of captures that no pushing stream will ever sequence.
- **Fallback** when an undo row is missing: the stream op's `b`-image for ordinary columns; rows with secret or `strip` columns are refused with a `cannot-compensate` conflict.

**Rule 3: rebase only the footprint (R6-4, T12808; R7-6, T12815).**
- **Pages.**
  - Staged stream transactions apply in pages, each its own frame, bounded by `REBASE_PAGE_OPS` (2,000) and `REBASE_PAGE_MS` (50 ms).
  - **A page breaks only on transaction boundaries**, and a split transaction's part-set is always whole in one page (Q18).
  - **Declared exemption:** a single transaction larger than one page (a bulk import, an exodus, a split part-set) is applied alone in its own frame and may exceed the 50 ms and 100 ms targets. It is logged, and the benchmark reports it separately.
- **Footprint of a page, F:**
  - every uid the page's ops write or reference;
  - every uid a predicate on them reads, from the **declared footprint** of each predicate and guard (live children, parent chain for `parent_cycle_guard`, the task row for `status_pipeline`, the container matrix for `non_containment`, and so on).
  - **A Gate test (R7-6) requires a declared footprint for every guard trigger** and fails on a guard without one.
- **Scope.** An unsequenced local `write` transaction is in scope if its footprint intersects F. Its footprint is added to F, repeated to a fixed point. Only in-scope transactions are rewound and replayed.
- **Own-echo fast path, bounded (R7-6).**
  - The check "no foreign transaction sequenced since this transaction's commit touched its footprint" uses an index of uids touched by applied foreign transactions, `_sync_foreign_touch(uid, seq)`, holding only entries newer than the oldest unsequenced local transaction.
  - It is bounded by `FOREIGN_TOUCH_MAX` (default 200,000 entries). When the bound is exceeded, the index is marked incomplete and the fast path **falls back to the scoped rebase** for every own echo until the unsequenced backlog drains and the index is reset.
- **Append-only tables are never rewound.**

**Rule 4: trigger modes by flag, FK discipline, and local-only state (R6-1, R7-1, R7-2, R7-3; T12807, T12813, T12814).**
- **Suspension is a flag row, not DDL (R7-1, measured).**
  - v8 suspended triggers with the §2.3a DDL bracket. cleo-dev measured 34 ms per swap for 800 triggers, three times per page, which blows the 50 ms page and the 100 ms lock target. Every swap also bumps the schema cookie and forces every connection to re-prepare its statements.
  - A TEMP flag is impossible, because a persistent trigger cannot reference the TEMP database.
  - **What works (measured):** a MAIN table `cleo_trigger_suspend(scope TEXT PRIMARY KEY)`. The rebase frame inserts `scope` rows inside its own transaction and deletes them before COMMIT. Under WAL no other connection can see uncommitted rows, so their triggers stay fully active. A crash rolls the rows back.
  - Every trigger in scope carries `WHEN NOT EXISTS (SELECT 1 FROM main.cleo_trigger_suspend WHERE scope IN ('<its class>','all'))`.
  - **COMMIT asserts `cleo_trigger_suspend` is empty.** The frame deletes and checks in the same transaction, so a committed suspension can't happen. The open pass also asserts it is empty and clears it.
- **Every trigger is classified**, with a Gate test that fails on an unclassified trigger in either store. **`frozen-guard` triggers carry no suspension clause and are never rewritten (D4).** They only refuse writes to frozen twins, which a rebase never touches. Giving them a clause would make 9.24's replace-if-text-differs (`twin-collapse.ts:1185-1190`) and this build's live-text repair flip their DDL on every open that alternates between builds.

| Class | Triggers | Rewind | Apply | Replay |
|---|---|---|---|---|
| `capture` | `_sync_cap_*` | suspended | active (with intents) | suspended |
| `guard` | `parent_cycle_guard`, `status_pipeline`, `non_containment`, `session_handoff_no_update`, `lease_iso` checks, … | suspended | active | active |
| `side-effect` | the claim-release triggers (`tasks_sessions_release_claims_on_end`, `_on_delete`, `tasks_tasks_release_claim_on_terminal`), `trg_tasks_session_handoff_mirror` (writes the sync column `handoff_json`), the AC graveyard, `t12535_track_*` | suspended | active | suspended |
| `derived-maintenance` | FTS `_ai`/`_ad`/`_au` and other index maintenance | **always active**, or the index drifts from its content | active | **always active** |
| `frozen-guard` (D4) | twin-collapse's `t12535_freeze_*` triggers on frozen bare twins | **no clause, never modified** | active | active |

- **Migration, and the flag table's ownership (C2(a), T12819; blocks S2).**
  - **One drizzle migration** creates the table **`cleo_trigger_suspend(scope TEXT PRIMARY KEY)`** **and** rewrites the owned guard and side-effect triggers with their `WHEN NOT EXISTS` clause, in the same file. Those triggers are claim-release, `status_pipeline`, `parent_cycle`, `non_containment`, the handoff mirror and `no_update`, and `lease_iso`. No state can exist in which a trigger references the table and the table is missing.
  - The table is **schema-owned**: it is declared in the Drizzle schema and classified `local-only` in Gate A.
  - It is **never dropped**, and deliberately **not** named with the `_sync_` prefix:
    - `dropSyncMachinery` (§2.3a rule 4) and the T12341 §13 rollback drop `_sync_*` tables, and both leave it alone;
    - a lint rule forbids `DROP TABLE cleo_trigger_suspend` anywhere;
    - turning capture off (`cleo sync capture off`) never touches it.
  - **Recreated at open-pass STEP 0 (team lead's answer, round 9).** The open pass runs `CREATE TABLE IF NOT EXISTS cleo_trigger_suspend(...)` **before migrations**, because every write to tasks, sessions or ACs fires a trigger that reads it, and any `ALTER … RENAME` re-validates every trigger.
    - Partial restore and bundle import always create it.
    - `cleo doctor` gives a specific message when it is missing.
    - A 9.24 binary opening a store where it is missing **fails closed** ("no such table"): loud, with no data loss.
  - Without this, a missing table would make every write to tasks, sessions and ACs fail, and any `ALTER … RENAME` too, even with capture off.
  - The new DDL feeds `triggerSetHash` (§2.11 §7). The migration is one §2.3a bracket; the DDL-swap cost applies once, at migration time.
  - **Measured cost (cleo-dev, r4/t9.mjs):** the `WHEN NOT EXISTS` subquery adds about **0.5 µs per write**, which is noise against the 2 ms p95 budget. A 9.24 binary opening a store with these triggers works, because the table exists and is always empty outside a frame.
- **Live-text verification (C2(b)-(d), T12819).**
  - **(b)** The open pass and `cleo doctor sync_triggers` check every classified guard and side-effect trigger's **live** `sqlite_master.sql` for its exact `WHEN NOT EXISTS` clause, not just that a class exists. A trigger missing the clause, for example after an older build recreated it, is **repaired by re-running the owned DDL** for that trigger, the same replace-if-text-differs pattern as `twin-collapse.ts:1185-1190`.
  - **(c)** A lint on migration SQL: every `CREATE TRIGGER` whose name is classified `guard` or `side-effect` must contain the clause. **The lint is FORWARD-ONLY (D4, T12827):** it applies only to migration files whose `folderMillis` is greater than the WHEN-clause migration's.
    - **Released migration files are NEVER edited**, for example `t11884-restore-prefixed-task-triggers` and `t12502-task-claim-leases`, which create those triggers without the clause. Editing them would change their file hash, and #1719's `E_MIGRATION_HASH_DRIFT` check would brick every store migrated after the cutover.
    - The clause arrives only through the new migration, which drops and recreates the owned triggers.
  - **(d)** A Gate test (the T12740 class): a drizzle-style rebuild of `tasks_tasks` (create `__new`, copy, drop, rename), then an open, leaves every classified trigger in both stores with its clause in its live text. The classification Gate is extended from "has a class" to "live text matches its class".
- **Local-only columns are never written by rewind or replay (R7-2).** Rewind and replay write only sync-captured columns: undo images exclude local-only columns (Rule 2), and U rewinds and replays set only those columns.
  - For an in-scope **insert** that is rewound (deleted) and then replayed (re-inserted), the frame first **snapshots the row's CURRENT local-only values**, the live claims and lease as they are now, keyed by the local PK. It restores exactly those values on re-insert.
  - A lease renewal or release that wrote no capture or undo row is therefore preserved.
  - If the row is held instead of replayed, the snapshot is kept with the held row and restored if it is later applied.
- **FK discipline in the frame (R7-3, measured):**
  - **(d)** The frame asserts `PRAGMA foreign_keys = 1` before starting, because `defer_foreign_keys` is a no-op under FK OFF.
  - **(c)** `PRAGMA defer_foreign_keys = ON` is set **after each page's `BEGIN IMMEDIATE`**, because it resets at every COMMIT.
  - **(a) Pre-existing orphans.** A rewind delete plus re-insert of a row that is part of a pre-existing orphan relationship trips the deferred FK counter. COMMIT then fails and SQLite leaves the transaction OPEN, which would wedge that footprint on every pull. So:
    1. Before rewinding, the frame computes the scoped violation snapshot of the §2.3a rule-2 kind (multiset, rowid-independent) for the page's footprint tables.
    2. Rows involved in snapshot violations are **excluded from rewind** and marked **`fk_excluded`** (C3, T12821), a state distinct from `held`:
       - they **stay in place** and **stay counted** in the ledger and the Gate D hash, because every other replica has them too;
       - the rebase evaluates predicates as if they were sequenced;
       - they are reported as `fk_orphans`.
    3. **If COMMIT still fails**, the frame issues an explicit `ROLLBACK`, so the transaction is never left open. It records the footprint as `fk-blocked` and schedules the bounded `fk_orphans` repair (§2.3a) for those rows. The next pull retries after the repair.
       - **The `fk_orphans` repair never deletes user data (C3), and it first checks whether the orphan is only LOCAL damage (D3, T12826).** For each orphan's missing parent uid, it looks at the **merged stream state** (row meta, tombstones, folds and the latest verified checkpoint):
         - **The parent is live elsewhere** (merged state has it): the orphan is local damage. The parent is **restored locally** from the checkpoint bundle, or from a pull of its latest ops, in an `apply`-kind frame, **emitting nothing**. There is no conflict, because every other replica already agrees.
         - **The parent is tombstoned:** a `delete-with-live-children`-style conflict naming the children. Nothing is changed automatically; resolution is an explicit write frame.
         - **The parent is unknown** (never seen anywhere): re-parent to the **sentinel** where the table defines one, else set the FK column to NULL where it is nullable, else report only. **In every case a conflict record is written**, so the owner sees it.
         - **The sentinel (D3(a)(b)):**
           - its uid is **deterministic and synced**: the natural uid over `(project, table, 'fk-orphan-sentinel')` (T12341 §5.3 recipe), so every replica refers to the same row and none mints its own;
           - it is created on first use as an ordinary op;
           - its type and position are chosen to **satisfy `parent_type_matrix` and the cycle guard** (for tasks: a root-level container type that the matrix allows as a parent of every task type, with no parent of its own);
           - a Gate test inserts it and re-parents one child of every type.
         - **Pre-sync (D3(d)):** before `row_identity_synced` exists, the repair is **report-only**. There is no merged state to consult, and nothing is written.
       - Each repair write that does happen (sentinel re-parent, NULL) is an ordinary `repair` write, captured, kept in undo until its echo (D1) and sent, so every replica converges on it.
    4. Test: a store with a pre-existing orphan in the footprint completes a rebase frame (the orphan is excluded and reported), and a forced failing COMMIT leaves `!isTransaction`.
  - **(b) FK actions are immediate.** `defer_foreign_keys` defers constraint **checks**, not ON DELETE/UPDATE **actions**, so a cascade still runs at once. Replaying a local parent D after the stream applied a third party's child would cascade that child away uncaptured and unheld, and the repair would then emit a D for someone else's child. Therefore:
    - the NEW-4 predicate also applies to **replay**: a local D of a parent with **live sync-set children not covered by the local transaction's own child D ops** is **not replayed**. The local transaction is **held** (Rule 5), and its echo is decided by the stream, which voids it with a `delete-with-live-children` conflict under the default policy;
    - rewind never deletes a parent that has children other than those the rewound transaction itself inserted.
    - Test: A deletes P locally (unsequenced), the stream delivers B's child K under P, and a rebase leaves P and K present, holds A's D, and emits no repair D.
- **Rewind order** remains FK-safe inside the deferred transaction: re-insert parents before children, delete children before parents.
- **U rewind and replay touch ONLY the columns the local transaction changed (D2, T12825).**
  - **The bug:** a U undo row stores full images, but a rewind that restored the full `before_full` would revert stream writes from earlier pages. Page 1: foreign F1 sets column `a` on row X, and local L (which set `b`) is rewound and replayed. Page 2: F2 touches X, and L is in scope again. A full-image rewind restores the pre-F1 `a`, replay then skips `a` because F1's HLC is newer, and F1 is lost locally. The replica diverges.
  - **So** a U undo row records its **changed-column set** (the columns whose `before` and `after` differ in the capture). Rewind writes `before` values **only for those columns**, and replay writes `after` values **only for those columns**, each still subject to per-field LWW (R6-7). Columns the local transaction did not change are never written by rewind or replay.
  - I and D rewinds are whole-row by nature. A D rewind re-inserts the row's `before_full`, then the page's stream ops re-apply on top in `seq` order, so no earlier stream write to that row is lost: it is in the stream-derived state the page applies.
- **Replay respects LWW (R6-7):** fields whose stream HLC is newer are skipped.

**Rule 5: held rows are visible and accounted for (R6-3, R6-5, T12808, T12810).**
- A local write that can't be replayed is **held**: for example, an insert of K whose parent the stream just deleted. It stays in the outbox, is sent and sequenced, and is decided by the stream.
- `_sync_row_meta.held = 1`, and `_sync_ledger` counts it in `held(tbl)`. The ledger check (§4.3), the repair diff (§4.4) and the Gate D manifest hash all skip held rows. So there is no spurious repair D colliding with the held insert.
- **Long holds.** `cleo doctor sync` lists every row held longer than `HELD_WARN_DAYS` (default 7), with its blocking conflict (C3).
- **User-visible.** `cleo show <id>` for a held row returns **`E_SYNC_HELD`**, not `E_NOT_FOUND`. The error carries the held values (from `after_full`) and a conflict preview, for example "parent P deleted by replica A at hlc …; this insert will be voided unless P is restored". Pull results list held transactions, and `cleo sync status` lists them all.
- When the held transaction's own echo is decided, one of two things happens:
  - it is **applied** (rare: the parent was re-created), and `held` is cleared;
  - it is **voided**, the conflict appears, the undo row is kept until the conflict resolves, and the op stays revivable.

**Rule 6: a voided own transaction stays rewound (compensation).** If the own transaction was in scope, it is already rewound. Otherwise it is rewound now from the undo log, restoring every column. The Rule 2 fallback and its refusal apply when the undo row is missing.

**Test plan (required).**
- **Convergence (R5-1):** three replicas, A deletes P, C inserts K under P, and B observes.
  - Run both stream orders, varied pull points, and one replica offline across both pushes.
  - All three must end with equal Gate D hashes, equal `voided` lists, and the same visible conflict.
  - Run variants with `cascade-with-ops` and with append-only children.
- **Claims survive a pull (R6-1):** start a session, claim a task, push, pull (own echo only, which takes the fast path), and pull again with a foreign transaction touching the same task (a forced in-scope rebase). The claim columns are unchanged, and no release trigger fired.
- **Credential and strip round trip (R6-2):** an unsequenced write to `tasks_agent_credentials` and to `tasks_tasks.verification_json` (with a `strip` path) is rewound and replayed byte-identically. With the undo row removed, the fallback raises `cannot-compensate` and writes nothing partial.
- **Held insert (R6-3, R6-5):** the stream deletes P, and a local K insert under P is held. There is no repair D and no ledger mismatch, the Gate D hash is unchanged, `cleo show K` returns `E_SYNC_HELD` with a preview, and after the echo is voided the conflict is visible everywhere.
- **Backlog benchmark (R6-4):** a synthetic 7-day offline backlog at the S2-measured per-table rates (STDP included), on a cleocode scratch copy. Report page frame time p50/p99, maximum write-lock hold, total catch-up time, and the number of rows rewound. Targets: lock hold ≤ 100 ms per page; rows rewound ≤ the footprint, not the backlog.
- **Replay LWW (R6-7):** a stream field with a newer HLC is not overwritten by replay.
- **Cross-page U rewind (D2):** page 1 foreign F1 sets `a` on X; page 2 foreign F2 sets `c` on X; local unsequenced L sets `b` on X and is in scope on both pages. After both pages, X has F1's `a`, F2's `c` and L's `b` (or F's value where the stream HLC is newer), identical on all three replicas.
- **Pushed repair keeps undo (D1):** an `fk_orphans` repair write and a remint are rewound and replayed correctly before their echo, and their undo is gone only after the echo.
- **Sentinel (D3):** two replicas independently needing the sentinel produce one row, with one uid. A locally damaged orphan whose parent is live elsewhere is restored with no emitted op. A tombstoned parent gives a conflict with no write. Pre-sync is report-only.
- **Budget at 100% offline (D5):** undo keeps growing and the warning is visible. At the next successful pull the replica rebinds, emits `retire`, and the fold horizon and `remintAuthority` exclude the old id. A late segment from the old id applies as history with no new conflict.
- **Per-stream undo drop (D6):** a store pushing only its project stream drops undo for captures routed only to the home stream.
- **Lease renewal survives a rebase (R7-2):** claim a task, renew the lease with no captured write, force an in-scope rebase touching that task, and the renewed `lease_expires_at` and claim columns are unchanged.
- **Orphan rewind commits (R7-3a):** a pre-existing orphan in the footprint; the rebase frame commits, the orphan is held and reported, and a forced failing COMMIT ends with ROLLBACK and `!isTransaction`.
- **Local parent D with a concurrent child (R7-3b):** no repair D; P and K present; A's D held, then voided by the stream with the conflict visible.
- **Suspension cost (R7-1):** the frame's suspend and resume on a store with 800 triggers costs well under 1 ms, no schema cookie bump is observed, and another connection writing during the frame is captured normally. **COMMIT refuses** (the frame throws before COMMIT) when `cleo_trigger_suspend` is non-empty. A crash mid-frame (kill -9) leaves the table empty on reopen, and the open pass asserts it. With the table missing, the doctor and the open pass recreate it through the owned migration's DDL before any write (C4, C2).
- **Undo bounded (R7-4, C1):** with push off (shadow mode), 10k writes leave `_sync_undo` empty. `undo_enabled` flips only in its own transaction, together with the genesis cut. With pull refused, undo keeps growing and the 80% warning fires. At 100% it keeps growing, and the rebind happens at the next successful pull (D5), after which every row matches the merged checkpoint. S4-before-S5: the first pull applies strictly in `seq` order and tries the fast path for each own echo individually. An echo that fails it gets a scoped rebase at its own position, and the stream is never reordered (D6).
- **Flag table ownership (C2):** `dropSyncMachinery`, `cleo sync capture off` and the T12341 rollback leave `cleo_trigger_suspend` in place, and writes to tasks, sessions and ACs keep working. A drizzle rebuild of `tasks_tasks` followed by an open leaves every classified trigger with its clause (C2(d)).
- **fk_excluded (C3):** an orphan row in the footprint stays in place, is counted in Gate D and the ledger, and is repaired by sentinel re-parent or NULL, or reported, never deleted.
- **No idle watermark ping-pong (R7-7):** two idle replicas pulling in a loop exchange no segments after the first round.
- **Trigger classification (R7-1) and guard footprints (R7-6):** Gate tests fail on an unclassified trigger or a guard without a declared footprint.

### 3.6 Write validators under merged apply (T12859; summary, full inventory in `t12859-sync-write-validator-inventory`)

**Problem.** The applier's write calls (`writeField`, `insertRow`, `deleteRow`, §3.2) never run the TypeScript write paths. On apply, only triggers, CHECKs, UNIQUE indexes and FKs fire. A merge of two ops that were each valid on its own device can therefore produce a state the CLI would refuse, and nothing reports it. T12859 inventoried every TypeScript rule enforced on write to a synced table (Gate A classes portable-project, portable-personal and portable-secret) in `packages/core`, `packages/cleo` and `packages/playbooks`. The full row tables are in spec doc **`t12859-sync-write-validator-inventory`**, with file:line, the tables protected, trigger coverage, merge risk, class and footprint for each row.

**Classes (475 rows; a rule found by two domain passes counts twice):**

| class | rows | meaning |
|---|---:|---|
| `trigger-covered` | 46 | An existing guard, CHECK, UNIQUE or FK enforces the rule on apply. A violation becomes void plus a conflict (§3.2). |
| `post-apply-check` | 152 | A multi-row invariant evaluated over the page footprint (§3.5 Rule 3). A failure becomes void plus a conflict. Each row maps to exactly one of PAC-01..15. |
| `monotonic-merge-rule` | 100 | A per-field or per-row transition or grouping rule. It goes into T12344's typed LWW rules. |
| `identity-layer` | 7 | An id-minting problem (display id, integer PK, device-derived id). It belongs to the T12341 re-mint and alias work, not a validator. |
| `not-sync-relevant` | 170 | Input shape, local-only state, device-owned rows, or a single-column value rule. |

**T12344 post-apply check families.** The footprints are declared in the inventory, and the R7-6 footprint Gate test covers them.

- PAC-01 tree shape: the full type matrix, non-saga roots, depth, and self-parent on insert.
- PAC-02 terminal parent vs live children, plus re-evaluation of the auto-complete rollup.
- PAC-03 dependency graph: acyclic and no self-edge. No guard exists today in TypeScript or SQL; see T12886.
- PAC-04 done ⇒ passing verification and full AC evidence coverage.
- PAC-05 AC integrity: `acceptance_json` ⇔ AC rows, the child_task projection, bindings, the locked-stage receipt, and relation non-containment when `parent_id` changes.
- PAC-06 lifecycle rows: the pipeline's task exists, and pipelines and stages are unique.
- PAC-07 derived mirrors: label, sticky and agent junctions, `docs_wikilinks`, and the handoff mirror. The alternative is to make these local-derived.
- PAC-08 sessions and goals: one active session per scope, a consistent prev/next chain, one open work interval, and one live goal.
- PAC-09 audit idempotency across replicas, prune exemptions, and a single rollback per receipt.
- PAC-10 identity collisions: re-mint or alias hook.
- PAC-11 at-most-one and dedupe across replicas.
- PAC-12 soft references and orphans on FK-less tables. Add these tables to the `onRemoteParentDelete` registry.
- PAC-13 supersession graphs: acyclic, one successor, and consistent columns.
- PAC-14 derived counters and cross-column consistency: `ref_count`, version counters, `content_hash`, profile columns.
- PAC-15 apply preconditions: no apply while the twin collapse is failed, and treat backup import or restore as a rebind.

**Typed merge rules for T12344** (the detail is in the inventory's §3.6.6):

- Task status, sessions, goals, sticky notes, releases, PRs, playbook approvals and runs, and service revocation have absorbing states. Leaving one needs an explicit reopen or restore op.
- `pipeline_stage`, memory tier and `plasticity_class` merge by maximum.
- `verification_json` is frozen once a task is done.
- Counters merge by delta, never by plain LWW.
- Grouped columns merge as one unit: status and its timestamps, key and `requires_reauth`, token and expiry.

**Guards weaker than the TypeScript rule** (examples):

- The type-matrix trigger allows epic→subtask and never re-checks children when a parent's type changes.
- T877 has no transition rule, and it allows done with pipeline_stage cancelled.
- The non-containment and child-target triggers ignore `parent_id` changes.
- `tasks_task_dependencies` has FKs only.
- The handoff UNIQUE(session_id) is missing from the live DDL.
- The docs slug and sha256 UNIQUE indexes exist only after a twin-collapse run.
- The global store has no guard triggers.

**Convergence risks.** §3.5 Rule 1 requires that a predicate read only stream-derived state. These validators read other state, so they cannot be ported unchanged:

- Waivers and overrides live in local `.cleo/audit/*.jsonl` files. Move them into `tasks_audit_log`.
- Policy comes from config and environment variables. Pin it in a synced row, or carry it on the op.
- Claim columns are local-only, while the claim-release triggers fire on apply.
- Phases, the id counter and focus live in local-only `tasks_schema_meta`.
- Filesystem-derived deletes of synced registry rows: `projects clean` and doctor repair.
- Release and PR ids are derived from the device's `project_hash`.
- `*_enc` columns are sealed under a per-machine key.
- Typed-gate results are bound to an absolute `projectRoot`.
- Cross-DB existence checks read bare local-only tables.
- Blob bytes do not sync.
- Decay and eviction depend on the wall clock.
- **Guard-set divergence:** `triggerSetHash` (§2.11 §7) hashes triggers only. Extend it to UNIQUE indexes and CHECKs, and create the docs indexes in a migration.

**Gate (build task T12881).**

- **Registry:** `packages/contracts/src/invariants/sync-write-invariants.ts`, beside the central invariants registry.
- **Site tags:** every rejection site on a synced write path carries `// @sync-invariant <id>`, or `none:<reason>`.
- **Detection:** the TypeScript compiler API finds rejection sites in modules that write synced tables or are reachable from `mutate` ops. It also flags silent cascades and counter increments.
- **Registry closure:**
  - Each named trigger or index exists in a freshly migrated store and was created by a migration.
  - Each check function is exported and declares a footprint.
  - No check reads non-synced data unless its policy is pinned.
  - No registered runtime gate is dead code.
- **Ratchet:** a committed site baseline that may only shrink.
- **Self-tests:** 15 fixtures.

**Local bugs found by the inventory:** filed as T12882–T12886. T12886, the missing dependency-cycle guard, is critical.

## 4. The per-write bypass check

### 4.1 What "bypass" means now

The triggers capture every write, so no sync-set change is lost silently. What remains to detect is **provenance**, and the rare **uncaptured** write. Each captured transaction is classified:

| Class | How it is detected | Typical source |
|---|---|---|
| `accessor` | stamped `conn` and `frame` | the sanctioned path |
| `connection` | stamped `conn`, NULL `frame` | a raw SQL site (gate 28) or a Drizzle write on the chokepoint handle outside an accessor frame (gate 28's blind spot) |
| `foreign` | `conn IS NULL` | an older build, Studio's own `DatabaseSync`, `credential-transfer.ts` raw handles, exodus dedicated handles, the `sqlite3` shell |
| `uncaptured` | no capture row at all | triggers missing (a table rebuilt by an older build, triggers dropped while the flag was toggled, writes to `brain_embeddings` outside its accessor) |

### 4.2 What each class does

- `accessor`: nothing.
- `connection` and `foreign`: the ops seal and sync normally, because data is never held back for its provenance, and `via` records the class in the transaction. Per-table and per-day counts go to `_sync_meta.bypass_stats`.
  - `cleo doctor` check `sync_capture` warns on `connection` counts. They are expected to fall with each gate 28 wave.
  - `foreign` counts are informational while an older build is known to run. `_sync_meta` keeps the last `cliVersion` seen by `ReplicaPresence`. Otherwise they are a warning.
- `uncaptured`: `cleo doctor` reports an error. A conflict of kind `uncaptured-write` appears in `cleo cloud conflicts`. The repair is described in §4.4.

### 4.3 Detecting uncaptured writes

1. **Trigger presence.** Checked at every open (compare `sqlite_master`, about 50 µs), again when `PRAGMA data_version` shows a foreign commit, and before every seal.
   - A missing trigger is reinstalled at once.
   - The window it was missing is marked suspect for the affected table: from the last verified time to now.
2. **Count ledger.** `_sync_ledger(tbl, rows)` is maintained by the sealer. It is compared with `SELECT count(*)` at every sync (push or pull) and in `cleo doctor sync`, but not at every open: across about 100 tables of cleocode that costs an estimated 20–50 ms. A mismatch proves an uncaptured insert or delete. `brain_embeddings` is covered only by this check. The comparison is `count(*) + held(tbl)`, where `held` counts rows rewound by a rebase and not replayed (§3.5, R6-3), so a held insert never looks like an uncaptured delete.
3. **Content hash.** `_sync_row_meta.chash` holds the hash of each row's last sealed image. `cleo doctor sync --deep` and the repair (§4.4) scan a suspect table and compare. This catches uncaptured updates that counts cannot see.
4. **Checkpoint manifest.** T12338's uid-keyed manifest hash (Gate D) compares the replayed state with the live state at every checkpoint, so it is the final net.

### 4.4 Repair, following the repair matrix

- **Scope**: one table, or one table and time window.
- **Evidence**: the ledger mismatch or suspect window.
- **Repair class**: automatic and bounded. It emits ops and changes no row data.
- **Operation**: diff the table against `_sync_row_meta` and emit U, I or D ops for rows whose `chash` differs, is missing, or is orphaned. The ops go in a `repair` frame (`via: 'repair'`). Rows whose meta is marked `held = 1` (§3.5) are **skipped** by the repair diff and by the Gate D manifest hash, so a held insert never produces a spurious D (R6-3).
- **Repair capture shape (T12987).** A repair U carries the full after-image of every replicated column and no before-image (only `chash` was kept). In the capture its before slot is JSON `null`, which no trigger writes (a trigger's before is an `enc()` text, a `[localKey, uid]` array, or the secret marker; a SQL NULL is the text `'NULL'`). The sealer accepts a null before slot only inside a `repair` frame and quarantines it anywhere else. An orphan D has an empty image; a natural row's key comes from meta `key_json`. Secret columns are not repaired until `shash` exists (T13211).
- **Baseline (T12987, T13217).** Before the stream starts, a table never baselined cannot tell a pre-sync row from an uncaptured insert; its meta-less rows are baselined (genesis HLC, no op) atomically with the ledger and `baseline:<table>`. `baselineRowMeta` is the single initializer, for T12342's first-enable init too. Once the stream has started (a genesis cut, a segmented transaction, or `undo_enabled`), a meta-less row is journaled as an I in every table, never absorbed silently.
- **Prerequisites**: the triggers are present again, and sealing is idle.
- **Verification**: the ledger equals the count, and a `chash` rescan is clean.
- **Recovery**: the repair ops are unpushed until the next push, so `cleo sync discard-repair <txn>` can drop them.

Command: `cleo doctor sync --repair`.

### 4.5 The test-suite cross-check (R5, CI)

- **Strict mode.** `CLEO_SYNC_STRICT=1` is set for the vitest suite, and every temporary test store has capture on (`sync: 'test'`).
  - A test-only SQL function, `cleo_sync_site()`, is registered only on stamped connections in strict mode. It returns the first non-store frame of `new Error().stack`. In strict mode only, a TEMP trigger on `_sync_capture` records it for every capture (v11.3 removed the TEMP stamp from the production path; strict mode is tests only, so its per-row cost is not on the hot path).
  - A `connection` capture from a site not in gate 28's baseline, or not in the Drizzle list, fails the test with its `file:line`.
  - A `foreign` capture fails unless the test declares that it simulates an older build.
- **Changeset cross-check.**
  - A session is attached to each connection the harness opens, before the first write.
  - At teardown the harness applies the changeset to a `VACUUM INTO` snapshot taken before the test ("expected"). It applies the sealed ops to a second copy through the reference applier ("journal").
  - It compares the two with `fingerprint-store.mjs --mode replay`.
- **Blind spots of the changeset check (M8), and what covers each:**

| Blind spot | Why | Covered by |
|---|---|---|
| sync-set tables without a declared PRIMARY KEY (rowid tables) | the session module ignores them | a Gate test lists such tables; for them, the harness compares `chash` rescans of expected vs journal |
| changes with a NULL PK value | not recorded by sessions | the same `chash` rescan |
| connections opened inside the code under test (Studio's own `DatabaseSync`, `credential-transfer.ts` raw handles, exodus dedicated handles, any `new DatabaseSync` in a module) | the harness never attached a session to them | strict mode's `foreign` failure, plus a ledger check (§4.3) at teardown |
| virtual tables (`brain_embeddings`, vec0) | sessions do not track them | the accessor-level capture test and the count ledger |
| writes made while the triggers were dropped | the changeset sees them but capture doesn't, by design | **migrations:** not emitted; the harness applies the same migration to the expected copy and compares after the `chash` re-baseline, expecting no repair. **Other rewriters and the lineage carry-forward:** `suspect:` marking and the repair diff; the harness expects a repair transaction. |
| attached or TEMP databases | out of the session's scope | not sync-set, so nothing to cover |

- A dedicated older-build simulation writes through a plain `DatabaseSync` and asserts: `foreign` capture, delete+reinsert netting, REPLACE handling with recursion off, and adoption.

### 4.6 Plan to drive gate 28 down

Gate 28's baseline on `origin/main` (`scripts/.lint-no-raw-table-writes-baseline.json`) holds **226 sites in 72 files**. It equals the current lint output, because CI fails when counts fall without a regeneration.

With the v3 class rulings (§0.2: `brain_plasticity_events` and `brain_weight_history` become portable-personal, adding 9 sites to the sync class):

| Class | Sites |
|---|---|
| sync-class | **148 in 53 files** |
| local-only, live | 47 (41 project, 6 global) |
| local-only, frozen-legacy twins | 4 |
| derived | 27 |

**S0: exemptions per (file, table), each with a reason (M7).** This is a lint-only change.
- `EXEMPT` becomes a map keyed by `file` → `table` → `{count, reason}`. It is never keyed by class or by file alone, so a file that later adds a write to a sync-class table fails.
- Derived entries (27) carry the reason "FTS5 or vec0 maintenance, rebuilt, never synced". Frozen entries (4) carry "dropped by T12535; no reader".
- Local-only entries (47) carry per-table reasons, for example: `__drizzle_migrations` (migration journal), `*_schema_meta` (schema stamps), `_writer_leases` (lease), `deriver_queue` and `background_jobs` (queues), `_nexus_meta` and `_nexus_parse_cache` (graph state).
- An entry expires, and the gate fails, when its table's class becomes portable.
- The baseline drops from 226 to **148**.
- The same S0 PR updates **AGENTS.md row 28**: the baseline count, the exemption map, and the rule "a sync-class write needs an accessor, never an exemption, except staged-snapshot sites".
- A report-only counter lists Drizzle builder writes to sync-set tables outside the sanctioned files. It becomes a ratchet after W1.

**Waves on the 148 sync-class sites:**

| Wave | Files (sync-class sites) | Sites | Hot path? |
|---|---|---|---|
| W1 tasks core | `lifecycle/index.ts` 1, `sentient/propose-tick.ts` 3, `sentient/stage-drift-tick.ts` 2, `doctor/malformed-task-ids.ts` 1, `release/backfill.ts` 1, `release/release-manifest.ts` 1, `store/db-helpers.ts` 1, `store/exodus/recovery.ts` 1 | 11 | **yes** |
| W2 memory | all `memory/*` sync-class sites (brain-stdp 14 with the STDP reclass, brain-lifecycle 13, graph-memory-bridge 7, specialists 6, brain-backfill 5, sleep-consolidation 5, brain-consolidator 4, claude-mem-migration 3, surprisal-tree 3, brain-writer-handlers 2, decision-cross-link 2, brain-page-nodes 2, brain-stub-prune 2, brain-sweep-executor 2, nexus-plasticity 2, retrieval/observe 2, plus 1 each in engine-compat, llm-extraction, observer-reflector, quality-feedback, retrieval/log-retrieval, session-narrative, temporal-supersession, transcript-ingestor); the three Studio `/api/memory/*-store` routes 6; `deriver/deriver.ts` 1; `sessions/session-memory-bridge.ts` 1; `doctor/knowledge.ts` 4; `nexus/tasks-bridge.ts` 1. Also the `legacy-tasks-lineage.ts` suspect-marking helper (§2.3). | 95 | no (memory, STDP, sleep) |
| W3 agents and credentials | `store/credential-transfer.ts` 8, `store/agent-install.ts` 4, `store/agent-doctor.ts` 3, `agents/seed-install.ts` 1, `store/portable-bundle-import.ts` 1, `sentient/ingesters/nexus-ingester.ts` 1, `store/nexus-sqlite.ts` 1 | 19 | no |
| W4 conduit | `conduit/local-transport.ts` 9, `store/conduit-sqlite.ts` 3, `store/migrate-signaldock-to-conduit.ts` 1 | 13 | no |
| W5 playbooks | `playbooks/src/state.ts` 5, `playbooks/src/approval.ts` 2 | 7 | no |
| W6 docs | `docs/supersede.ts` 2, `docs/display-alias.ts` 1 | 3 | no |

11 + 95 + 19 + 13 + 7 + 3 = 148.

**W3 staged-snapshot sites are marked per site (M7).** `credential-transfer.ts` writes both live stores and STAGED backup snapshots, which it reaches through FILE PATHS.
- Each of its 8 sites is classified individually in the W3 PR: live-store writes move behind the credentials accessor; snapshot writes stay raw.
- Each staged site carries an inline marker (`// gate-28: staged-snapshot`, with the function name) and a per-site exemption entry keyed by (file, table, function). An exemption covering the whole file is not allowed.
- The snapshot handles open with `sync: 'off'` (§1.5).

End state: zero sync-class raw sites; `--strict` passes for the sync class; the Drizzle counter at zero for the sync set; production `connection` provenance at zero.

Current count by file (baseline JSON × registry, with the §0.2 reclass applied). Columns: total sites, sync-class sites, sites per table (class in brackets):

| File | Total | Sync | Tables |
|---|---|---|---|
| `core/src/memory/brain-search.ts` | 20 | 0 | brain_decisions_fts=5[derived] brain_learnings_fts=5[derived] brain_observations_fts=5[derived] brain_patterns_fts=5[derived] |
| `core/src/memory/brain-stdp.ts` | 14 | 14 | brain_modulators=1[pers] brain_page_edges=5[pers] brain_plasticity_events=3[pers*] brain_retrieval_log=1[pers] brain_weight_history=4[pers*] |
| `core/src/memory/brain-lifecycle.ts` | 13 | 13 | brain_consolidation_events=1[pers] brain_learnings=2[pers] brain_observations=4[pers] brain_page_edges=2[pers] brain_promotion_log=4[pers] |
| `core/src/conduit/local-transport.ts` | 9 | 9 | conduit_conversations=1[proj] conduit_messages=3[proj] conduit_topic_messages=1[proj] conduit_topic_subscriptions=2[proj] conduit_topics=2[proj] |
| `core/src/nexus/analyze-orchestrator.ts` | 8 | 0 | _nexus_meta=4[local] _nexus_parse_cache=3[local] nexus_symbols_fts=1[derived] |
| `core/src/store/credential-transfer.ts` | 8 | 8 | agent_registry_agents=3[g:pers] service_connections=2[g:secret] tasks_agent_credentials=3[secret] |
| `core/src/memory/graph-memory-bridge.ts` | 7 | 7 | brain_page_edges=5[pers] brain_page_nodes=2[pers] |
| `core/src/store/nexus-sqlite.ts` | 7 | 1 | nexus_relation_weights=1[pers] nexus_schema_meta=1[g:local] nexus_symbols_fts=5[derived] |
| `core/src/doctor/knowledge.ts` | 6 | 4 | _nexus_meta=2[local] brain_decisions=4[pp/g:pers] |
| `core/src/memory/specialists.ts` | 6 | 6 | brain_decisions=1[pp/g:pers] brain_learnings=1[pers] brain_observations=2[pers] brain_patterns=2[pers] |
| `core/src/deriver/queue-manager.ts` | 5 | 0 | deriver_queue=5[local] |
| `core/src/memory/brain-backfill.ts` | 5 | 5 | brain_backfill_runs=3[pers] brain_page_nodes=2[pers] |
| `core/src/memory/sleep-consolidation.ts` | 5 | 5 | brain_observations=5[pers] |
| `core/src/store/migration-manager.ts` | 5 | 0 | __drizzle_migrations=5[local] |
| `playbooks/src/state.ts` | 5 | 5 | playbook_approvals=2[proj] playbook_runs=3[proj] |
| `core/src/memory/brain-consolidator.ts` | 4 | 4 | brain_page_edges=2[pers] brain_patterns=2[pers] |
| `core/src/store/agent-install.ts` | 4 | 4 | agent_registry_agent_skills=2[g:pers] agent_registry_agents=2[g:pers] |
| `core/src/store/conduit-sqlite.ts` | 4 | 3 | _conduit_meta=1[local] conduit_project_agent_refs=3[proj] |
| `core/src/memory/claude-mem-migration.ts` | 3 | 3 | brain_decisions=1[pp/g:pers] brain_learnings=1[pers] brain_observations=1[pers] |
| `core/src/memory/decision-cross-link.ts` | 3 | 2 | _nexus_meta=1[local] brain_page_edges=1[pers] brain_page_nodes=1[pers] |
| `core/src/memory/surprisal-tree.ts` | 3 | 3 | brain_memory_trees=2[pers] brain_observations=1[pers] |
| `core/src/nexus/assessment-store.ts` | 3 | 0 | _nexus_meta=3[local] |
| `core/src/nexus/graph-manifest.ts` | 3 | 0 | _nexus_meta=3[local] |
| `core/src/sentient/ingesters/nexus-ingester.ts` | 3 | 1 | nexus_audit_log=1[g:pers] nexus_schema_meta=2[g:local] |
| `core/src/sentient/propose-tick.ts` | 3 | 3 | tasks_task_labels=1[proj] tasks_tasks=2[proj] |
| `core/src/store/agent-doctor.ts` | 3 | 3 | agent_registry_agent_skills=1[g:pers] agent_registry_agents=2[g:pers] |
| `core/src/tasks/backfill-child-projections.ts` | 3 | 0 | task_acceptance_criteria=2[frozen] tasks=1[frozen] |
| `crates/cleo-supervisor/src/lease_handler.rs` | 2 | 0 | _writer_leases=2[local] |
| `core/src/docs/supersede.ts` | 2 | 2 | docs_attachments=2[proj] |
| `core/src/memory/brain-page-nodes.ts` | 2 | 2 | brain_page_edges=1[pers] brain_page_nodes=1[pers] |
| `core/src/memory/brain-stub-prune.ts` | 2 | 2 | brain_observations=2[pers] |
| `core/src/memory/brain-sweep-executor.ts` | 2 | 2 | brain_backfill_runs=1[pers] brain_observations_staging=1[pers] |
| `core/src/memory/brain-writer-handlers.ts` | 2 | 2 | brain_plasticity_events=1[pers*] brain_weight_history=1[pers*] |
| `core/src/memory/nexus-plasticity.ts` | 2 | 2 | nexus_relation_weights=2[pers] |
| `core/src/memory/retrieval/observe.ts` | 2 | 2 | brain_embeddings=2[pers] |
| `core/src/nexus/tasks-bridge.ts` | 2 | 1 | _nexus_meta=1[local] brain_page_edges=1[pers] |
| `core/src/sentient/stage-drift-tick.ts` | 2 | 2 | tasks_task_labels=1[proj] tasks_tasks=1[proj] |
| `core/src/store/background-jobs.ts` | 2 | 0 | background_jobs=2[local] |
| `core/src/store/exodus/recovery.ts` | 2 | 1 | _exodus_database_identity=1[local] tasks_sessions=1[pers] |
| `core/src/store/legacy-tasks-lineage.ts` | 2 | 0 | __drizzle_migrations=2[local] |
| `core/src/store/migrate-signaldock-to-conduit.ts` | 2 | 1 | conduit_messages_fts=1[derived] conduit_project_agent_refs=1[proj] |
| `core/src/store/sqlite.ts` | 2 | 0 | tasks_schema_meta=2[local] |
| `playbooks/src/approval.ts` | 2 | 2 | playbook_approvals=2[proj] |
| `studio/src/routes/api/memory/decision-store/+server.ts` | 2 | 2 | brain_decisions=2[pp/g:pers] |
| `studio/src/routes/api/memory/learning-store/+server.ts` | 2 | 2 | brain_learnings=2[pers] |
| `studio/src/routes/api/memory/pattern-store/+server.ts` | 2 | 2 | brain_patterns=2[pers] |
| `cleo/src/cli/commands/doctor.ts` | 1 | 0 | tasks=1[frozen] |
| `core/src/agents/seed-install.ts` | 1 | 1 | agent_registry_agents=1[g:pers] |
| `core/src/deriver/deriver.ts` | 1 | 1 | brain_observations=1[pers] |
| `core/src/deriver/enqueue.ts` | 1 | 0 | deriver_queue=1[local] |
| `core/src/docs/display-alias.ts` | 1 | 1 | docs_attachments=1[proj] |
| `core/src/doctor/malformed-task-ids.ts` | 1 | 1 | tasks_tasks=1[proj] |
| `core/src/lifecycle/index.ts` | 1 | 1 | tasks_tasks=1[proj] |
| `core/src/llm/catalog-seeder.ts` | 1 | 0 | __catalog_meta=1[g:local] |
| `core/src/memory/engine-compat.ts` | 1 | 1 | brain_decisions=1[pp/g:pers] |
| `core/src/memory/llm-extraction.ts` | 1 | 1 | brain_decisions=1[pp/g:pers] |
| `core/src/memory/observer-reflector.ts` | 1 | 1 | brain_observations=1[pers] |
| `core/src/memory/quality-feedback.ts` | 1 | 1 | brain_usage_log=1[pers] |
| `core/src/memory/retrieval/log-retrieval.ts` | 1 | 1 | brain_retrieval_log=1[pers] |
| `core/src/memory/session-narrative.ts` | 1 | 1 | session_narrative=1[pers] |
| `core/src/memory/temporal-supersession.ts` | 1 | 1 | brain_page_edges=1[pers] |
| `core/src/memory/transcript-ingestor.ts` | 1 | 1 | brain_transcript_events=1[pers] |
| `core/src/release/backfill.ts` | 1 | 1 | audit_log=1[proj] |
| `core/src/release/release-manifest.ts` | 1 | 1 | tasks_task_commits=1[proj] |
| `core/src/sessions/session-memory-bridge.ts` | 1 | 1 | brain_task_observations=1[pers] |
| `core/src/store/agent-registry-store.ts` | 1 | 0 | _agent_registry_meta=1[g:local] |
| `core/src/store/db-helpers.ts` | 1 | 1 | tasks_sessions=1[pers] |
| `core/src/store/exodus/migrate.ts` | 1 | 0 | tasks_schema_meta=1[local] |
| `core/src/store/memory-sqlite.ts` | 1 | 0 | brain_schema_meta=1[local] |
| `core/src/store/portable-bundle-import.ts` | 1 | 1 | nexus_project_registry=1[g:pers] |
| `core/src/store/snapshot-gate.ts` | 1 | 0 | tasks_schema_meta=1[local] |
| `core/src/telemetry/sqlite.ts` | 1 | 0 | telemetry_schema_meta=1[g:local] |

`[pers*]`: reclassified portable-personal by cleo-dev in the v2 review (§0.2); the registry PR is pending.

## 5. Slices and flags

### 5.1 Flags

| Flag | Meaning |
|---|---|
| `sync.capture` | Triggers and stamp installed. Store-level, persisted in `_sync_meta`. |
| `sync.seal` | The sealer runs. |
| `sync.push` | Segments are built and pushed. |
| `sync.pull` | Pull and stage run. Apply is T12344's own flag. |
| `sync.strict` | Bypass warnings become errors outside CI. |

- Every flag is OFF by default.
- Flags are set by `cleo sync enable <flag>`, which checks prerequisites.
- `CLEO_SYNC_<FLAG>=0` stops that behaviour in the process. It never installs or drops triggers (§2.3, M3) and never turns a flag on.
- A flag is enabled for general release only when its Gate B replay passes on **cleocode, llmtxt and claude-todo**.
- **cleocode safety baseline:** the journal count reported by `cleo doctor migrations` (T12796) on the live store. It was 116 on 2026-09-29 (cleo 9.24, after T12736), and it is read fresh at the start of every Gate B run on cleocode, never hard-coded (§2.3a rule 2).
- claude-todo's store is on the migration share: `/Volumes/Migration/Migration-2026-09/03-Projects-active/claude-todo/.cleo/cleo.db`. It has a legacy schema, so exodus migrates it.
  - **Never open the share copy directly.** Every Gate B run copies it to scratch first and runs exodus, capture and replay on the copy, opened with `sync: 'test'`.
  - **Copy safeguards (T12987, 2026-10-05).** Before copying, check for `-wal`/`-shm` sidecars and copy all three together; stop if a sidecar was modified recently (something has the store open). Record each file's size, mtime and sha256 before and after the copy, and again after the run, and require them unchanged. Never open the share path with SQLite or CLEO. The 2026-10-05 run: `cleo.db` 16,846,848 B, sha256 `0b9a5d87bd41b29d4bec5e33cfceeb22497ed661a2bceaae3639183c86756509`; `-wal` 0 B; `-shm` 32,768 B (last modified 2026-09-24); unchanged before, after the copy and after the run.
  - **Opening the copy.** The copy is opened the way the CLI opens a project (canonical open plus the tasks-family open). Its rows live in the bare legacy family (5,330 tasks in `tasks`, `tasks_tasks` empty, a bare `release_manifests`), and no legacy file sits beside it, so exodus-on-open does not fire: the harness reconciles first, as `cleo doctor superseded-store --reconcile` does. Without that step Gate A fails on the unclassified bare `release_manifests`. The code has no `sync: 'test'` open mode yet; the harness seals as a fixed scratch replica, and nothing can push before S4.
  - **S3d Gate B result (2026-10-05, `scripts/sync-gate-b.mjs`):** claude-todo 5,332 tasks, 12 ops, 5 incremental, replay from genesis and incremental PASS; llmtxt (CLI snapshot) 851 tasks, 12 ops, PASS. cleocode pending.
  - Baseline (scratch copy, 2026-09-28): 5,330 tasks, 157 tables, 21,227 project rows, 7,364 personal rows, 19,031 local-only rows. That was under the v2 classes; the STDP reclass moves those tables' rows from local-only to personal.
  - It is the only release store that goes through exodus before capture. Its runs therefore also exercise the exodus allowance, the strict timestamp migration on legacy formats, and T12341's fill on a freshly migrated store.
  - `/Volumes/Migration` is an external volume whose `st_dev` changes across remounts. This is one reason binding no longer uses `st_dev` (§1.5).

### 5.2 Ordered slices

**Dependency gate (H5).** T12341 is not on `origin/main`, and its spec is still FIX-FIRST. S0, S1 and the registry reclass PR do not depend on it. **S2 and every later slice need T12341 merged**: uid and `birth_fp` columns, `ROW_IDENTITY`, the TEMP fill, `rekeyRowUid`, and the graveyard. If T12341's final shape changes the identity columns, the K and fill-patch triggers (§2.3) follow it.

**Round-9 gating (cleo-dev, APPROVE-WITH-CONDITIONS on v10).**
- **S2 = C2 (T12819) + D4 (T12827).**
- **S3 to S5** need D1 to D3 (T12825, T12826) with their tests.
- **D5 and D6 (T12828) must land before S4 and S5.**
- Still required: the §3.5 test plan, the 7-day benchmark, S2's undo bytes-per-day estimate, and T12813–T12815 and T12819–T12821 implemented as specified.
- T12343 additionally depends on T12825–T12828.

**Round-8 gating (cleo-dev, APPROVE-WITH-CONDITIONS on v9).**
- **C2 (T12819) must be in S2 before S2 merges**: the flag-table migration, live-text verification, the lint and the Gate test.
- **S3 to S5** need: the §3.5 tests; the 7-day benchmark, with large transactions reported separately; S2's undo bytes-per-day estimate; T12813–T12815 implemented as specified; and C1 (T12820) and C3 (T12821) as specified in v10.
- T12343 additionally depends on T12819–T12821.

**Round-7 gating (cleo-dev, FIX-FIRST on v8).**
- S2 may proceed: R6-6 is fixed. S2 does **not** write undo (shadow mode, R7-4), and it includes the trigger classification Gate test and the owned-trigger `WHEN NOT EXISTS` migration (R7-1).
- **Approval requires R7-1, R7-2 and R7-3(a)(b) specified, with their tests** (§3.5 test plan).
- **R7-4 to R7-7 (T12815) must land before S3 and S5.** T12813 and T12814 gate S3, S4 and S5.
- T12343 additionally depends on T12813–T12815.

**Round-6 gating (cleo-dev, FIX-FIRST on v7).**
- **S2 may proceed once T12809 (R6-6, one bracket per migration file) is fixed.** Its other prerequisites stand. S2 must now also create `_sync_undo` in the capture triggers and measure its size and write cost.
- **S3, S4 and S5 also need T12807, T12808 and T12810**, and must pass the §3.5 test plan, including the 7-day backlog benchmark.
- T12343 additionally depends on T12807–T12810.

**Round-5 gating (cleo-dev, FIX-FIRST on v6.1).**
- **Approval requires R5-1 (T12794), R5-2 (T12795) and R5-3 (T12796) fixed in the text, with the tests above.** S2 is blocked on T12795 and T12796 (migration runner), and S3, S4 and S5 on T12794.
- **R5-4 to R5-8 (T12797) must land before S3 and S4.** S2 includes the tombstone-growth measurement of R5-5.
- T12343 additionally depends on T12794–T12797.

**Round-4 gating (cleo-dev, FIX-FIRST on v5).**
- **S2 also needs T12781, T12785 and T12786**, and cleo-dev's T12787 fix plus the extended REPLACE audit before `recursive_triggers` is turned on.
- **S3, S4 and S5 also need T12782, T12783 and T12784.**
- T12343 additionally depends on T12781–T12786.

**Round-3 gating (cleo-dev, APPROVE-WITH-CONDITIONS on v4).**
- **S2 is also blocked on T12774 (A) and T12775 (B).**
- **S3 and S5 also need T12778 and T12779** (intent closure and stored-value intents).
- **S4 is also blocked on T12776 (C) and T12777 (D)**, and on the server and contract change of §2.11 §9 (`txnDeltas`, `segment/v3`, `checkpoint/v3`).
- T12780 (H, I) is design-level: the genesis cut lands with S4, and the fallback applies only if S2's Gate B fails.
- T12343 additionally depends on T12774–T12780.

**Round-2 gating (cleo-dev, APPROVE-WITH-CONDITIONS on v3).**
- S0 and S1 may proceed now.
- **S2 needs T12759 (N3), T12760 (N4) and T12761 (N5) fixed**, plus T12765 (N9, the REPLACE audit) before recursion is turned on, and T12766 (N10, N11).
- **S3, S4 and S5 may not merge until the §3.3 intent design (T12757, with T12751) and the §2.11 replay tallies (T12758, with T12752) are implemented as specified in v4.**
- **S4 is also gated on T12344 and T12338**, because the reconcile needs both (T12763), and on T12753, T12762 and T12764.
- T12343 depends on T12751–T12755 and T12757–T12766.

| # | Slice | Flag | Acceptance tests | Gate that turns the flag on |
|---|---|---|---|---|
| S0 | gate 28 exemptions per (file, table), AGENTS.md row 28, Drizzle counter; registry reclass PR for the §0.2 tables | none | lint self-test (entry expires on reclassification; per-(file, table) keying; baseline 226 → 148); Gate A pins the new classes | CI green |
| S1 | HLC library, clock table, replica binding (N5 birthtime rule) and device registry (N6 path, advisory), rebind detection with the server-authoritative rollback rule (T12342) | none | tick and receive rules; overflow; per-replica FIFO skew hold; restart persistence; two-process serialization; rebind on copy, `VACUUM INTO`, restore to a new file, worktree copy, **`.backup()` into the same inode (hwm)**, store from another device; no rebind on same-fs rename or on remount of an external volume (`st_dev` change); `hlc.ts` never parses a uid | unit and store tests |
| S2 | capture triggers (I/U/D/K/fill-patch with live-row identity), refs at capture, stamp, frames and `_sync_frame` with GC, REPLACE → UPSERT audit then `recursive_triggers`, structural safety incl. referenced tables and the released-binary Gate B run, shadow mode (T12343); **needs T12341, T12759, T12760, T12761, T12765, T12766** | `sync.capture` | one capture per mutation in the same transaction (R4); claim-lease and identity-fill updates capture nothing; K captured on `rekeyRowUid` and cascades; non-NULL uid under both trigger orders; refs captured as uids; value fuzz incl. `-0.0` and ±Inf; 60+ column tables (json chunking); trigger audit with recursion on; stale ctx after auto-rollback → `connection`; **H4 tests** (DROP COLUMN, RENAME, missing `_sync_capture`, exodus, twin collapse, bundle import, partial restore, lineage carry-forward → suspect); kill switch leaves triggers | Gate B **capture replay** on the three stores (scratch copies, `sync: 'test'`); p95 within budget |
| S3 | sealer (two-phase and queue-bound; netting incl. K and N8 clear-and-refill, intent subtraction, fill and relink step 0, HLC, row meta incl. K migration, tombstones, ledger, counters `$inc`, canonical timestamps on the wire, strict one-time migration) (T12342 + T12343) | `sync.seal` | every §2.4 row; ambiguous timestamps refused and flagged; `tasks_tasks.updated_at` untouched by migration or seal; K moves row meta; `bfp` on every minted op; secret columns absent from `chash`, `shash` stripped from bundles | Gate B replay from genesis and incremental on the three stores (with `--canon-timestamps`), through the reference applier or T12344 |
| S4 | segments, transaction signatures, secrets (crypto in phase A), persist-before-push with hwm and `sent` flags, marker on send, push and retry, rebind reconcile with the three-way rule, and retire (T12343); **needs T12758 and the server change merged, T12344, T12338, T12763** | `sync.push` | size caps and split rule; retry duplicate; crash injection; marker before first persist; no secret in any project plaintext; a copy never sends inherited rows and reconciles by diff with field HLCs from row meta; retire transaction honoured by GC and `remintAuthority` | Gate B through the staging relay; ADR-095 Stage B exit gate; §2.11 checkpoint with concurrent same-uid inserts, double deletes, D losing to U and deferred ops accepted, and a tampered tally refused by an endorsing device |
| S5 | pull, verify, transaction signatures, schema refusal, per-replica skew FIFO, staging (parts released only when complete), cursor and trust, marker on receive, queue-bound synchronous apply frame with the thenable guard, apply intents and field subtraction (T12343 → T12344); **needs T12757** | `sync.pull` | own echo skipped; interleaved async writer during an apply keeps its capture (H1 regression test); re-mint inside apply is sealed; parts applied in order | Gate B two-replica replay plus Gate C with T12344's apply |
| S6 | strict mode in CI, changeset harness with the blind-spot compensations, doctor `sync_capture`, `sync_triggers`, `--repair`, waves W1–W6 | `sync.strict` | R5 green; the §4.5 blind-spot table covered; repair round trip | CI; each wave gated by S2's capture replay |

### 5.3 Hot paths (advance notice to cleo-dev)

- **S2** changes add, update, complete, start and end:
  - triggers fire inside the user's transaction;
  - `accessor.transaction()` inserts a `_sync_frame` row and writes the TEMP ctx after `BEGIN IMMEDIATE`;
  - chokepoint connections run `PRAGMA recursive_triggers = ON` (a behaviour change for every existing trigger, hence the audit);
  - the open pass verifies triggers.

  Nothing changes in the #1698 CAS SQL, the #1701 claim CAS or #1706's `insertNewTask`. Claim columns are excluded from the triggers, and `tasks_tasks.updated_at` is never rewritten by sync.
- **The migration runner** (in the open path) gains the trigger drop and reinstall around migrations (H4).
- **S6 wave W1** changes the writers of `tasks_tasks`, labels, `tasks_sessions` and `audit_log`.
- **S3 is off the hot path.** Sealing is lazy. The one-time timestamp migration runs once per store at open, under the cold-open lease.

### 5.4 Risks carried by the slices

- **K1:** an older build or a legacy lineage carry-forward writes while the triggers are dropped. Detected by §4.3 and the `suspect:` marking; repaired by §4.4.
- **K2:** `peer_scope` routing is still pending in the registry.
- **K3:** 9.2x exodus `inspectEffects` aborts on capture side effects (safely). This build allows them.
- **K4:** T12341 is not merged and still FIX-FIRST. S2 and later wait for it (H5).
- **K5:** the STDP event tables (14M+ lifetime inserts) dominate op volume. Retention is Q15.
- **K6:** claude-todo is a legacy store that exodus must migrate before capture. Scratch copies only.
- **K7:** §2.11 needs a coordinated server and contract change. S4 is blocked until it lands.
- **K8:** `recursive_triggers = ON` fires DELETE triggers on same-PK REPLACE (verified: it would clear live claims). The REPLACE → UPSERT audit (T12765) must land first.
- **K9:** the device registry is advisory. Losing it does not rebind (v4), and a restore that rolls it back is caught by the server-authoritative rule (§1.5, N6).
- **K10:** reconcile repair transactions break per-replica HLC monotonicity by design (N7). T12344 must not rely on it for `via: 'rebind'`.
- **K11:** the intent subtraction depends on T12344 using only the §3.2 write API inside apply. A raw write inside `fnSync` is sealed as a local residual. That is safe, but it re-emits the value, so a lint rule forbids raw SQL in T12344's apply module.
- **K12:** tally replay (§2.11) costs one scratch replay per checkpoint authored or endorsed.

## 6. Performance

**S2 measured budget (v11.3 (a)):** p95 at most **3.5 ms for insert-heavy transactions** (a task add with its criteria: measured 1.53–2.67 ms, median 2.02, with capture on) and at most **2 ms for updates and session touches** (measured 0.07–0.12 ms); bulk rewrites at most +30%. The figures below were the pre-S2 estimates.

**Per write.**
- One capture INSERT and the `enc()` and JSON work over changed (U) or non-NULL (I, D) columns; one labelling UPDATE per frame, not per row (v11.3). Strict mode records the site (tests only). Measured: ≈ 18 µs per captured `tasks_tasks` insert (11 µs trigger and row, 7 µs image).
- References captured as uids add one indexed lookup per reference column per write. Most rows have 0–2.
- `recursive_triggers` adds cost only where REPLACE displaces rows.
- Estimate: 10–35 µs per captured row. A typical `cleo update` changes 2–6 sync-set rows, which is roughly +0.05–0.2 ms.
- **Frame row (N10):** one `_sync_frame` INSERT per `accessor.transaction()`, including read-only ones: about 2–5 µs and one dirty page. Read-only transactions delete their own row before COMMIT, so no rows accumulate; the WAL write remains. The per-transaction frame cost counts toward the 2 ms p95 budget.
- **Apply intents:** one `_sync_apply_intent` row per applied field, only in apply frames, deleted at seal.
- **Undo log (§3.5, R6-2, R7-4, R7-6):** while push is on (from the genesis cut), every captured row change of a locally authored, pushed kind (`write`, `repair`, `import`, `exodus`, `remint`, `rekey`, reconcile `repair`; D1) also writes one `_sync_undo` row: full row for I and D, changed columns only for U (v11.3 (b)); about +5–15 µs. There is no undo in shadow mode, apply- and rebase-frame undo is deleted at frame finish (D1), and append-only tables keep only rk and uid. `UNDO_BUDGET_BYTES` warns at 80%. At 100% the replica keeps writing undo and rebinds at the next connectivity (D5). It is dropped as soon as the transaction's own echo applies (normally at the next pull), so it holds only the unsequenced backlog. S2 measures it.

**Sealing** is off the hot path: about 3 writes per op, roughly 20–40k ops/s. A K op adds a row-meta move. Phase A's secret crypto runs only for rows with secret columns.

**Checkpoint tallies (§2.11):** one scratch replay of the window per checkpoint authored or endorsed, proportional to the window's ops, not to the store size, because it starts from the parent checkpoint's bundle.

**Row meta.** About 124.6k rows for cleocode under the v2 classes, roughly 20–25 MB (about 2%). With the §0.2 reclass it grows by the STDP event rows the store still holds, which is to be measured on scratch copies.

**STDP event tables** (`brain_plasticity_events`, `brain_weight_history`, now portable-personal):
- append-only, with 14M+ lifetime inserts;
- each insert is one capture and one op, and compaction cannot merge distinct inserts;
- if the lifetime average holds, they dominate capture cost and home-stream volume.

S2 measures their daily rate on cleocode before `sync.capture` goes on. Q15 decides retention. Row meta for append-only event tables can be skipped (`ROW_IDENTITY` flag `appendOnly`: no `fhlc` or `chash`, tombstones only if deletes replicate), which keeps meta growth at zero per event.

**Outbox.**
- Captures live until the next seal.
- Ops live until they are pushed and covered by a verified checkpoint, plus a 7-day tail.
- Size is roughly (ops/day) × (0.15–1 KB) × (days between checkpoints + 7).
- Inherited rows on a rebound replica are deleted after the reconcile commits.

**Genesis** is a checkpoint, not 124k insert ops.

**Derived tables** (996k rows in cleocode) cost nothing.

## 7. Open questions for cleo-dev

Options are listed with the recommendation first.

Decided:
- **Q1:** triggers. The ADR-095 wording is amended to "cross-check".
- **Q3:** side table.
- **Q4:** lazy sealing.
- **Q9, Q11:** `brain_patterns`, `token_usage` and the STDP tables are portable-personal.
- **Q15 (a), round 2.**
  - Local pruning is replicated as one range op per table, `{t, o: 'P', before}`, keyed on a replicated column (canonical `created_at`, else the row HLC).
  - Its effect is counted in the manifest's `pruned` (§2.11).
  - A late insert older than a prune's cutoff that arrives after the prune is a **merge-decided void** (listed in `voided`, never re-emitted, NEW-3).
  - There is no tombstone per event.
- **Q19 = (b), round 3.** Exact `TxnRef` pending with per-transaction declared deltas in segment metadata, soft cross-stream and cross-project refs, and no voiding by age (§2.11).
- **Q20 = (a), round 3.** The self-check replays from the server-downloaded bundle and segments, and unendorsed checkpoints stay visibly flagged (§2.11 §8).
- **Q16: superseded by Q19 = (b)** (round 3). Exact TxnRef pending, no aggregate adjustments (§2.11).
- **Q17 (a), round 2.** The device pinned to a replica, or a project owner or admin, may retire it. `cleo doctor` also prompts with a list of retirement candidates silent for 90 days.
- **Q18 (a), round 2, as a hard requirement.** Never split below the 256 MiB blob cap. T12344 applies a split transaction only when parts 1..n are all staged (§3.2).
- **H1** is resolved by field-level apply intents plus a queue-bound synchronous apply frame (§3.2, §3.3). This replaces v3's image matching.

Still open:

- **Q5 Gate 28 non-sync sites.** Resolved in form by M7. Open only if cleo-dev wants local-only writers moved behind accessors anyway: **(a, recommended)** exemptions per (file, table), or (b) move them too.
- **Q6 Skew bound.** **(a, recommended)** 5 min with the per-replica FIFO hold; (b) 60 s; (c) accept and clamp.
- **Q7 Transaction signatures.** **(a, recommended)** Ed25519 per transaction plus the segment signature; (b) the segment signature only.
- **Q8 Flag scope.** **(a, recommended)** store-level persisted flags, with env variables that only stop seal and push; (b) process-level.
- **Q10 Timestamps.** **(a, recommended)** a strict one-time migration (excluding the CAS token) plus canonicalization on the wire only; (b) canonicalization on the wire only.
- **Q12 Compression.** **(a, recommended)** `deflate-raw`; (b) zstd.
- **Q13 CAS and remote apply.** **(a, recommended)** remote apply writes `updatedAt` verbatim; (b) it bumps `updatedAt` locally.
- **Q14 Hot-path budget.** Ruled in v11.3 (a): ≤ 3.5 ms p95 for insert-heavy transactions, ≤ 2 ms for updates and session touches, measured in shadow mode.
## Changelog

- v11.7 (2026-10-12): T13298. §2.11 §7 `triggerSetHash` hashes only the owned triggers (`OWNED_TRIGGERS`), not every non-capture trigger: device-local maintenance triggers such as the `t12535_*` freeze triggers no longer change the replay pin. This matches the code shipped in #1972 (aa68b9923).
- v11.6 (2026-10-10): T13405. §3 receive gains the counter-key re-mint after a settled uid collision: the origin re-mints the loser's key in a second `rekey` frame, receivers fold the rename into the held insert, and the server becomes the authority once a project syncs to the cloud (T13404).
- v11.5 (2026-10-09): T13366. §1.5 Retirement gains a trust rule: a receiver honours a `retire` only after the server confirms it (the emitter's E31 answer, or the home replica listing's `retiredAt` and `successor`). The server's `not-pinned-or-owner` check is what bounds which device may retire which replica.
- v11.4 (2026-10-09): T13311. `_sync_cap_<t>_k` no longer fires on a `birth_fp` going NULL → value: that is the TEMP fill's second UPDATE, which `_f` patches into the I. With row uids on by default (T13305) the v11.3 condition captured a stray K on every minted insert. Decision recorded in §2.3: no stray K, rather than a sealer-dropped K.
- v11.3 (2026-09-30): records cleo-dev's S2 rulings (§0.13). (a) Per-frame labels replace the per-capture TEMP stamp trigger; I and D images omit NULL columns; hot-path budget ≤ 3.5 ms p95 for insert-heavy transactions and ≤ 2 ms for updates, from the measured result. (b) D5 amendment: an update's undo holds only the changed columns. (c) Unframed captures are singleton transactions flagged `unframed`; `min_writer_version` is written when capture turns on and enforced at open. Also: the open-time identity fill is an uncaptured derived rewrite with suspect marking plus a re-mint K for cleared identities, and guards are suspended only to rewind or undo (T12344 AC5). N1 and N2 were already fixed in v11.1.

- v11.2 (2026-09-30): adds §3.6, a summary of the T12859 write-validator inventory (spec doc `t12859-sync-write-validator-inventory`). It gives the class counts, the PAC-01..15 post-apply families for T12344, the typed-merge-rule groups, the weaker guards, the convergence risks (including guard-set divergence for `triggerSetHash`), and the gate (T12881). It changes no rule in §1–§5.
- v11.1 (2026-09-29): v11 APPROVED in round 10. Nits: N1, the §3.5 "Undo bounded" test now says `seq` order with the fast path per echo; N2, the §6 undo line now names every locally authored, pushed kind.
- v11 (2026-09-29): answers cleo-dev round 9 (map in §0.12, tasks T12825–T12828).
  - The flag table is created at open-pass step 0.
  - D1: undo deleted only for apply and rebase.
  - D2: changed-columns-only U rewind and replay.
  - D3: deterministic sentinel, merged-state lookup, report-only pre-sync.
  - D4: forward-only trigger lint, released files never edited, `frozen-guard` class.
  - D5: warn, keep undo, rebind at connectivity, retire the old id.
  - D6: drain in `seq` order; per-stream undo drop.
- v10 (2026-09-29): answers cleo-dev round 8 (map in §0.11, tasks T12819–T12821).
  - C2: the flag table renamed `cleo_trigger_suspend`, created with the WHEN-clause migration, schema-owned and never dropped; live trigger text verified and repaired; migration lint; rebuild Gate test.
  - C1: the non-rewindable mode dropped; undo tied to push and the genesis cut; budget warning, then forced rebind and reconcile; fast-path drain on S5's first pull.
  - C3: the `fk_excluded` state; `fk_orphans` repair never deletes; long-hold report.
  - C4: suspension test assertions; frame-validated stamp deletes non-write undo.
- v9 (2026-09-29): answers cleo-dev round 7 (map in §0.10, tasks T12813–T12815). §3.5 Rules 2–4 rewritten:
  - flag-row trigger suspension (`_sync_suspend`, `WHEN NOT EXISTS`), with trigger classification and an owned-trigger migration;
  - local-only columns never in undo, never written by rewind or replay, restored from a current snapshot;
  - FK discipline: orphan snapshot and explicit ROLLBACK, the NEW-4 predicate in replay, `defer_foreign_keys` per page, `foreign_keys = 1` asserted;
  - undo only while push and pull are on, capped, with non-write undo dropped and append-only undo trimmed;
  - pages on transaction boundaries, a bounded fast-path index, a Gate test for guard footprints.

  Also: piggybacked watermarks (no ping-pong), deterministic `upgradeOp`, the §1.6 comment fix, and the new tests.
- v8 (2026-09-29): answers cleo-dev round 6 (map in §0.9, tasks T12807–T12810). §3.5 is rewritten:
  - a local undo log with full images;
  - a footprint-scoped, paged rebase with an own-echo fast path;
  - append-only tables never rewound;
  - per-phase trigger modes, so claims survive;
  - `held` rows accounted for and surfaced as `E_SYNC_HELD`;
  - per-field LWW in replay;
  - an expanded test plan and a 7-day backlog benchmark.

  Also: R6-6 one migration bracket per file, including ON UPDATE CASCADE; fold horizon from receive watermarks, deterministic per checkpoint, with stall and returning-replica rules; mixed-version replay; `cannot-verify` never endorses; the LOWs.
- v7 (2026-09-29): answers cleo-dev round 5 (map in §0.8, tasks T12794–T12797).
  - R5-1: stream-derived conflict decisions, own echoes applied, rebase and compensating frames, 3-replica test plan (new §3.5).
  - R5-2: rowid-independent violation multiset.
  - R5-3: a journal-identical migration loop with parity tests and a pinned drizzle version; the live journal count comes from `cleo doctor migrations`, not the literal 116.
  - R5-4: FK OFF only for rebuild batches; DML scope.
  - R5-5: tombstone size corrected, S2 measurement, horizon fold.
  - R5-6: bundles carry unresolved entries; TxnRef dedupe.
  - R5-7: sync-set children only; `onRemoteParentDelete` policy.
  - R5-8: `replayPin` over the whole ordered journal, transition points, verdict classes, literal-safe tokenizer.
  - R5-9: wording on holds and soft refs.
- v6.1 (2026-09-29): safety notes use the live cleocode journal count **116** (cleo 9.24, after T12736) as the expected value (§2.3a rule 2, §5.1).
- v6 (2026-09-29): answers cleo-dev round 4 (FIX-FIRST on v5; map in §0.7, tasks T12781–T12786).
  - NEW-1: FK check against a pre-DDL violation snapshot, scoped.
  - NEW-2: never-seen vs tombstoned references; minimal tombstones kept forever; dependency-scoped holds.
  - NEW-3: no fresh-HLC re-emission; revival by original op, with original HLCs.
  - NEW-4: children-in-transaction intents only; a parent with live children becomes a conflict; cascade accounting.
  - NEW-5: statement-loop migration runner; the bracket owns BUSY; exodus one bracket per stage.
  - NEW-6: FK restore in `finally`, plus handle assertions.
  - NEW-7: FK check scoped and conditional; the REPLACE audit covers FK-CASCADE parents (T12787).
  - NEW-8: repair before re-baseline, a determinism lint, generated touch sets.
  - NEW-9: `replayPin`.
  - Contradictions fixed: `segment/v3`, Q15/Q16, §4.5, inbox statuses and retention, `folded`, part order.
  - LOW: `_sync_soft_ref`, and a per-stream genesis cut.
- v5 (2026-09-29): answers cleo-dev round 3 (APPROVE-WITH-CONDITIONS on v4; map in §0.6, tasks T12774–T12780).
  - Required single-transaction suspension brackets; lease and suspect marking for staged rewriters.
  - A: `foreign_keys=OFF` before BEGIN, plus `foreign_key_check`.
  - B: no emission of migration backfills (chash re-baselined); `total_changes()` suspect marking for other rewriters.
  - C: exact TxnRef pending, soft cross-stream refs, no voiding by time, revivable void with author re-emit.
  - D: guard refusal becomes void plus a conflict; replay pinned to the guard set; `cannot-verify` instead of tamper; T12341 handoff-guard note.
  - E: FK-action closure intents and child-first ordering.
  - F: `RETURNING`-based intents.
  - G: `remapPending`.
  - H: seal-time ref-translation fallback.
  - I: genesis cut.
  - Wording fixes in §2.9 and §1.5.
  - Q19 = (b) and Q20 = (a) decided; §2.11 reworked around Q19b.
- v4 (2026-09-29): answers cleo-dev round 2 (APPROVE-WITH-CONDITIONS on v3; map in §0.5, tasks T12757–T12766).
  - H1 enforcement: queue-bound synchronous frames, a thenable guard, crypto before the frame.
  - L4 `$r` Inf parsing.
  - N1: field-level apply intents replace image matching.
  - N2: tallies by replay, a pending age bound, single-device self-check.
  - N3: referenced-table trigger suspension and a released-binary Gate B run.
  - N4: live-row identity and the `birth_fp` patch.
  - N5: the birthtime NULL rule.
  - N6: the registry path from `packages/paths`, the server-authoritative rollback, no rebind on registry loss.
  - N7: the three-way reconcile, with the monotonicity break stated.
  - N8: K netting and the `sent` flag.
  - N9: REPLACE → UPSERT audit before `recursive_triggers`.
  - N10, N11: frame GC and `_f` scope.
  - Q15–Q18 decided; new Q19 and Q20.
- v3.1 (2026-09-29): §0.4 maps H1–H5 to tasks T12751–T12755 (T12343 depends on them; T12755 also depends on T12341).
- v3 (2026-09-29): answers cleo-dev's FIX-FIRST review of v2 (map in §0.4).
  - H1: the stamp never deletes. Echo is dropped by image matching in validated apply frames; apply bodies are synchronous; frames are validated by `_sync_frame`.
  - H2: applied-effect accounting for `checkManifest`, with the server change specified (§2.11).
  - H3: a new replica never re-emits inherited rows and reconciles through a checkpoint diff; binding is inode + birthtime + nonce plus a device high-water mark; retire transactions; `sync: 'off'` opens.
  - H4: structural-safety rules and tests (§2.3a); T12341's rollback amended.
  - H5: T12341 dependency gate; K op and identity triggers; `bfp` on every minted op; refs at capture; fill-patch trigger for both trigger orders.
  - M1: `recursive_triggers` with a trigger audit, and suspect marking for the lineage carry-forward.
  - M2: per-replica FIFO skew hold.
  - M3: the kill switch no longer touches triggers.
  - M4: a strict timestamp canonicalizer; no seal-time local rewrite; the CAS token excluded.
  - M5: a split rule for oversized groups.
  - M6: secret columns excluded from `chash`, with a device-keyed `shash`.
  - M7: exemptions per (file, table); W3 marked per site; AGENTS.md row 28 in the S0 PR.
  - M8: changeset blind spots listed.
  - L1–L5 addressed.
  - Q9 and Q11 decided: the STDP and `token_usage` reclass changes gate 28 to 148 sync-class sites. New questions Q15–Q18.
- v2 (2026-09-29): claude-todo's store is located on the migration share (legacy schema, migrated by exodus). Added its Gate B baseline (§0.1, §5.1), the rule to run on scratch copies only, and an updated risk K6.
- v1 (2026-09-29): first draft for cleo-dev review. It covers HLC (T12342), capture and outbox (T12343), the receive boundary for T12344, the bypass check with the gate 28 plan, slices, performance and open questions.

