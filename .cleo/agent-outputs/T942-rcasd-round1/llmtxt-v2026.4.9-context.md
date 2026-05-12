# llmtxt v2026.4.9 Context (fetched 2026-04-18 from issue #96 comment)

## New stable subpaths shipped in v2026.4.9

| Subpath | Exports | Status |
|---|---|---|
| `llmtxt/blob` | `BlobFsAdapter`, `BlobPgAdapter`, `attachBlob`, `getBlob`, `listBlobs`, `detachBlob`, `hash_blob`, `blob_name_validate` | ✅ Shipped (T607/T621-626) |
| `llmtxt/events` | `appendEvent`, `queryEvents`, `verifyHashChain`, `DocumentEvent` types | ✅ Shipped (T608/T627-638) |
| `llmtxt/identity` | `AgentIdentity`, `generateIdentity`, `signRequest`, `verifySignature`, canonicalize helpers, nonce helpers | ✅ Shipped (T609/T642-653) |
| `llmtxt/transport` | `UnixSocketTransport`, `HttpTransport`, `PeerTransport`, `handshake` helpers | ✅ Shipped (T610/T657-664) |

## Pre-existing subpaths (still stable)

| Subpath | Exports | Notes |
|---|---|---|
| `llmtxt` | `createBackend`, `Backend`, `generateOverview`, `planRetrieval` | SemVer stable |
| `llmtxt/sdk` | `AgentSession`, `AgentSessionError`, `AgentSessionState`, `ContributionReceipt`, `LlmtxtDocument` | SemVer stable (contract tests added T665 v2026.4.9) |
| `llmtxt/local` | `LocalBackend` | Peer-dep-gated (better-sqlite3 + drizzle-orm) |
| `llmtxt/remote` | `RemoteBackend` | SemVer stable |
| `llmtxt/embeddings` | `embed`, `embedBatch`, `MODEL_DIMS` | Peer-dep-gated (onnxruntime-node) |
| `llmtxt/crdt` / `llmtxt/crdt-primitives` | Loro wrappers: `crdt_new_doc`, `crdt_merge_updates`, etc. | SemVer stable (T666 v2026.4.9) |
| `llmtxt/similarity`, `/graph`, `/disclosure` | Content-intelligence helpers | SemVer stable (T667 v2026.4.9) |

## Stability contract (STABILITY.md in llmtxt repo)

1. SemVer-within-CalVer: no breaking change in patch releases
2. Peer-dep optional status preserved (no forced install)
3. Contract-test suite runs in CI; per-subpath `.d.ts` snapshots in `packages/llmtxt/.dts-snapshots/`
4. Deprecations get one minor-version notice before removal
5. CLEO listed as a reference consumer (see `docs/cleo-migration-guide.md` in llmtxt repo)

## Owner's four hard constraints (NON-NEGOTIABLE)

1. **Clear separation of concerns** — llmtxt = content domain; CLEO = engineering tasks domain. Neither imports the other's domain types.
2. **llmtxt MUST stand alone** — no runtime dep on CLEO, ever.
3. **CLEO MUST be able to use 100% of llmtxt's capabilities** — if missing, llmtxt adds a subpath rather than CLEO vendoring.
4. **ZERO duplication for primitives** — if llmtxt ships a primitive, CLEO does NOT ship its own.

## Zero-duplication migration table (owner's canonical)

| CLEO surface | Keep (user-facing) | Replace under the hood | Delete |
|---|---|---|---|
| `cleo docs add/list/fetch/remove` | CLI shape identical | `BlobFsAdapter` from `llmtxt/blob` (inject storagePath from CLEO config) | Custom refCount store in `.cleo/attachments/` |
| `cleo docs generate` | CLI shape identical | `generateOverview` from `llmtxt` (silent-fallback bug fixed in 4.8) | Built-in fallback `generateBuiltInLlmsText()` |
| `cleo session start/end` | CLI shape identical | Wrap CLEO session with `AgentSession` from `llmtxt/sdk`; receipt → brain memory | nothing (AgentSession augments CLEO session) |
| `cleo complete T###` | CLI shape identical | Wrap in `session.contribute(...)`; receipt → audit log | `.cleo/audit/force-bypass.jsonl` old format (replaced by signed ContributionReceipt) |
| `cleo bug` | CLI shape identical | `signRequest` from `llmtxt/identity` for severity attestation | Ad-hoc signing code path |
| `cleo nexus sync` | CLI shape identical | `getChangesSince` / `applyChanges` from `llmtxt/crdt` via LocalBackend if CLEO opts into cr-sqlite brain; else event log sync from `llmtxt/events` | Custom JSON-registry diff logic |
| `cleo memory observe` | CLI shape identical | NO CHANGE — CLEO-owned BRAIN domain | n/a |

