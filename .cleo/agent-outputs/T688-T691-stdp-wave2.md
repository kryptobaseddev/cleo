# STDP Wave 2 — T688/T689/T692/T691

**Worker**: STDP Wave 2 algorithm chain
**Commit**: 760113ee (bundled with T713/T714 guards by prior agent in same session)
**Status**: complete
**Date**: 2026-04-15

## Summary

All four Wave 2 tasks implemented as a coherent extension to `applyStdpPlasticity` in `packages/core/src/memory/brain-stdp.ts`.

## T688 — STDP-A1: Cross-session pair window (pairingWindowMs=24h)

- `DEFAULT_PAIRING_WINDOW_MS` changed from `5 * 60 * 1000` (5 min) to `24 * 60 * 60 * 1000` (24 h)
- Spike pairs within 24h window are eligible regardless of session boundary
- Session boundary is NOT a hard cutoff — tiered τ (T689) handles magnitude
- JSDoc on `StdpPlasticityOptions.pairingWindowMs` updated to document T688 semantics
- Per spec §3.2 and owner Q2 directive (LOCKED: 24h)

## T689 — STDP-A2: Tiered τ (near/session/episodic)

New constants:
- `TAU_NEAR_MS = 20_000` (20 s) — intra-batch, Δt ≤ 30 s
- `TAU_SESSION_MS = 30 * 60 * 1000` (30 min) — intra-session, 30 s < Δt ≤ 2 h
- `TAU_EPISODIC_MS = 12 * 60 * 60 * 1000` (12 h) — cross-session, Δt > 2 h

New exported function:
```typescript
export function computeTau(deltaT: number): number
```

Both LTP and LTD use `computeTau(deltaT)` instead of the old single `TAU_PRE_MS`/`TAU_POST_MS`.
Per spec §3.3.

## T692 — STDP-A5: R-STDP reward modulation + eligibility trace

After base `deltaW` computed, if `spikeA.rewardSignal !== null`:
```
deltaW = max(min(deltaW * (1 + r), 2 * A_PRE), 0)
deltaWNeg = max(deltaWNeg * (1 - r), -2 * A_POST)
```

- `wasRewardModulated` / `ltdWasRewardModulated` flags track per-pair modulation
- `StdpPlasticityResult.rewardModulatedEvents` field incremented per modulated LTP or LTD event
- null reward_signal → no modulation (r treated as 0, unmodified deltaW)
- Cap: LTP capped at 2×A_pre=0.10; LTD capped at -2×A_post=-0.12
- Per spec §3.6.

## T691 — STDP-A4: Novelty boost (k_novelty=1.5 on INSERT)

On INSERT path (first co-retrieval, edge does not exist):
```
noveltyBoostedWeight = deltaW * K_NOVELTY
initialWeight = min(WEIGHT_MAX, min(A_PRE * K_NOVELTY, noveltyBoostedWeight))
```

- `K_NOVELTY = 1.5` constant added
- UPDATE path (existing edge) uses standard deltaW without boost
- `reinforcement_count` starts at 1 on INSERT, increments on each LTP UPDATE
- Per spec §3.7.

## Tests

File: `packages/core/src/memory/__tests__/brain-stdp-wave2.test.ts`

Real SQLite, no mocks. Test cases:
- T688-1: cross-session pair within 24h → LTP fires
- T688-2: pair OUTSIDE 24h → 0 events
- T688-3: confirms pre-T688 behavior (old 5min → 0 events; new 24h → events fire)
- T689-1: near vs session Δw magnitudes
- T689-2: computeTau() returns correct τ for all three Δt tiers (unit test)
- T689-3: τ selection validated by formula
- T692-1: r=+1.0 → Δw approximately doubled
- T692-2: r=-1.0 → LTP zeroed out (edge not created)
- T692-3: r=+0.5 → Δw increased vs null
- T692-4: null reward → no modulation, rewardModulatedEvents=0
- T692-5: rewardModulatedEvents counts correctly across mixed pairs
- T691-1: novel edge weight = A_pre*k_novelty=0.075 (not standard 0.030)
- T691-2: existing edge (UPDATE path) does NOT get novelty boost
- T691-3: reinforcement_count starts at 1, increments on subsequent LTP
- Integration: all 4 features active together

## Quality Gates

- `pnpm biome check --write`: 0 errors, 2 pre-existing warnings (nativeDb: any in T713/T714 guards)
- `pnpm --filter @cleocode/core build`: PASS
- `pnpm --filter @cleocode/core test`: 3964 passed, 0 failures (251 test files)

## Files Modified

- `packages/core/src/memory/brain-stdp.ts` — algorithm implementation
- `packages/core/src/memory/__tests__/brain-stdp-wave2.test.ts` — functional tests (new file)
