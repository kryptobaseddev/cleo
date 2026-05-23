# T10292 E4.3 — Gap Verdicts (CLEO vs SDK Responsibility)

**Saga**: T10288 SG-DOCS-INTEGRITY (Wave 2) · **Epic**: T10292 E4-DOCS-SDK-BOUNDARY
**Task**: T10355 · **Author**: cleo-prime · **Date**: 2026-05-23

## Context

Wave 1 of E4 produced two audits: T10353 (CLI verb matrix, PR #578) catalogued
21 `cleo docs` + `cleo changeset` subcommands and their dispatch / SDK / DocKind
shapes; T10354 (SDK import-edge surface, PR #577) catalogued 11 static + 12
dynamic `llmtxt/*` imports across `packages/{cleo,core,contracts}/src/`. This
task closes the loop by classifying each gap as `CLEO`, `SDK`, or `shared`
responsibility — with file:line evidence — so the remediation Epics in this
saga (E1 / E2 / E3 / E5) can target the right layer.

The four reference gaps in scope: **T10238** (unknown-flag silent absorb),
**T10153** (no ADR auto-numbering), **T10167** (no similarity warn pre-add),
**T10294** (`cleo changeset add` slug collision with `cleo docs add --type
changeset`). Plus six additional gaps surfaced by the audits: **F-1**
(`AgentIdentity` re-export sprawl), **F-2** (`DocsGraphResult.raw:
KnowledgeGraph`), **F-3** (`AgentSessionHandle.session: AgentSession` +
`WrappedResult.receipt: ContributionReceipt`), **F-4** (degraded-mode error
policy split), **F-5** (`optionalDependencies` vs static-import asymmetry),
**T10353/F8** (`docs publish` ledger best-effort writes), **T10353/F9**
(`changeset list` reads filesystem mirror only).

## Verdict matrix

| Gap ID | Symptom | Location (file:line) | Owner Verdict | Rationale | Remediation Pointer |
|---|---|---|---|---|---|
| **T10238** | `cleo docs add --unknown-flag x` silently absorbs `x` as the `file` positional. Same hazard repeats on ~8 other verbs that mix positional + optional flags. | `packages/cleo/src/cli/commands/docs.ts:172-249` (citty `defineCommand` arg schema) — citty 0.2.1 hard-codes `parseArgs({ strict: false })` with no public knob. | **CLEO** | Failure happens inside CLEO's CLI shell BEFORE any llmtxt call is reached. citty is the parser CLEO chose; the SDK is never invoked on a malformed invocation. Fix landed via `packages/cleo/src/cli/lib/strict-args.ts:assertKnownFlags` (commit 608b79ab4, T10359). | **CLOSED** by T10359 (already merged main); Epic **E3-DOCS-CLI-HARDENING** (T10291) absorbs the broader sweep across other verbs with `cli-boundary-ok` annotations. |
| **T10153** | `cleo docs add --type adr --slug adr-NNN-foo` requires the operator to hand-pick `NNN` — no `SELECT MAX(entity_id)` lookup, no auto-increment. | DocKind definition `packages/contracts/src/docs-taxonomy.ts:120-128` (`entityIdPattern: /^adr-\d{3,4}-[a-z0-9-]+$/`); dispatch `add` handler `packages/cleo/src/dispatch/domains/docs.ts:822-880` passes the user-supplied slug through unchanged. | **CLEO** | DocKind taxonomy is CLEO's contracts surface, dispatch handler is CLEO's wrapper. llmtxt SDK has zero awareness of ADR semantics or auto-numbering (`/mnt/projects/cleocode/node_modules/llmtxt/dist/blob/changeset.d.ts:64` treats `slug` as a scoping string, never an allocatable namespace). The fix is one query against `attachment_refs` before `store.put`. | Epic **E3-DOCS-CLI-HARDENING** (T10291) absorbs T10157 → T10159 (atomic next-number resolver). Implementation lives in the dispatch handler, not the SDK. |
| **T10167** | No "this looks like an existing doc" warning when `cleo docs add` is invoked with text similar to an existing same-kind doc. The primitive (`rankBySimilarity`) is available and used by 3 other verbs. | `packages/cleo/src/cli/commands/docs.ts:172-249` (no similarity scan before `dispatchFromCli`); SDK primitive available at `packages/core/src/docs/docs-ops.ts:578-660` (`rankDocs`) and `:175-220` (`searchDocs`). | **CLEO** | The SDK's `rankBySimilarity` IS the primitive needed — it works. The gap is purely orchestration: CLEO chose not to call it pre-`store.put`. Adding a `--no-similarity-warn` opt-out + a pre-add similarity scan is a CLEO-side wrapper concern. | Epic **E3-DOCS-CLI-HARDENING** (T10291) absorbs T10163. Implementation: extend dispatch `add` handler to invoke existing `rankBySimilarity` pre-write and emit a non-fatal hint. Zero SDK changes. |
| **T10294** | `cleo changeset add` and `cleo docs add --type changeset` race on the same `(projectId, slug)` namespace via two independent code paths converging on `attachment_refs`. | Path A: `packages/cleo/src/dispatch/domains/docs.ts:822-960` → `createAttachmentStore().put(..., {slug, type})`. Path B: `packages/core/src/changesets/writer.ts:170-293` → SAME `createAttachmentStore().put(..., {slug: validated.id, type: 'changeset'})`, bypassing dispatch entirely. Path C: `packages/core/src/docs/import/slug.ts:1-150` runs ITS OWN `-2`/`-3` collision chain before `store.put`. | **CLEO** | Three independent slug-allocator surfaces, ONE shared underlying table. llmtxt does not define an `allocateSlug` / `reserveSlug` primitive (verified: `grep -rn 'allocateSlug\|reserveSlug' /mnt/projects/cleocode/node_modules/llmtxt/dist/` → 0 hits). Slug uniqueness is application-level — CLEO's responsibility to centralise. | Epic **E1-DOCS-SLUG-NAMESPACE** (T10289) — central allocator behind one entry point with `E_SLUG_RESERVED`. The bug-triage spike for T10294 (filed as P2 under E1) informs the design. |
| **F-1 (T10354)** | `AgentIdentity` (llmtxt class) re-exported through 4 public CLEO surfaces — any SDK shape change ripples through CLEO's type graph. | `packages/core/src/identity/cleo-identity.ts:33`, `packages/core/src/sentient/events.ts:43`, `packages/core/src/sentient/revert-executor.ts:30`, `packages/core/src/sentient/kms.ts:30+346` (explicit `export type { AgentIdentity }`). | **shared (CLEO-led)** | The SDK's `AgentIdentity` shape is intentionally public — llmtxt owns the crypto contract. But CLEO chose to re-export it directly rather than re-shape it through `packages/contracts/`. The fix lives entirely in CLEO (define a `CleoSigner` interface in contracts that captures the minimal `sign`/`pub`/`verify` shape CLEO actually uses), but the underlying primitive STAYS in the SDK. | Epic **E4-DOCS-SDK-BOUNDARY** (T10292) — define `CleoSigner` in `packages/contracts/src/identity/`; have `cleo-identity.ts` adapt. No upstream issue needed. |
| **F-2 (T10354)** | `DocsGraphResult.raw: KnowledgeGraph` directly embeds the SDK type in a public CLEO result envelope, forcing every downstream consumer to depend on `llmtxt/graph` at build time. | `packages/core/src/docs/docs-ops.ts:128-129` (`readonly raw: KnowledgeGraph;` field). | **CLEO** | The SDK's `KnowledgeGraph` is fine in isolation — the leak is purely a CLEO API-design choice. Either drop the field (callers re-build via the SDK directly) or replace it with a `KnowledgeGraphSerialized` JSON shape in contracts. | Epic **E4-DOCS-SDK-BOUNDARY** (T10292) — re-shape `DocsGraphResult` so the public envelope contains no raw SDK types. |
| **F-3 (T10354)** | `AgentSessionHandle.session: AgentSession` and `WrappedResult<T>.receipt: ContributionReceipt \| null` leak SDK runtime + receipt types through `core/sessions/index.ts`. The file's own JSDoc already warns this is UNSUPPORTED. | `packages/core/src/sessions/agent-session-adapter.ts:90-123` (interfaces + JSDoc warning at L92-95). | **CLEO** | The wrapper file itself documents this as unsupported public access. The SDK type is opaque-by-design; the leak is purely CLEO's choice to surface it through the barrel. Replace with `unknown` / opaque-symbol tag + a CLEO-shaped `CleoContributionReceipt` in contracts. | Epic **E4-DOCS-SDK-BOUNDARY** (T10292) — make `AgentSessionHandle.session` opaque; define `CleoContributionReceipt` in contracts. |
| **F-4 (T10354)** | `sentient/events.ts:503` + `sentient/state.ts:448` invoke `verifySignature` via dynamic `import('llmtxt/identity')` WITHOUT the `throwUnavailable` wrapper used by `docs-ops.ts:43`. Failure mode differs from rest of SDK boundary. | `packages/core/src/sentient/events.ts:503`, `packages/core/src/sentient/state.ts:448`. | **CLEO** | The SDK behaves correctly — it throws `MODULE_NOT_FOUND` when absent, which is exactly what `throwUnavailable` was built to normalise into `LLMTXT_PRIMITIVE_UNAVAILABLE`. The inconsistency is CLEO's: two sites chose to skip the wrapper. | Epic **E4-DOCS-SDK-BOUNDARY** (T10292) — introduce `core/identity/verify.ts` shim that mirrors `throwUnavailable`'s shape; convert both sites. |
| **F-5 (T10354)** | `@cleocode/core/package.json` declares `llmtxt` under `optionalDependencies`, but 11 static imports crash module-load if llmtxt is missing. `optionalDependencies` only affects install resolution, not runtime imports — posture is internally inconsistent. | `packages/core/package.json` (`optionalDependencies` block); static-import sites at audit rows 1-11 (all in `packages/core/src/{docs,identity,sentient,sessions,store}/`). | **CLEO** | This is a packaging-posture decision CLEO owns. The SDK is correct; CLEO must pick one: (a) convert the 11 static imports to dynamic with try/catch, OR (b) promote `llmtxt` to hard `dependencies`. Document the choice in ADR-078. | Epic **E4-DOCS-SDK-BOUNDARY** (T10292) — ADR-078 amendment + chosen-posture migration. |
| **T10353/F8** | `cleo docs publish` writes a ledger row via `recordPublication()` but the write is best-effort and swallows errors silently. `cleo docs status` later reports "in-sync" when the ledger row was lost. | `packages/cleo/src/cli/commands/docs.ts:939-949` (ledger write in `try/catch` with swallow); `packages/core/src/docs/docs-ops.ts` (`statusDocs` reads same ledger). | **CLEO** | The ledger file (`docs-publications.json`) is a CLEO artifact — not part of llmtxt. The error-swallow is a CLEO implementation defect. | Epic **E3-DOCS-CLI-HARDENING** (T10291) — promote ledger write failures to non-fatal warnings surfaced through the envelope. |
| **T10353/F9** | `cleo changeset list` reads `.changeset/*.md` filesystem only — never queries the SSoT. If `cleo docs add --type changeset --slug X path.md` writes to SSoT without writing the file, `changeset list` won't see it. The "SSoT-first" file-header claim is aspirational. | `packages/cleo/src/cli/commands/changeset.ts` → `packages/core/src/changesets/parser.ts:parseChangesetDir()`. | **CLEO** | Reader/writer asymmetry is purely CLEO's: `cleo changeset add` dual-writes (file + SSoT) but `cleo changeset list` reads filesystem only. The SDK is uninvolved. | Epic **E2-DOCS-DOCKIND-WRITER-DEDUP** (T10290) — make `changeset list` SSoT-first (read SSoT, optionally diff against filesystem mirror). |

## Findings summary

1. **All 10 gaps resolve to CLEO-side responsibility** — either fully (8 of 10) or CLEO-led with no upstream SDK change required (2 of 10: F-1 + F-2/F-3 cluster). Zero gaps need a fix inside llmtxt.

2. **The SDK has zero opinion on slug uniqueness.** `grep -rn 'allocateSlug\|reserveSlug\|claimSlug' node_modules/llmtxt/dist/` returns 0 hits. `slug` is treated as a scoping label (`packages/cleo/.../node_modules/llmtxt/dist/blob/changeset.d.ts:64`: "The document slug to scope blob refs to (optional)"). Slug uniqueness is application-level — entirely CLEO's namespace contract to enforce.

3. **CLI-layer parsing gaps (T10238) live in citty, not llmtxt.** The strict-flag validator (T10359) is a CLEO-side `assertKnownFlags` helper. T10238's repeat-risk on 8 other verbs is also CLI-layer; SDK boundary is irrelevant.

4. **DocKind taxonomy is a contracts-owned concept.** T10153 (no ADR auto-number) hinges on `entityIdPattern` (in `packages/contracts/src/docs-taxonomy.ts`) — that file imports zero llmtxt symbols. Auto-numbering is a CLEO orchestration concern with zero SDK signature change.

5. **The slug-collision iceberg has 3 surfaces, not 2.** `docs add` + `changeset add` is the visible duo (T10294), but `docs import` adds a THIRD allocator in `packages/core/src/docs/import/slug.ts:1-150` with its own `-2`/`-3` chain. E1 (T10289) must collapse all three behind one central entry point.

6. **CLEO has 4 thick wrappers around llmtxt** — none of them is a 1:1 mirror. The wrap surface is meaningful enough to be its own design responsibility but small enough to re-shape in 3-5 PRs (T10354/F9).

7. **Public-surface type leaks are an API-design choice, not an SDK defect.** Every F-1 / F-2 / F-3 occurrence has CLEO actively re-exporting an SDK type rather than re-shaping it. The remediation lives in `packages/contracts/`, not in upstream issues.

8. **The `optionalDependencies` vs static-import asymmetry (F-5) is a CLEO packaging decision.** `optionalDependencies` doesn't suppress `ERR_MODULE_NOT_FOUND` — only install-time resolution. Either dynamic-only imports or hard dep — CLEO chooses, llmtxt doesn't care.

9. **Reader/writer asymmetry across DocKinds (T10353/F9) is invisible to the SDK.** `cleo changeset add` dual-writes; `cleo changeset list` reads filesystem only. SDK never sees the inconsistency. E2 owns the fix.

10. **Best-effort error-swallow in publish ledger (T10353/F8) is a CLEO ledger file.** `docs-publications.json` doesn't exist in llmtxt — it's CLEO's own provenance artifact. Pure CLEO defect.

## What's CLEO's job

CLEO owns:
- **Slug allocation + uniqueness contracts** — one central allocator behind a single entry point. The SDK has no opinion here; if two CLI verbs touch the same namespace, that's CLEO's coordination problem.
- **DocKind taxonomy** (`packages/contracts/src/docs-taxonomy.ts`) — ADR/spec/research/handoff/etc. semantics, `entityIdPattern`, `requiresEntityId`, `publishDir`. The SDK stores opaque blobs; CLEO decides what slugs they get.
- **CLI shell + arg parsing** — citty configuration, strict-flag validation, help text, error envelopes. The SDK is downstream of `dispatchFromCli`.
- **Persistence + degradation policy** — `<projectRoot>/.cleo/keys/cleo-identity.json`, `<projectRoot>/.cleo/blobs/`, `<projectRoot>/.cleo/llmtxt/`, `<projectRoot>/.cleo/audit/receipts.jsonl`, `docs-publications.json` ledger. All of these live outside the SDK.
- **Wrapper design** — every public type a CLEO consumer touches MUST be re-shaped through `packages/contracts/`. Raw SDK types in result envelopes (F-1, F-2, F-3) is the failure mode E4 closes.
- **Reader/writer parity per DocKind** — both surfaces (file mirror + SSoT) must agree on what counts as canonical. E2 (T10290) owns this principle.
- **Pre-write orchestration** — similarity scans (T10167), auto-numbering (T10153), audit logging, idempotency. The SDK exposes primitives; CLEO sequences them.

## What's SDK's job

llmtxt owns:
- **Cryptographic primitives** — `AgentIdentity` class, `identityFromSeed`, `verifySignature`. The implementation must be sound (CLEO trusts it for ADR-051 evidence + Saga T10288 attestation chains).
- **Similarity computation** — `rankBySimilarity`. CLEO calls it; CLEO decides when. SDK delivers the score.
- **Knowledge-graph construction** — `buildGraph` over `MessageInput[]`. CLEO supplies the input shape; SDK produces the graph.
- **Patch / diff / version primitives** — `squashPatches`, `diffVersions`, `reconstructVersion`. CLEO orchestrates document merges; SDK does the bytewise math.
- **Blob-store filesystem layout** — `BlobFsAdapter` + `hashBlob` + the 5 blob error classes. CLEO injects the project path; SDK enforces the on-disk layout invariants.
- **Session lifecycle** — `AgentSession` open/contribute/close + `ContributionReceipt` shape. CLEO supplies the audit-line bytes; SDK signs them.

The line, in one sentence: **CLEO owns naming, orchestration, persistence, and degradation; llmtxt owns crypto, similarity, graph, merge, and blob-byte handling.** Every gap in this matrix lands on CLEO's side of that line.

## References

- T10353 audit (`.cleo/research/t10292-e4-cli-verb-matrix.md`, commit `ad2337b1c`, PR #578)
- T10354 audit (`.cleo/research/t10292-e4-sdk-import-edges.md`, commit `8008fb573`, PR #577)
- ADR-078 — SDK Boundary Classification
- ADR-083 — Hierarchy + Sentient Substrate Frame (saga substrate)
- ADR-051 — Gate Integrity & Evidence (`ContributionReceipt` consumer)
- Saga T10288 SG-DOCS-INTEGRITY
- Bug T10294 — slug-namespace collision (under E1)
- T10359 — strict-flag validator (closed T10238)
