# T1112 — Sentient Tier-2 Anomaly Proof

## What this proves

The sentient nexus-ingester (`runNexusIngester`) correctly fires **five independent
anomaly detectors** when deliberately anomalous graph data is present — and produces
zero false positives on clean, unrelated symbols.

This is a **real proof**, not a mock: the ingester runs against actual injected data
in an in-memory SQLite database using the live dist/ build of `@cleocode/core`.

## Anomaly types and expected weights

| Detector | Anomaly type           | Injected symbol  | Expected weight |
|----------|------------------------|------------------|-----------------|
| Query A  | orphaned-callee        | `ORPHAN_SINK`    | 0.3 (base)      |
| Query B  | over-coupled-node      | `MEGA_HUB`       | 0.3 (base)      |
| Query C  | community-fragmentation| `comm:alpha`     | 0.4             |
| Query D  | entry-erosion          | `DEAD_PROC`      | 0.5             |
| Query E  | cross-community-spike  | `BRIDGE_NODE`    | 0.35            |

## Injected anomalies

### Query A: Orphaned callee (`ORPHAN_SINK`)
Function `orphanedSink` has 6 callers in the graph but makes zero outbound calls.
The detector fires when `caller_count > 5` (NEXUS_MIN_CALLER_COUNT).

### Query B: Over-coupled node (`MEGA_HUB`)
Function `megaHub` has 45 total edges (> 20 NEXUS_MIN_DEGREE threshold). Ranks #1
in Query B's `ORDER BY degree DESC LIMIT 5`.

### Query C: Community fragmentation (`comm:alpha`)
The nexus_schema_meta community snapshot records 10 symbols for community `comm:alpha`.
Current state has only 7 — a 30% drop exceeding the 20% (NEXUS_COMMUNITY_SHRINK_THRESHOLD)
trigger. Weight: 0.4 (NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT).

### Query D: Entry-point erosion (`DEAD_PROC`)
Process node `deadProcess` has an `entry_point_of` relation pointing to `hiddenEntry`
(a function with `is_exported = 0`). The detector fires when the process entry is
unexported. Weight: 0.5 (NEXUS_ENTRY_EROSION_WEIGHT).

### Query E: Cross-community coupling spike (`BRIDGE_NODE`)
Function `bridgeNode` has 32 total edges (> 30 NEXUS_MIN_CROSS_COUPLING_DEGREE) and
17 cross-community edges to `comm:epsilon` (> 15 NEXUS_MIN_CROSS_COMMUNITY_EDGES).
Weight: 0.35 (NEXUS_CROSS_COUPLING_WEIGHT).

**Note on detector ordering:** The ingester deduplicates candidates across all five
queries. Since Query B fires before Query E and both share the `degree > 20` criterion,
a node with degree > 30 would normally be consumed by Query B before Query E sees it.
The fixture seeds 4 "decoy" high-degree nodes (40 edges each) to saturate Query B's
LIMIT=5 window, ensuring `BRIDGE_NODE` (rank 6) is skipped by Query B and correctly
caught by Query E.

## Zero-false-positive control

Symbols `CLEAN_FUNC`, `CLEAN_CALLER`, and `NORMAL_HUB` are seeded with no anomalies:
- `CLEAN_FUNC`: only 1 caller (below Query A's threshold of > 5)
- `NORMAL_HUB`: only 5 edges (below Query B's threshold of > 20)
- None are in an eroded community or cross-community spike

All three must be absent from proposals. Any appearance is a false positive and fails
the assertions.

## How to run

```bash
# From project root
bash scenarios/sentient-anomaly-proof/run.sh
bash scenarios/sentient-anomaly-proof/assertions.sh
```

Both scripts exit 0 on success.

Alternatively, run the proof script directly:

```bash
node scenarios/sentient-anomaly-proof/proof.mjs \
  --project-root=$(pwd) \
  --output=/tmp/proof-output.json
```

## Files

| File | Purpose |
|------|---------|
| `run.sh` | Entry point — guards, runs `proof.mjs` |
| `proof.mjs` | Core proof: creates in-memory DB, seeds anomalies, runs ingester, writes JSON |
| `assert-runner.mjs` | JSON assertion engine — reads `proof-output.json`, checks all invariants |
| `assertions.sh` | Shell wrapper for `assert-runner.mjs` |
| `fixtures/anomaly-seed.mjs` | DB schema creation + anomaly seeding utilities |
| `proof-output.json` | Generated output (git-ignored) |

## Methodology

1. **In-process, no daemon** — The proof directly imports `runNexusIngester` from
   `packages/core/dist/` (the live built module). No daemon startup, no kill-switch
   bypass, no mocking of the ingester itself.

2. **In-memory SQLite** — Uses Node.js `DatabaseSync(':memory:')` so the test leaves
   zero side effects on real databases.

3. **Structural injection** — Anomalies are created via raw SQL INSERT statements
   matching the exact schema that `gitnexus analyze` populates. The ingester cannot
   tell the difference from real data.

4. **Deterministic weight verification** — Each detector's weight constant
   (`NEXUS_BASE_WEIGHT`, `NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT`, etc.) is imported
   from the same dist module and cross-checked against the returned candidates.

5. **JSON audit trail** — `proof-output.json` captures the full structured result
   including `anomalyResults[]`, `falsePositiveControl[]`, and `summary`. This file
   is the evidence atom for the `implemented` gate.

## Related

- `packages/core/src/sentient/ingesters/nexus-ingester.ts` — detector source
- `packages/core/src/sentient/propose-tick.ts` — propose tick pipeline
- `packages/contracts/src/sentient.ts` — ProposalCandidate type
- `packages/core/src/sentient/__tests__/nexus-ingester.test.ts` — unit tests
- Task T1112 · Epic T1056 · ADR-054
