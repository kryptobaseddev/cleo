# SQLite 3.53.0 Consolidation Spike — Architectural Lock (T11244)

**Saga:** T11242 (SG-DB-SUBSTRATE-V2) · **Epic:** T11244 (E1) · **Gate for:** E2–E8
**Runtime measured:** Node 24.16.0 / `node:sqlite` SQLite **3.53.0** / x86_64 Linux
**Driver:** `node:sqlite` (`DatabaseSync`) + `drizzle-orm` / `drizzle-kit` **v1.0.0-rc.3** (`drizzle-orm/node-sqlite`)
**Verdict:** ✅ **ARCHITECTURAL LOCK HOLDS** — SQLite single-file-per-scope consolidation (Pattern A) is validated under every gate.

All numbers below are produced by committed, runnable harnesses under
`tools/db-substrate-spike/` (run `pnpm dlx tsx tools/db-substrate-spike/run-all.ts`).
Raw captured JSON lives in `tools/db-substrate-spike/results/`.

## Question

Does a SINGLE SQLite file per scope with domain-prefixed tables (Pattern A),
driven by `node:sqlite` 3.53.0 + drizzle-orm rc.3, hold up as the substrate for
SG-DB-SUBSTRATE-V2 under concurrency, idempotency, cross-domain FK integrity,
crash durability, and napi-binary internalization gates — and is the phased
SQLite/PGlite hybrid (Counter-B) correctly rejected?

## Findings

The architectural lock HOLDS: all six gates PASS on the live runtime (§2–§3),
and Counter-B (phased ATTACH-merge / PGlite-via-socket) is rejected on measured
and cited evidence (§4). Detail below.

---

## 1. Decision (locked — do not relitigate)

- **D1′**: SQLite consolidation CHOSEN; PGlite REJECTED. **Pattern A** = a SINGLE
  SQLite file per scope (project, global) with domain-prefixed tables
  (`tasks_*`, `brain_*`, `conduit_*`, `docs_*`, `telemetry_*`). **ATTACH rejected.**
- **Driver**: first-party `node:sqlite` (zero native deps) on the WAL-reset-fixed
  SQLite 3.53.0; ORM `drizzle-orm/node-sqlite` rc.3.
- **Idempotency Pattern A**: `idempotency_key TEXT PRIMARY KEY` + `INSERT … ON
  CONFLICT(target) DO NOTHING` on the domain table itself (no separate ledger).
- **napi D14′**: Pattern P2 (postinstall GitHub-Release fetch + checked-in sha256
  manifest, fail-closed) + Pattern P1 (linux-x64-gnu bundled fallback) +
  `CLEO_NAPI_BINARY_MIRROR`. **Zero** separate binary OIDC publishes.
- **Mandatory per-open pragmas**: `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout=30000`, `wal_autocheckpoint=1000`, `foreign_keys=ON`.

---

## 2. Gate results (measured PASS/FAIL)

| Gate | Child | Metric | Result | Verdict |
|------|-------|--------|--------|---------|
| Substrate floor | T11321 | `sqlite_version()` ≥ 3.53.0; Node ≥ `engines.node`; `FALLBACK_MIN_NODE` SSoT | 3.53.0 / Node 24.16.0 / SSoT aligned | ✅ PASS |
| Concurrency p99 | T11322 | consolidated p99 ≤ 1.5× faithful baseline p99 | **0.996×** (3.212ms vs 3.227ms) | ✅ PASS |
| Idempotency Pattern A | T11323 | dedupe to 1 row; UNIQUE-index overhead ≤ 10% | 1 row; **−6.26% p50** index overhead | ✅ PASS |
| Consolidation + FK | T11324 | 5 domains in 1 file; `foreign_key_check`=0; ATTACH rejected | 0 violations; ATTACH blocked | ✅ PASS |
| Durability | T11325 | SIGKILL ×100 → `integrity_check`=ok; epic:T1075 not reproduced | 100/100 ok; not reproduced (200 cycles) | ✅ PASS |
| napi internalization | T11326 | P2 fetch + sha256 fail-closed + P1 fallback + mirror; 0 OIDC | 5/5 scenarios; 0 OIDC | ✅ PASS |
| drizzle-kit v3 layout | (AC3) | folder-per-migration, no legacy `_journal.json` | confirmed (rc.3) | ✅ PASS |