## v2026.4.9 extras (same release, useful context)

- **Tamper-evident audit log with Merkle chain + RFC 3161 external timestamp anchor** at `GET /api/v1/audit/verify` — CLEO's `force-bypass.jsonl` can move to this format. **PERFECT for T946 Tier 3 autonomy kill switch.**
- **PostgreSQL RLS on 21 tenant-scoped tables** via `withRlsContext` — relevant if CLEO brain runs on Postgres.
- **Ed25519 per-agent key rotation + KMS abstraction** (env / Vault / AWS adapters) — **PERFECT for T946 Ed25519 design.**
- **GDPR data export** (deterministic, byte-identical Rust+WASM) + retention policy DSL + right-to-erasure that pseudonymizes rather than hard-deletes audit entries.
- **Strict release runbook** at `RELEASING.md` (CHANGELOG gate, OIDC-only publish, `PUBLISH_ONLY_IN_CI`, migration gates).
- **OpenAPI 3.1 spec** auto-generated at `https://api.llmtxt.my/openapi.json` + Swagger UI at `/docs/api` — relevant for T948 REST design.

## Adoption order (from issue #96, updated for v2026.4.9)

| Step | Change | Risk | Effort |
|---|---|---|---|
| 0 | Bump to `llmtxt@^2026.4.9`, rebuild | none | 5 min |
| 1 | Adopt `BlobFsAdapter` from `llmtxt/blob` for `cleo docs add/fetch/remove` (feature flag) | low | ~1 day |
| 2 | Wrap `cleo session start` + `cleo complete` with `AgentSession` from `llmtxt/sdk` | medium | ~2 days |
| 3 | Add `cleo roadmap --format md` via `backend.exportDocument` | none | ~2 hours |
| 4 | Adopt `llmtxt/events` + Merkle-chain audit for `.cleo/audit/` — replaces force-bypass.jsonl | medium | ~2 days |
| 5 | Adopt `llmtxt/identity` (Ed25519 keypair + KMS abstraction) — replace ad-hoc cleo bug signing | low | ~1 day |
| 6 | Opt-in CRR mode for multi-device brain via `llmtxt/crdt` + `@vlcn.io/crsqlite` | low | ~1 day |
| 7 | Replumb `cleo nexus` on `hub-spoke topology` (via `llmtxt/transport` + `/events`) | medium | ~3 days |
| 8 | Optional P2P mesh for on-prem (via `llmtxt/transport` mesh peers) | high | ~1 week |

## Impact on T942 sibling epics

- **T946 Autonomy**: Use `llmtxt/identity` for Ed25519 + KMS; use `llmtxt/events` Merkle-chain + RFC3161 timestamp as the receipts.jsonl replacement. This is no longer "design signing infra" — it's "wire `llmtxt/identity` into `cleo sentient sign`".
- **T948 SDK**: Mirror llmtxt's STABILITY.md contract pattern (SemVer-within-CalVer, per-subpath contract tests, `.d.ts` snapshots). `@cleocode/cleo-sdk` becomes the CLEO-side peer of `llmtxt/sdk`.
- **T943 SSoT**: `llmtxt/events` gives us an append-only hash-chained event log — could be the substrate for Option C (evidence atoms)!
- **T944 Ontology**: No direct impact.
- **T945 Graph**: Consider if `llmtxt/graph` helpers are useful for brain_page_edges traversal.

## References

- GitHub issue #96 main body: v2026.4.8 adoption
- GitHub issue #96 comment (2026-04-18 edit): v2026.4.9 subpath design + status
- llmtxt STABILITY.md: https://github.com/kryptobaseddev/llmtxt/blob/main/packages/llmtxt/STABILITY.md
- llmtxt cleo migration guide: https://github.com/kryptobaseddev/llmtxt/blob/main/docs/cleo-migration-guide.md
- llmtxt OpenAPI: https://api.llmtxt.my/openapi.json
