# SG-DB-SUBSTRATE-V2 — SQLite 3.53.0 consolidation spike (T11244)

Runnable benchmark, fixture, durability, and internalization harnesses that
produce the **measured PASS/FAIL evidence** gating the SG-DB-SUBSTRATE-V2 saga
(T11242, epics E2–E8). The architectural lock decision (D1′) is: a **single
SQLite file per scope** (project, global) with **domain-prefixed tables**
(`tasks_*`, `brain_*`, `conduit_*`, `docs_*`, `telemetry_*`) — **Pattern A** —
driven by `node:sqlite` (Node 24.16+, bundled SQLite 3.53.0) + `drizzle-orm`
v1.0.0-rc.3. **ATTACH is rejected.**

## Layout

| File | Gate / child task | What it proves |
|------|-------------------|----------------|
| `01-substrate-floor.ts` | T11321 | `sqlite_version()` ≥ 3.53.0 + Node ≥ `engines.node` + `FALLBACK_MIN_NODE` SSoT alignment (Gate 8) |
| `02-concurrency-bench.ts` | T11322 | 100 writers @10/s × 5 min: consolidated p99 ≤ 1.5× per-domain baseline p99 |
| `03-idempotency-bench.ts` | T11323 | Pattern A `idempotency_key TEXT PRIMARY KEY` + drizzle `onConflictDoNothing({target})`: dedupe to 1 row, index overhead ≤ 10% |
| `04-consolidation-fixture.ts` | T11324 | 5-domain single-file-per-scope fixture, `PRAGMA foreign_key_check` = 0 rows, ATTACH rejected with evidence |
| `05-durability.ts` | T11325 | SIGKILL-mid-tx ×100 → `integrity_check`='ok'; epic:T1075 WAL-reset reproducer NO LONGER reproduces; cold-start budget |
| `06-napi-internalization.ts` | T11326 | Pattern P2 fetch + sha256 fail-closed + P1 bundled fallback + `CLEO_NAPI_BINARY_MIRROR`; zero separate OIDC |
| `run-all.ts` | T11244 | Runs every harness, emits the consolidated architectural-lock verdict |
| `lib/*` | — | Shared pragma set, latency stats, consolidated schema, open helper, killable writer, napi resolver |
| `results/*.json` | — | Captured measured evidence from the live Node 24.16 / SQLite 3.53.0 run |

## Running

All harnesses are standalone `tsx` scripts (no build step). From the repo root:

```bash
# Individual gate
pnpm dlx tsx tools/db-substrate-spike/04-consolidation-fixture.ts

# Full roll-up (fast local — short concurrency/durability windows)
SPIKE_DURATION_S=15 SPIKE_KILL_ITERS=20 pnpm dlx tsx tools/db-substrate-spike/run-all.ts

# Full gate (CI — the AC-mandated 5-min concurrency + 100 SIGKILL iterations)
pnpm dlx tsx tools/db-substrate-spike/run-all.ts
```

### Knobs (env)

| Var | Default | Used by |
|-----|---------|---------|
| `SPIKE_WRITERS` | `100` | concurrency |
| `SPIKE_RATE_HZ` | `10` | concurrency (writes/sec/writer) |
| `SPIKE_DURATION_S` | `300` | concurrency (set lower locally) |
| `SPIKE_KILL_ITERS` | `100` | durability |
| `CLEO_NAPI_BINARY_MIRROR` | — | napi resolver mirror override |

## Mandatory consolidation pragmas (per open)

`journal_mode=WAL` · `synchronous=NORMAL` · `busy_timeout=30000` ·
`wal_autocheckpoint=1000` · `foreign_keys=ON`. See `lib/pragmas.ts`. (The live
`specs/sqlite-pragmas.json` still uses `busy_timeout=5000`; aligning it to
30000 is downstream epic E2 — the spike measures against the target policy.)

## CI note

The full 5-minute concurrency gate and 100-iteration durability gate are
runtime-bound; CI runs `run-all.ts` with the defaults. Cross-platform handle
smoke (macOS arm64, Pi 4 aarch64) for AC1 must run on those CI runners — this
spike measures x86_64 Linux on the live Node 24.16 / SQLite 3.53.0 runtime.
