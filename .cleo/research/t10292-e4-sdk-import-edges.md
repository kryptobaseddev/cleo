# T10354 (E4.2): llmtxt SDK Import-Edge Audit

**Saga**: T10288 SG-DOCS-INTEGRITY (Wave 1)
**Epic**: T10292 E4-DOCS-SDK-BOUNDARY
**Scope**: Every non-test `from 'llmtxt/...'` import in `packages/{cleo,core,contracts}/src/`
**Date**: 2026-05-23
**Author**: cleo-worker (T10354)

## Context

Saga SG-DOCS-INTEGRITY closes the docs-side gaps left by Saga T9625. Epic T10292
classifies which `llmtxt` consumption is CLEO-using-SDK (our composition over the
SDK, owned by us) versus llmtxt SDK proper (owned upstream). This audit catalogues
the import-edge surface so E4.x downstream tasks can:

1. Decide which SDK types must be re-shaped through `packages/contracts/` rather
   than re-exported raw from `packages/core/src/`.
2. Confirm the `peerDependenciesMeta` posture matches the dynamic-vs-static
   import distribution we actually use.
3. Drive the boundary classification specified by ADR-078 §SDK-classification.

Only **static** `import ... from 'llmtxt/...'` and **dynamic** `await import('llmtxt/...')`
edges in non-test source files are considered. Test files (`__tests__/`, `*.test.ts`,
`*.spec.ts`) and JSDoc-only `{@link import('llmtxt/...')...}` references are excluded.

## Edge inventory — static imports

| # | File:line | Imported Symbol(s) | SDK Subpath | Classification | Surface | Leakage Risk |
|---|-----------|--------------------|-------------|---------------|---------|--------------|
| 1 | packages/core/src/docs/docs-ops.ts:22 | `KnowledgeGraph`, `MessageInput` | `llmtxt/graph` | type-only | **public** (via `core/docs/index.ts`) | **YES** — `DocsGraphResult.raw: KnowledgeGraph` re-exported |
| 2 | packages/core/src/docs/docs-ops.ts:23 | `ReconstructionResult`, `VersionDiffSummary`, `VersionEntry` | `llmtxt/sdk` | type-only | internal (used inside fn bodies only) | NO — not re-exported |
| 3 | packages/core/src/docs/docs-ops.ts:24 | `SimilarityRankResult` | `llmtxt/similarity` | type-only | internal | NO |
| 4 | packages/core/src/identity/cleo-identity.ts:33 | `AgentIdentity` (value), `identityFromSeed` (value), `verifySignature` (value) | `llmtxt/identity` | function-call + extends | **public** (re-exported by `core/identity/index.ts` and `core/src/index.ts:291`) | **YES** — `AgentIdentity` class is the canonical signing-identity public type |
| 5 | packages/core/src/sentient/events.ts:43 | `AgentIdentity` | `llmtxt/identity` | type-only | **public** (via `core/sentient/index.ts` re-export of `events.js`) | **YES** — `appendSentientEvent(projectRoot, identity: AgentIdentity, ...)` |
| 6 | packages/core/src/sentient/revert-executor.ts:30 | `AgentIdentity` | `llmtxt/identity` | type-only | **public** (via `core/sentient/index.ts`) | **YES** — `RevertOptions.identity: AgentIdentity` |
| 7 | packages/core/src/sentient/kms.ts:30 | `AgentIdentity` | `llmtxt/identity` | type-only | **public** (via `core/sentient/index.ts`); explicit `export type { AgentIdentity }` at kms.ts:346 | **YES** — `loadSigningIdentity(): Promise<AgentIdentity>` (and 3 sister loaders) |
| 8 | packages/core/src/sentient/kms.ts:31 | `identityFromSeed` (value) | `llmtxt/identity` | function-call | internal helper | NO (value, not re-exported) |
| 9 | packages/core/src/sessions/agent-session-adapter.ts:46 | `AgentSession`, `ContributionReceipt` | `llmtxt/sdk` | type-only | **public** (via `core/sessions/index.ts`) | **YES** — `AgentSessionHandle.session: AgentSession` and `WrappedResult<T>.receipt: ContributionReceipt \| null` are exported |
| 10 | packages/core/src/store/llmtxt-blob-adapter.ts:33 | `AttachBlobParams`, `BlobAttachment`, `BlobData` | `llmtxt/blob` | type-only | public (file-level `export type` re-exports at line 47) | **YES** — re-exported directly (`export type { AttachBlobParams, BlobAttachment, BlobData };`) — note: NOT surfaced through `core/src/index.ts` barrel but importable via deep path |
| 11 | packages/core/src/store/llmtxt-blob-adapter.ts:34-42 | `BlobAccessDeniedError`, `BlobCorruptError`, `BlobFsAdapter`, `BlobNameInvalidError`, `BlobNotFoundError`, `BlobTooLargeError`, `hashBlob` (values) | `llmtxt/blob` | function-call + extends | public (file-level error class re-exports at line 48) | **YES** — error classes re-exported so callers catch them without depending on llmtxt directly |