---

## 3. Evidence detail

### 3.1 T11321 — substrate floor

```
node 24.16.0 · sqlite_version()=3.53.0 · process.versions.sqlite=3.53.0
engines.node floor=24.16.0 · FALLBACK_MIN_NODE=24.16.0  (Gate 8 SSoT aligned)
4/4 checks PASS
```

`SELECT sqlite_version()` returns 3.53.0 — the release carrying the WAL-reset
corruption fix (`https://sqlite.org/releaselog/3_53_0.html`), the exact class as
CLEO's historical `epic:T1075` brain.db malformation (errcode=11). The runtime
SQLite agrees with `process.versions.sqlite`, and the node-version-gate
`FALLBACK_MIN_NODE` equals root `engines.node` (the Gate-8 SSoT invariant).

### 3.2 T11322 — concurrency + p99 commit latency (100 writers @10/s × 5 min)

Three scenarios, each 100 independent connections (one per worker thread,
simulating concurrent `cleo` processes), `BEGIN IMMEDIATE`/`COMMIT` per write,
mandatory pragmas applied:

| Scenario | File topology | commits | errors | p50 | p95 | **p99** | p99.9 |
|----------|---------------|--------:|-------:|----:|----:|--------:|------:|
| baseline-even | 5 files, even round-robin | 299,275 | 0 | 0.047 | 0.163 | **1.199** | 5.45 |
| baseline-skewed | 1 hot (~80%) + 4 cool | 299,347 | 0 | 0.049 | 1.124 | **3.227** | 16.74 |
| consolidated | 1 file, all domains | 302,381 | 0 | 0.045 | 1.115 | **3.212** | 18.27 |

(ms; throughput ≈ 1000 commits/s in all three.)

**Gate metric** = consolidated p99 / *faithful* skewed-baseline p99 =
3.212 / 3.227 = **0.996× ≤ 1.5 → PASS.**

The faithful baseline models today's real distribution: `tasks.db` already
absorbs ~80% of writes, so it is *already* the contention bottleneck. Moving the
cooler 20% (brain/conduit/docs/telemetry) into the same file adds essentially
nothing to the tail — consolidated is even marginally faster. **Zero
SQLITE_BUSY errors** across 900K+ commits confirms `busy_timeout=30000` + WAL
absorbs the single-writer serialization queue cleanly.

