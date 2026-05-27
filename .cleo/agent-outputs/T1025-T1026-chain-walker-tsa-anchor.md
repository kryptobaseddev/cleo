# T1025 + T1026 Implementation: Chain Walker + TSA Anchor

## Summary

Implemented Merkle chain verification (T1025) and RFC 3161 daily TSA anchor (T1026)
for the sentient audit event log.

## Files Created

### packages/core/src/sentient/chain-walker.ts
- `verifyEventChain(projectRoot)` — walks entire NDJSON log, verifies each
  `parentHash = sha256(prevLine)`. Returns `{ total, verified, broken, firstBrokenAt }`.
- `walkChainFrom(projectRoot, receiptId)` — returns all events from receiptId
  forward to HEAD. Throws `E_RECEIPT_NOT_FOUND` if receiptId is not in log.
- `E_RECEIPT_NOT_FOUND` — exported error code constant.

### packages/core/src/sentient/tsa-anchor.ts
- `anchorChainDaily(projectRoot, tsaClientOverride?)` — no-op if last anchor
  < 24h ago or chain is empty. POSTs RFC 3161 TimeStampReq (hand-coded DER via
  node:crypto). Writes `kind:'tsa_anchor'` event on success. Returns null on
  any TSA failure (non-blocking).
- `buildTimestampRequest(messageHash)` — exported for testing; encodes minimal
  `TimeStampReq` ASN.1 DER (SEQUENCE { version, MessageImprint, certReq }).
- `postTimestampRequest(url, body)` — raw HTTP POST via node:https/node:http.
- `readTsaUrl(projectRoot)` — reads `.cleo/sentient.json.tsaEndpoint`, falls
  back to `http://timestamp.digicert.com`.
- TSA client override param allows dependency injection in tests (no module spying).

### packages/core/src/sentient/events.ts (modified)
- Added `tsa_anchor` to `SentientEventKind` union.
- Added `TsaAnchorPayload` interface.
- Added `TsaAnchorEvent` interface extending `SentientEventBase`.
- Added `TsaAnchorEvent` to `SentientEvent` discriminated union (now 9 kinds).

### packages/core/src/sentient/index.ts (modified)
- Added exports for `chain-walker.js` and `tsa-anchor.js`.

## Test Files

### packages/core/src/sentient/__tests__/chain-walker.test.ts
10 tests: intact chain (3), tampered chain (2), walkChainFrom success (3),
walkChainFrom errors (2). All pass.

### packages/core/src/sentient/__tests__/tsa-anchor.test.ts
13 tests: buildTimestampRequest (3), readTsaUrl (3), anchorChainDaily no-op (2),
success path (3), TSA failure (2). All pass.

## Test Results

- chain-walker: 10/10 pass
- tsa-anchor: 13/13 pass
- events (regression): 20/20 pass
- Total new tests: 23 pass

## Design Decisions

1. `verifyEventChain` is self-contained — does not call `llmtxt/events.verifyHashChain`
   because that function does not exist in the installed llmtxt version. The DESIGN.md
   reference to it is aspirational; the implementation owns the chain logic directly.

2. TSA client is injected via optional parameter rather than module-level replacement,
   avoiding ESM spy limitations (named exports in ESM cannot be spied via vi.spyOn
   when called from within the same module).

3. Full ASN.1 response parsing is deferred (documented as follow-up). The
   TimeStampResp DER bytes are stored opaquely as base64 — sufficient for
   tamper-evidence purposes.

4. `tsa_anchor` kind was added to the SentientEventKind union and
   SentientEvent discriminated union in events.ts (T1022 foundation).

## Follow-ups

- Full ASN.1 decode of TimeStampResp to extract tsaTime field.
- `cleo audit anchor` CLI verb (requires wiring AuditHandler).
- T1024 (baseline.ts) was already implemented as part of T1021 — task status
  reflects incomplete verification gates, not missing implementation.