**Static import edges**: 11 rows across 7 source files. All edges live in
`packages/core/src/` — `packages/cleo/src/` and `packages/contracts/src/` have
**zero** direct `from 'llmtxt'` imports.

## Edge inventory — dynamic imports (non-test)

| # | File:line | Dynamic Specifier | Purpose |
|---|-----------|-------------------|---------|
| D1 | packages/core/src/docs/docs-generator.ts:69 | `import('llmtxt')` | Optional formatter for `llms.txt` generation |
| D2 | packages/core/src/docs/docs-ops.ts:212 | `import('llmtxt/similarity')` | `rankBySimilarity` in `searchDocs` |
| D3 | packages/core/src/docs/docs-ops.ts:378 | `import('llmtxt/similarity')` | `rankBySimilarity` in `searchAllProjectDocs` |
| D4 | packages/core/src/docs/docs-ops.ts:497 | `import('llmtxt/sdk')` | `squashPatches` + `diffVersions` + `reconstructVersion` in `mergeDocs` |
| D5 | packages/core/src/docs/docs-ops.ts:582 | `import('llmtxt/graph')` | `buildGraph` in `buildDocsGraph` |
| D6 | packages/core/src/docs/docs-ops.ts:658 | `import('llmtxt/similarity')` | `rankBySimilarity` in `rankDocs` |
| D7 | packages/core/src/docs/export-document.ts:180 | `import('llmtxt')` | `hashContent` for body sha |
| D8 | packages/core/src/docs/export-document.ts:193 | `import('llmtxt')` | `formatMarkdown` for canonical frontmatter |
| D9 | packages/core/src/sentient/events.ts:503 | `import('llmtxt/identity')` | `verifySignature` for event-chain replay |
| D10 | packages/core/src/sentient/state.ts:448 | `import('llmtxt/identity')` | `verifySignature` for owner-attestation check |
| D11 | packages/core/src/sessions/agent-session-adapter.ts:160-163 | `import('llmtxt')` + `import('llmtxt/sdk')` | `createBackend` + `AgentSession` ctor (lazy peer-dep load) |
| D12 | packages/core/src/store/attachment-store-v2.ts:136 | `import('llmtxt/blob')` | Peer-dep probe (`canUseLlmtxtBackend`) — degrade gracefully |

**Dynamic import edges**: 12 rows. All gated by either `try/catch` (D1, D7, D8, D11, D12)
or the `throwUnavailable('llmtxt/...', cause)` helper at `docs-ops.ts:43` (D2-D6).

## Wrappers — composition density

CLEO owns 4 adapter/wrapper modules over the llmtxt SDK. The classification below
captures whether the wrapper is **thin** (1:1 method mirror, no fused logic) or
**thick** (multiple SDK calls fused with CLEO-side persistence / fallback).

### `packages/core/src/identity/cleo-identity.ts` (285 LOC)

- **SDK methods wrapped**: `AgentIdentity` (class), `identityFromSeed` (factory),
  `verifySignature` (verifier).
- **CLEO additions**: persistence to `<projectRoot>/.cleo/keys/cleo-identity.json`
  (mode 0o600); deterministic-seed override via `CLEO_IDENTITY_SEED`; cached
  in-process per `projectRoot`; `signAuditLine` / `verifyAuditLine` helpers that
  serialise an audit JSONL line into the canonical signing-bytes shape.
- **Density**: **thick** — adds persistence, ENV override, and canonical JSONL
  signing shape on top of the SDK's pure-crypto primitives.
