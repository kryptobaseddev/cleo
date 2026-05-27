# T1021 + T1022 — KMS Adapter + Sentient Events Implementation

**Date**: 2026-04-20
**Agent**: Sonnet 4.6 subagent
**Status**: complete
**Tasks**: T1021 (KMS adapter), T1022 (events schema)

---

## Work Summary

Implemented the Tier-3 cryptographic signing foundation for the CLEO sentient
auto-merge pipeline. Three new modules were created in
`packages/core/src/sentient/`:

### Files Created

| File | Purpose |
|------|---------|
| `kms.ts` | CLEO_KMS_ADAPTER selector — env/file/vault-stub/aws-stub |
| `events.ts` | SentientEvent discriminated union (8 kinds), appendSentientEvent, querySentientEvents |
| `baseline.ts` | captureBaseline — pre-worktree daemon-side signed baseline capture |
| `__tests__/kms.test.ts` | 28 tests for KMS adapter |
| `__tests__/events.test.ts` | 20 tests for events module |
| `__tests__/baseline.test.ts` | 6 tests for baseline capture |

### Files Modified

| File | Change |
|------|--------|
| `index.ts` | Added exports for kms, events, baseline |
| `packages/cleo/src/cli/commands/sentient.ts` | Added `cleo sentient baseline capture <sha>` |
| `packages/core/package.json` | Added explicit subpath exports for baseline.js, events.js, kms.js |

---

## T1021 — KMS Adapter (`kms.ts`)

Exports `loadSigningIdentity(projectRoot)` which returns an `AgentIdentity`
from `llmtxt/identity` using the backend selected by `CLEO_KMS_ADAPTER`.

**Adapters implemented:**
- `env` (default for dev/CI): reads `CLEO_SIGNING_SEED` (64-char hex)
- `file` (default): reads `.cleo/keys/sentient.ed25519` (mode 0600, enforced)
- `vault` (stub): reads VAULT_ADDR + VAULT_TOKEN, documents Transit Engine API
- `aws` (stub): reads CLEO_KMS_AWS_KEY_ID, documents KMS Sign/Verify/GetPublicKey

**Security properties:**
- File adapter refuses to load if permissions != 0600 (closes Round 2 attack #3)
- The daemon owns the signing context; container agent never holds the key
- Default is `file` for backward compat with ADR-054 (env for CI/dev)

---

## T1022 — Events Schema (`events.ts`)

Defines the `SentientEvent` discriminated union with all 8 kinds:
- `baseline`, `sandbox.spawn`, `patch.proposed`, `verify`, `sign`, `merge`, `abort`, `revert`

**Key functions:**
- `appendSentientEvent(projectRoot, identity, input)` — signs + appends to NDJSON log
- `querySentientEvents(projectRoot, filter)` — filters by kind/experimentId/after/limit
- `verifySentientEventSignature(event)` — verifies Ed25519 signature

**Merkle chain:** Each event's `parentHash` = SHA-256 of the previous event line.
Genesis event has 64 zeros as parentHash. Tampering breaks chain from that point.

---

## Baseline Capture (`baseline.ts`)

`captureBaseline(projectRoot, commitSha)`:
1. Verifies commit exists in git + gets author timestamp
2. Enforces 5s minimum age (anti-gaming: prevents same-tick race)
3. Gathers git diff --stat metrics
4. Signs via KMS adapter
5. Writes `kind:"baseline"` event to audit log
6. Returns CapturedBaseline with receiptId, publicKey, signature

**Anti-gaming guard**: `E_BASELINE_MUST_PREDATE_EXPERIMENT` thrown if commit < 5s old.

---

## CLI Verb Added

`cleo sentient baseline capture <sha>` — added as subcommand under `cleo sentient baseline`.

---

## Test Results

| File | Tests | Status |
|------|-------|--------|
| `kms.test.ts` | 28 | All pass |
| `events.test.ts` | 20 | All pass |
| `baseline.test.ts` | 6 | All pass |
| **Total** | **54** | **All pass** |

---

## Gates Passed

- `pnpm biome check`: Clean (0 errors)
- `pnpm --filter @cleocode/core run build`: Success
- `pnpm --filter @cleocode/cleo run build`: Pre-existing errors in session.ts and task-engine.ts (not introduced by this work)
- All 54 tests pass