**Worst-case bound (honest disclosure):** against the *even-split* baseline
(every domain file carries an equal 1/5 of writers — maximally favorable to a
multi-file layout, and NOT CLEO's real profile), the ratio is **2.68×**. This is
the theoretical ceiling: WAL permits one writer at a time per file, so funneling
all 100 writers onto one WAL serializes commits that 5 files would parallelize.
The absolute consolidated p99 remains **3.2ms** — three orders of magnitude
under any human-perceptible CLI latency. This bound is a tuning signal for E2–E8
(see §5), not a lock blocker.

### 3.3 T11323 — idempotency Pattern A (drizzle rc.3)

Emitted SQL (real `onConflictDoNothing({ target })`, NO raw-SQL fallback):

```sql
insert into "conduit_event" ("idempotency_key","task_id","payload","created_at")
values (?, ?, ?, ?) on conflict ("conduit_event"."idempotency_key") do nothing
```

- Insert `DEDUP` once + **100 retries → exactly 1 row**; first-write-wins
  (`{"n":0}` persisted). ✅
- **UNIQUE-index (TEXT PRIMARY KEY) overhead on hot insert: −6.26% p50 / −7.46%
  mean** vs a byte-identical no-index control (20,000 interleaved inserts each).
  The index cost is negligible (the negative sign is measurement noise at this
  row scale) — well within the ≤10% budget. ✅
- Full Pattern-A path (PK + `ON CONFLICT`) adds **+13% p50** over a no-index
  plain insert — that is the conflict-clause cost (the price of idempotency),
  reported transparently; it is distinct from the "UNIQUE-index cost" the AC
  isolates.

### 3.4 T11324 — consolidation fixture + cross-domain FK integrity

For BOTH scopes (project, global): all five domain tables (`tasks_task`,
`brain_memory`, `conduit_event`, `docs_attachment`, `telemetry_span`) co-exist in
ONE file. After seeding 4 cross-domain FK edges (all → `tasks_task.id`):

- `PRAGMA foreign_key_check` → **0 violation rows.** ✅
- Deliberately-injected orphan (`task_id='T-DOES-NOT-EXIST'`) → **detected** by
  `foreign_key_check` (`{table:brain_memory, parent:tasks_task, …}`), proving the
  check is live, not vacuously passing. ✅

**ATTACH rejection — concrete evidence:** a child table declaring `REFERENCES
parent(id)` where `parent` lives only in an ATTACHed file FAILS the write with:

```
no such table: main.parent
```

SQLite resolves FK parent names within the **main schema only** — you cannot even
*declare* an enforceable FK to an attached table. ATTACH ceiling probed:
**maxAttached=10, fails at 11** (default `SQLITE_LIMIT_ATTACHED`), leaving zero
headroom for a 5+ domain topology. Combined with WAL+ATTACH breaking cross-file
COMMIT atomicity (SQLite docs), **ATTACH is rejected** — Pattern A's single file
is the only way to get native, transactional, enforced cross-domain FKs.

### 3.5 T11325 — durability + epic:T1075 reproducer

- **SIGKILL mid-transaction ×100** against one file (each cycle: commit 20 rows,
  open a transaction, write uncommitted rows, signal `MID_TX`, spin; parent
  SIGKILLs; reopen triggers WAL recovery). Result: **integrity_check='ok' all
  100/100**, every committed batch survived, **zero uncommitted rows leaked**. ✅
- **epic:T1075 WAL-reset reproducer** — 200 cycles of the historical corruption
  trigger (rapid `wal_checkpoint(RESET)` + concurrent second-handle write +
  reopen). **NOT reproduced** (`integrity_check='ok'` every cycle), confirming
  the SQLite 3.53.0 WAL-reset fix closes the malformation class. ✅
- **Cold-start (DB-substrate contribution):** open consolidated file + run a
  briefing-class query set over a 5,000-row fixture: **cold 0.47ms, warm p95
  0.34ms** — vs budget cold <200ms / warm <50ms. ✅ (Full `cleo briefing`
  subprocess latency of ~6–8s is dominated by Node module-load + CLI dispatch,
  tracked separately as **T11292**, and is orthogonal to the DB substrate.)

### 3.6 T11326 — napi internalization (D14′)

Resolver exercised against the REAL 3.1MB `worktree-napi.linux-x64-gnu.node`
(sha256 verified), 5 scenarios all PASS:

| Scenario | Outcome |
|----------|---------|
| P2 happy path (fetch + checksum match) | verified via `p2-fetch` |
| P2 tamper (1-byte flip) | **FAIL-CLOSED** (`sha256 mismatch`, no silent fallback) |
| P1 fallback (fetch throws, bundled present) | verified via `p1-bundled-fallback` |
| `CLEO_NAPI_BINARY_MIRROR` override | fetch redirected to corp mirror URL |
| offline + no bundled fallback (darwin-arm64) | **FAIL-CLOSED** (`no P1 bundled`) |

**Zero separate binary OIDC publishes**: P2 ships binaries as GitHub Release
*assets*; P1 bundles linux-x64-gnu inside the `@cleocode/core` tarball. Neither
is an npm package publish.

### 3.7 AC3 — drizzle-kit v1.0.0-rc.3 migration layout

`drizzle-kit generate` produced the **v3 folder-per-migration** structure:

```
drizzle/20260530012034_spike_init/migration.sql
drizzle/20260530012034_spike_init/snapshot.json
```

Second-precision timestamp folder, `migration.sql` + `snapshot.json`, **no legacy
`_meta/_journal.json`**. Cross-domain FKs render correctly in generated DDL.

---

## 4. Counter-B rejection — phased SQLite hybrid / PGlite-via-socket (HARD prerequisite)

A "phased hybrid" alternative was considered and is **REJECTED** in favor of the
clean dual-scope single-file consolidation. Two hybrid shapes were evaluated:

**Hybrid shape 1 — keep N files, gradually ATTACH-merge.**
REJECTED on this spike's own evidence (§3.4): (a) cross-file FKs are *unenforceable*
— `REFERENCES parent` fails with `no such table: main.parent`, so referential
integrity simply cannot span ATTACH boundaries; (b) `SQLITE_LIMIT_ATTACHED=10`
gives no headroom for a 5+ domain topology that will grow; (c) **WAL + ATTACH
breaks cross-file COMMIT atomicity** (SQLite docs) — a transaction touching two
attached files is not atomic across them, reintroducing exactly the
torn-write/corruption class T11242 exists to eliminate. A phased ATTACH-merge
would carry this hazard for the entire (multi-release) migration window. Drizzle
v1 also has zero ATTACH support, so the ORM could not model it.

**Hybrid shape 2 — run PGlite via `pglite-socket` as an interim multiplexer.**
REJECTED: PGlite is fundamentally a **single-connection** WASM Postgres; the
`pglite-socket` multiplexer fans concurrent connections over that one connection
and the project's own docs warn "not all cases might be covered." **Supabase
publicly rejected this exact multiplexer** when building database.build Live
Share — "the more they dug into it, the more they realized this is a bad idea" —
and instead built a websocket-to-TCP proxy, precisely because multiplexing a
write-heavy agent workload over one serialized connection is a bottleneck. On
raw write throughput, **PGlite is ~30× slower than native SQLite** in an
independent Node benchmark (multi-second territory for inserts vs ~20ms for
better-sqlite3), and the broadly-cited WASM write penalty is **5–20×** from
sync-to-async bridging + the WASM→main-thread→storage path + expensive fsync.
CLEO's CLI workload is latency-sensitive and write-bursty — the worst possible
fit for a serialized WASM connection.

**Conclusion:** the consolidated single-file-per-scope native `node:sqlite`
design measured here delivers enforced cross-domain FKs, atomic commits, ~1000
commits/s with zero busy-errors, 3.2ms p99 at 100 concurrent writers, and crash
durability — none of which the phased hybrids can match without carrying a
corruption/throughput hazard for the entire migration window. Counter-B is
rejected; the clean consolidation is locked.

---

## 5. Carry-forward signals for E2–E8 (non-blocking)

1. **Even-load p99 worst case (2.68×):** if any future domain becomes a co-equal
   hot writer (not the case today), the single-WAL tail grows. E2 should align
   the live `specs/sqlite-pragmas.json` `busy_timeout` from `5000` → `30000` (the
   spike's measured policy) and consider `wal_autocheckpoint` tuning; the abs p99
   (3.2ms) leaves enormous margin, so this is a watch-item, not a redesign.
2. **`busy_timeout` SSoT drift:** the live spec uses `5000`; the spike validated
   `30000`. E2 owns the one-line alignment + the Rust `build.rs` applicator.
3. **Raw `new DatabaseSync(` chokepoint bypasses:** ~14 files still bypass
   `openCleoDb(role, cwd)` (goal ≤3). Consolidation must route every domain open
   through the chokepoint so the mandatory pragmas apply uniformly (the spike's
   `lib/open.ts` mirrors that contract).
4. **CI cross-platform smoke (AC1):** this spike measured x86_64 Linux. macOS
   arm64 + Pi 4 aarch64 native-handle smoke for AC1 must run on those CI runners.
5. **Idempotency conflict-clause cost (+13% p50):** acceptable, but high-volume
   idempotent write paths should batch where possible.

---

## Sources

- SQLite 3.53.0 release log (WAL-reset corruption fix) — `https://sqlite.org/releaselog/3_53_0.html`
- PGlite socket multiplexer docs (single-connection caveat) — `https://pglite.dev/docs/pglite-socket`
- PGlite benchmarks — `https://pglite.dev/benchmarks`
- Supabase database.build Live Share architecture (rejected pglite-socket multiplexer; built websocket-to-TCP proxy instead) — `https://supabase.com/blog/database-build-live-share`
- Independent sqlite3-bench (PGlite ~30× slower than better-sqlite3 for inserts in Node) — `https://github.com/marcus-pousette/sqlite3-bench`
- Captured spike evidence — `tools/db-substrate-spike/results/*.json` (this repo)