- **Surface area**: 1 class + 5 exported functions + 2 exported interfaces
  (`CleoIdentityFile`, `AuditSignature`). Public via both
  `core/identity/index.ts` and `core/src/index.ts:289-298`.

### `packages/core/src/store/llmtxt-blob-adapter.ts` (380 LOC)

- **SDK methods wrapped**: `BlobFsAdapter` (class), `attachBlob`, `listBlobs`,
  `hashBlob`, plus 5 error classes (`BlobAccessDeniedError`, `BlobCorruptError`,
  `BlobNameInvalidError`, `BlobNotFoundError`, `BlobTooLargeError`).
- **CLEO additions**: `CleoBlobStore` class (the actual wrapper) that owns
  the SQLite manifest DB lifecycle (lazy `node:sqlite` + `drizzle-orm/node-sqlite`
  load), default `<projectRoot>/.cleo/blobs/` layout, and the `CleoBlobStoreOptions`
  shape that hides BlobFsAdapter's internal `blobs/<sha>` subdir convention.
- **Density**: **thick** — owns DB lifecycle + injection; the wrapper class is
  ~178 LOC of CLEO logic gluing the SDK's `BlobFsAdapter` to CLEO's project layout.
- **Surface area**: 1 class + 1 static method (`CleoBlobStore.hash`) + 4 exported
  result interfaces. NOT in `core/src/index.ts` barrel — importable only via
  deep path `@cleocode/core/store/llmtxt-blob-adapter`.

### `packages/core/src/sessions/agent-session-adapter.ts` (355 LOC)

- **SDK methods wrapped**: `createBackend` (`topology: 'standalone'`),
  `AgentSession` ctor, `session.open()`, `session.contribute()`, `session.close()`,
  `backend.close()`.
- **CLEO additions**: `<projectRoot>/.cleo/llmtxt/` backend storage; lazy peer-dep
  load that degrades to `null` (NEVER throws); appends `ContributionReceipt` to
  `.cleo/audit/receipts.jsonl` alongside other ADR-051 artifacts; `WrappedResult<T>`
  envelope with always-present `result` and nullable `receipt`.
- **Density**: **thick** — multi-call fusion (`createBackend → backend.open → new AgentSession → session.open`)
  with a global degrade-to-null path and a JSONL persistence hook.
- **Surface area**: 4 exported functions (`openAgentSession`, `closeAgentSession`,
  `wrapWithAgentSession`, `getReceiptsAuditPath`) + 3 exported interfaces. Public
  via `core/sessions/index.ts`. **Both `AgentSessionHandle.session: AgentSession`
  and `WrappedResult<T>.receipt: ContributionReceipt | null` directly re-export
  SDK types in their public shape.**

### `packages/core/src/docs/docs-ops.ts` (1306 LOC)

- **SDK methods wrapped**: `rankBySimilarity` (3 call sites), `squashPatches`,
  `diffVersions`, `reconstructVersion`, `buildGraph`.
- **CLEO additions**: project-root resolution + attachment-store loading + blob
  reading + result-shape normalisation; per-primitive `throwUnavailable('llmtxt/...', cause)`
  error wrapper that promotes a bare module-not-found into a typed
  `LLMTXT_PRIMITIVE_UNAVAILABLE` Error (code field + REQUIRED_LLMTXT_VERSION
  install hint at line 47).
- **Density**: **thick** — each public function wires the SDK primitive into the
  attachment-store + blob-ops surface; `DocsGraphResult.raw: KnowledgeGraph` is
  the only place where the SDK type is re-shaped INTO a CLEO result envelope
  rather than hidden inside the function body.
- **Surface area**: 10 exported functions + 16 exported result interfaces (mostly
  CLEO-shaped envelopes — the **only** raw SDK-type re-export is
  `DocsGraphResult.raw: KnowledgeGraph`). Public via `core/docs/index.ts`.

## `peerDependenciesMeta` posture

| Package | Declared block | Version constraint | Posture |
|---------|---------------|--------------------|---------|
| `packages/contracts/package.json` | none — zero llmtxt reference | — | **No SDK dependency at all** (correct — contracts is the leaf) |
| `packages/core/package.json` | `optionalDependencies` (NOT `peerDependencies`) | `"llmtxt": "^2026.4.13"` | **Optional install** — pnpm/npm install will succeed when llmtxt isn't resolvable; runtime code MUST guard via `try/catch` or `throwUnavailable` |
| `packages/cleo/package.json` | `dependencies` (HARD dep) | `"llmtxt": "^2026.4.13"` | **Hard install dep at the CLI tier**; `peerDependenciesMeta` block exists only for `@cleocode/core` (non-optional) |

**Posture summary**: SDK is treated as **mandatory at the CLI shipping tier**
(`@cleocode/cleo`) but **optional at the SDK tier** (`@cleocode/core`). The asymmetry
is intentional: downstream consumers can adopt `@cleocode/core` without dragging
in llmtxt's tree, and `@cleocode/core` code MUST degrade when the SDK is absent.

## Degraded-mode paths — what happens when llmtxt is absent?

Two distinct degradation classes, partitioned by edge:

### Class A — hard-throw via `throwUnavailable('llmtxt/<sub>', cause)`

All 5 docs-ops dynamic edges (D2-D6) and any caller path that lands in
`docs-ops.ts` will throw `LLMTXT_PRIMITIVE_UNAVAILABLE` with a structured
`{ code, cause, message }` shape (lines 43-52). Callers must handle the typed
error explicitly — there is no silent fallback for similarity, merge, or graph
operations.

### Class B — degrade-to-null / fallback

- `agent-session-adapter.ts:166` (D11) — both lazy SDK imports wrapped in
  `try/catch`; returns `null` from `openAgentSession`. `wrapWithAgentSession`
  always returns `{ result, receipt: null }` (never throws).
- `docs-generator.ts:69` (D1) — surrounded by `try/catch` (verified at lines
  61-76 in source); falls back to a CLEO-side renderer.
- `export-document.ts:180` (D7) — `try/catch` falls back to a deterministic
  char-code-sum hash (line 184).
- `export-document.ts:193` (D8) — `try/catch` falls back to a CLEO-side
  markdown template.
- `attachment-store-v2.ts:136` (D12) — peer-dep probe inside `canUseLlmtxtBackend()`
  returns `false` when llmtxt is absent; legacy attachment-store path is used.
- `sentient/events.ts:503` (D9) and `sentient/state.ts:448` (D10) — `verifySignature`
  is invoked WITHOUT a guard. **If llmtxt is absent at runtime, both throw a
  bare `MODULE_NOT_FOUND` rather than `LLMTXT_PRIMITIVE_UNAVAILABLE`** — minor
  inconsistency with Class A (see Finding F-2 below).

### Static imports — no degradation at all

All 11 static-import edges (rows 1-11 in the inventory) crash module-load if
llmtxt is missing. This is the import-graph reality of `optionalDependencies`:
the optional flag suppresses install failures but does NOT suppress
`ERR_MODULE_NOT_FOUND` at module-init time when the static import is evaluated.
Any code path that touches `core/docs/docs-ops.ts`, `core/identity/cleo-identity.ts`,
`core/sentient/{events,kms,revert-executor}.ts`, `core/sessions/agent-session-adapter.ts`,
or `core/store/llmtxt-blob-adapter.ts` will fail-fast at first import.

## Findings

1. **F-1 (high)**: `AgentIdentity` is leaked through 4 different public surfaces
   (`core/src/index.ts:291`, `core/identity/index.ts`, `core/sentient/kms.ts:346`,
   indirectly via `sentient/index.ts`). Any future change to llmtxt's `AgentIdentity`
   shape will ripple through CLEO's public type-graph. **Remediation**: define a
   `CleoSigner` interface in `packages/contracts/src/identity/` that captures the
   minimal `sign`/`pub`/`verify` contract CLEO actually uses; have `cleo-identity.ts`
   adapt the SDK class to that contract.

2. **F-2 (high)**: `DocsGraphResult.raw: KnowledgeGraph` at `docs-ops.ts:129`
   directly embeds the SDK type in a public CLEO result envelope. This forces
   every downstream consumer of `buildDocsGraph` (CLI + Studio + any future agent)
   to depend on `llmtxt/graph` type-resolution at build time. **Remediation**:
   either drop the `raw` field (callers should re-build via the SDK directly if
   they need it) or replace it with a `KnowledgeGraphSerialized` JSON shape
   defined in `packages/contracts/src/docs/`.

3. **F-3 (high)**: `AgentSessionHandle.session: AgentSession` and
   `WrappedResult<T>.receipt: ContributionReceipt | null` in
   `agent-session-adapter.ts:96-123` leak the SDK runtime + receipt types through
   `core/sessions/index.ts`. **Remediation**: treat the handle as `unknown` /
   opaque-symbol-tagged and provide CLEO-shaped `CleoContributionReceipt` in
   contracts (the file's own JSDoc at line 92 already warns "treating the inner
   `session` field as public API is UNSUPPORTED").

4. **F-4 (med)**: `sentient/events.ts:503` and `sentient/state.ts:448` invoke
   `verifySignature` via dynamic import WITHOUT the `throwUnavailable` wrapper
   used by `docs-ops.ts`. Failure mode is inconsistent with the docs-ops policy.
   **Remediation**: route through a `core/identity/verify.ts` shim that mirrors
   `throwUnavailable`'s error shape.

5. **F-5 (med)**: `optionalDependencies` posture in `@cleocode/core` is misleading
   because 11 static imports crash module-load on absence. `optionalDependencies`
   only affects install resolution, not runtime imports. **Remediation**: either
   convert the 11 static imports to dynamic (with try/catch) OR promote
   `llmtxt` to a hard `dependencies` entry in `@cleocode/core` and drop the
   `optionalDependencies` block — pick one posture and document it in ADR-078.

6. **F-6 (low)**: `packages/cleo/src/` and `packages/contracts/src/` are
   already clean — zero direct `from 'llmtxt'` imports. CLI commands reference
   llmtxt only in comments / docstrings. The leakage surface to remediate is
   entirely inside `@cleocode/core`.

7. **F-7 (low)**: `store/llmtxt-blob-adapter.ts:47-54` re-exports 3 SDK types
   and 5 SDK error classes at file-level. These are NOT surfaced through
   `core/src/index.ts` but ARE reachable via deep path
   `@cleocode/core/store/llmtxt-blob-adapter`. Treat as deep-path leakage for
   the boundary classification — either accept (deep paths are best-effort
   public) or move re-exports behind a `CleoBlobError` discriminated union.

8. **F-8 (info)**: 12 dynamic-import edges split between two failure policies
   (`throwUnavailable` vs `try/catch → null/fallback`). The policy boundary
   correlates cleanly with "is the operation required for correctness"
   (docs-ops: required → throw) vs "is the operation a degrade-able audit signal"
   (sessions, hashing, formatting: optional → fallback). Document the policy
   matrix in ADR-078 so future SDK calls land in the right bucket.

9. **F-9 (info)**: All 4 wrappers are **thick** — none is a 1:1 mirror. This
   means the wrap surface is large enough to be its own design responsibility
   (justifying CLEO-side abstraction) but small enough that re-shaping the
   leaked types is tractable in 3-5 PRs.

10. **F-10 (info)**: The 1-line summary of the boundary: **CLEO owns the
    persistence + degradation + fallback story**; **llmtxt owns the
    cryptographic / similarity / graph / merge primitives**. The current
    public-surface leaks (F-1, F-2, F-3, F-7) all originate from CLEO exporting
    raw SDK return-types in result envelopes rather than re-shaping them
    through `packages/contracts/`.

## Recommended next tasks (for E4.3+)

- **E4.3a**: define `CleoSigner` + `CleoContributionReceipt` +
  `CleoKnowledgeGraphSerialized` contracts in `packages/contracts/src/`. Close F-1, F-2, F-3.
- **E4.3b**: resolve the `optionalDependencies` vs static-import inconsistency
  per F-5 — file a follow-up against ADR-078.
- **E4.3c**: introduce `core/identity/verify.ts` shim for F-4 to unify the
  degraded-mode error policy.
- **E4.3d**: decide on deep-path vs barrel posture for `llmtxt-blob-adapter` (F-7).

## References

- ADR-078 — SDK Boundary Classification
- ADR-083 — Hierarchy + Sentient Substrate Frame (saga substrate)
- ADR-051 — Gate Integrity & Evidence (consumer of `ContributionReceipt`)
- ADR-054 (draft) — Sentient Loop Tier-1 (consumer of `AgentIdentity`)
- Saga T9625 — Docs SSoT (predecessor)
- Epic T947 — llmtxt SDK adoption (origin of all 4 wrappers)
