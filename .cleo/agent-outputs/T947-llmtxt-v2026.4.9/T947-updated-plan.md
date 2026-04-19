# T947 — llmtxt v2026.4.9 Subpath Adoption (UPDATED PLAN)

**Parent**: T942 Sentient CLEO Architecture (RCASD Round 2)
**Supersedes**: Round 1 "v2026.4.8 version bump" acceptance criteria
**Date**: 2026-04-18
**Author**: ct-research-agent (architect persona)

---

## 1. Executive Framing

Round 1 treated T947 as a library version bump. v2026.4.9 changes the picture:
llmtxt now exposes **four stable subpaths** (`/blob`, `/events`, `/identity`,
`/transport`) that map 1:1 onto CLEO primitives we currently re-implement.
T947 therefore becomes a **zero-duplication adoption epic** governed by the
owner's four hard constraints, not a dependency bump.

Current CLEO pin: `llmtxt@^2026.4.6`
(`/mnt/projects/cleocode/packages/cleo/package.json:35`). The root monorepo
does **not** list llmtxt directly, so the upgrade is scoped to `@cleocode/cleo`.

---

## 2. Current CLEO Surfaces That Duplicate llmtxt v2026.4.9 Primitives

| CLEO surface | Current file(s) | Approx LoC to retire | Test coverage |
|---|---|---|---|
| Content-addressed attachment store (`cleo docs add/fetch/remove`) | `packages/core/src/store/attachment-store.ts:1-643` | ~640 | `packages/core/src/store/__tests__/attachment-store.test.ts` + `packages/cleo/src/dispatch/domains/__tests__/docs.test.ts` + `packages/cleo/src/cli/__tests__/docs.test.ts` |
| `cleo docs generate` overview | `packages/core/src/docs/docs-generator.ts:1-376` (fallback at :137-240; `generateFallback` name literal at :150) | ~240 (fallback retired; `llmtxt.generateOverview` call kept) | `packages/core/src/docs/__tests__/docs-generator.test.ts` (if exists) |
| `cleo session start/end` scaffolding | `packages/core/src/sessions/session-memory-bridge.ts` + `packages/cleo/src/dispatch/domains/session.ts` | ~0 retired (wrapped, not replaced; llmtxt `AgentSession` composes) | `packages/core/src/sessions/__tests__/*.test.ts` (31 files) |
| `cleo complete T###` receipt emission | `packages/core/src/tasks/complete.ts:210-260` (and evidence atom flow) + `packages/cleo/src/cli/commands/complete.ts:1-78` | ~0 retired (additive: emit `ContributionReceipt`) | `packages/core/src/tasks/__tests__/complete.test.ts`, `complete-unblocks.test.ts` |
| `cleo bug` severity attestation | `packages/cleo/src/cli/commands/bug.ts:1-102` | 0 (no existing signing — greenfield call into `llmtxt/identity`) | `packages/cleo/src/cli/__tests__/bug.test.ts` (if exists) |
| `.cleo/audit/force-bypass.jsonl` | `packages/core/src/tasks/gate-audit.ts:77-143` + `packages/core/src/tasks/complete.ts` call sites | ~70 retired (replaced by `appendEvent` from `/events`) | `packages/core/src/tasks/__tests__/gate-audit.test.ts:38-120` |
| `.cleo/audit/decisions.jsonl`, `assumptions.jsonl` | `packages/core/src/sessions/decisions.ts:1-100`, `assumptions.ts:1-73` | ~170 retired (migrated to `/events`) | `packages/core/src/sessions/__tests__/*.test.ts` |
| `cleo nexus sync` (diff logic) | `packages/cleo/src/cli/commands/nexus.ts` + `packages/core/src/nexus/*` | TBD (likely ~300) | `packages/cleo/src/cli/commands/__tests__/nexus.test.ts` + `packages/core/src/nexus/__tests__/nexus-e2e-*.test.ts` |

**Total retirable LoC (upper bound)**: ~1,100 lines plus ~300 for nexus sync.
**Net Win**: DRY primitives, Ed25519-signed audit chain, RFC 3161 timestamps,
and STABILITY.md contract protection for free.

Signing is **greenfield** — `grep -R "signRequest\|ed25519" packages/` returned
zero hits. `cleo bug` today is a severity-to-priority mapper; it has no
cryptographic attestation. Adopting `llmtxt/identity` is additive, not a
replacement.

---

## 3. Map to CLEO Sibling Epics (blocker analysis)

| Sibling epic | llmtxt subpath blocker | Rationale |
|---|---|---|
| **T946 Autonomy** (Tier 3 auto-merge) | `llmtxt/identity` + `llmtxt/events` | Tier 3 mandates Ed25519-signed ContributionReceipts with hash-chained audit log. Round 1 synthesis (`.cleo/agent-outputs/T942-rcasd-round1/synthesis.md:101-105`) lists these as "Ed25519 signing infra — MISSING". v2026.4.9 provides both. Tier 3 cannot ship without them. |
| **T948 SDK** (`@cleocode/cleo-sdk`) | `llmtxt/sdk` STABILITY.md pattern | `@cleocode/cleo-sdk` must publish a reciprocal STABILITY.md (SemVer-within-CalVer, per-subpath contract tests, `.d.ts` snapshots). Downstream (OpenClaw, issue #97) already knows this contract. |
| **T945 Graph** (brain_page_nodes auto-populate) | `llmtxt/graph` helpers (soft blocker) | Traversal helpers (`getRelated`, `getContext`) can crib API shape from `llmtxt/graph`. Not hard-blocking — CLEO graph may use different node schema. |
| **T943 SSoT** (evidence-atom Option C) | `llmtxt/events` (potential substrate) | Append-only Merkle-chained event log is a natural substrate for evidence atoms. Round 1 recommended "D as vehicle, C as destination". `/events` supplies the event-sourced log that makes Option C viable. Not a hard blocker — Option D (materialized view) ships without it. |
| **T944 Ontology** (kind+scope) | None | No direct dependency. |

**Critical inference**: `llmtxt/identity` + `/events` adoption must precede
T946 Tier 3. The Round 1 wave plan (W3 llmtxt + W4 Tier 3) is still correct —
but W3's scope now includes the two signature-bearing subpaths, not just
`/sdk` wrapping.

---

## 4. Proposed T947 Acceptance Criteria (v2026.4.9, replaces Round 1 AC list)

These are the **new** acceptance gates. Each MUST have programmatic evidence
per ADR-051 before complete.

1. **pnpm upgrade** `llmtxt` to `^2026.4.9` in `packages/cleo/package.json`
   (also evaluate hoisting to root `package.json` for test-time imports). All
   peer-dep gates in llmtxt STABILITY.md resolved per §5 install matrix.
   Evidence: `commit:<sha>;files:packages/cleo/package.json,pnpm-lock.yaml`.

2. **Retire** `packages/core/src/store/attachment-store.ts` in favour of
   `BlobFsAdapter` from `llmtxt/blob`, injecting `storagePath` from CLEO config
   (`getCleoDirAbsolute()` at `packages/core/src/store/attachment-store.ts:24`).
   CLI shape of `cleo docs add/fetch/remove` is IDENTICAL (owner constraint).
   Hash-verify-on-read replaces `AttachmentIntegrityError` at lines 37-53.
   Evidence: `tool:pnpm-test;files:packages/core/src/store/attachment-store.ts`.

3. **Delete** the built-in fallback path `generateFallback()` at
   `packages/core/src/docs/docs-generator.ts:150-240`. `generateOverview` from
   `llmtxt` (silent-fallback bug fixed in 4.8) is the only code path.
   Evidence: `tool:pnpm-test;files:packages/core/src/docs/docs-generator.ts`.

4. **Wrap** `cleo session start` + `cleo complete` with `AgentSession` from
   `llmtxt/sdk`. `session.contribute()` emits `ContributionReceipt`; receipt
   is persisted to `.cleo/audit/receipts.jsonl` AND to brain memory. CLEO
   session concept (scope, resumeToken) is preserved — AgentSession augments.
   Evidence: `tool:pnpm-test;files:packages/core/src/sessions/session-memory-bridge.ts,packages/core/src/tasks/complete.ts`.

5. **Adopt** `llmtxt/identity` in `cleo bug`. `signRequest` produces an
   Ed25519 signature over `{title, severity, reporterAgent, ts}` + nonce.
   Signed payload attaches as a new `BugAttestation` labeled task annotation.
   KMS abstraction defaults to env-based keyring at `~/.cleo/keys/sentient.ed25519`
   (mode 0600, per T946 Tier 3 design).
   Evidence: `tool:pnpm-test;files:packages/cleo/src/cli/commands/bug.ts`.

6. **Migrate** `.cleo/audit/force-bypass.jsonl`, `gates.jsonl`,
   `decisions.jsonl`, `assumptions.jsonl` → `llmtxt/events`. `appendEvent`
   replaces `appendForceBypassLine`/`appendGateAuditLine` at
   `packages/core/src/tasks/gate-audit.ts:116-143`. Merkle hash chain +
   optional RFC 3161 timestamp anchor. Backward compat: one-time migration
   tool reads old JSONL files and re-plays them into the event log with
   original timestamps preserved.
   Evidence: `tool:pnpm-test;files:packages/core/src/tasks/gate-audit.ts,packages/core/src/sessions/decisions.ts,packages/core/src/sessions/assumptions.ts;test-run:/tmp/vitest-events-migration.json`.

7. **Replumb** `cleo nexus sync` on `llmtxt/events` log sync (default path)
   or `llmtxt/crdt` `getChangesSince`/`applyChanges` (opt-in when
   `@vlcn.io/crsqlite` peer dep is installed — see §5).
   Evidence: `tool:pnpm-test;files:packages/cleo/src/cli/commands/nexus.ts`.

8. **Integration test** — all 4 owner hard constraints programmatically
   verified:
   (a) **Separation** — `rg "from '@cleocode/cleo'" $(pnpm --filter llmtxt root)` returns 0 hits.
   (b) **Standalone** — `pnpm --filter llmtxt install --frozen-lockfile && pnpm --filter llmtxt test` passes with no @cleocode/* in its lockfile.
   (c) **100% use** — new integration test enumerates the zero-duplication table and asserts each CLEO surface delegates via one of `attachBlob`, `generateOverview`, `AgentSession`, `signRequest`, `appendEvent`, or `getChangesSince`.
   (d) **Zero duplication** — `rg "class BlobStore\|class AttachmentStore" packages/core/src` returns 0 hits post-migration; `rg "generateFallback" packages/core/src/docs` returns 0 hits.
   Evidence: `test-run:/tmp/vitest-llmtxt-constraints.json`.

9. **Publish** reciprocal `@cleocode/cleo-sdk/STABILITY.md` (blocked on T948
   scaffold landing). Lists CLEO subpaths, SemVer-within-CalVer promise,
   contract-test CI step, `.d.ts` snapshots under
   `packages/cleo-sdk/.dts-snapshots/`.
   Evidence: `files:packages/cleo-sdk/STABILITY.md`.

10. **CHANGELOG + docs debt closed** — all 17 markdown files that mention
    `force-bypass.jsonl` or legacy attachment paths are updated (enumerated
    in §9). ADR-051 addendum explains the event-log migration while
    preserving the staleness invariant.
    Evidence: `files:CHANGELOG.md,docs/specs/CLEO-LOGGING-CONTRACT.md,.cleo/adrs/ADR-051-programmatic-gate-integrity.md,packages/core/templates/CLEO-INJECTION.md,packages/skills/skills/ct-cleo/SKILL.md,packages/skills/skills/ct-orchestrator/SKILL.md`.

---

## 5. Peer-Dependency Install Matrix

Per llmtxt STABILITY.md point 2: peer-dep optional status must be preserved;
users never receive forced installs.

| llmtxt subpath | Peer dep | CLEO currently ships? | Install decision |
|---|---|---|---|
| `llmtxt` (core) | none | n/a | default |
| `llmtxt/blob` | none | n/a | default (no peer) |
| `llmtxt/events` | none | n/a | default |
| `llmtxt/identity` | none | n/a | default |
| `llmtxt/transport` | none | n/a | default |
| `llmtxt/sdk` | none | n/a | default |
| `llmtxt/local` | `better-sqlite3` + `drizzle-orm` | CLEO ships **node:sqlite** via `getNativeTasksDb` + `drizzle-orm@1.0.0-beta.19-d95b7a4` (root `package.json:94`) | **Skip `/local`** — CLEO uses node-native SQLite, not better-sqlite3 |
| `llmtxt/remote` | none | n/a | default if cloud-sync is needed |
| `llmtxt/embeddings` | `onnxruntime-node` | No (`rg onnxruntime` = 0 hits) | **Opt-in** — document in per-topology install guide |
| `llmtxt/crdt` / `llmtxt/crdt-primitives` | Loro (bundled) | No | default (Loro is bundled, no peer) |
| `llmtxt/graph` / `/similarity` / `/disclosure` | none | n/a | default |

**Per-topology install matrix** (to document in CLEO CHANGELOG + docs):

- **Minimal** (CLI only): no peer deps, `llmtxt@^2026.4.9` alone
- **With brain CRR** (multi-device): `+ @vlcn.io/crsqlite` (opt-in via config flag)
- **With embeddings** (semantic search): `+ onnxruntime-node`
- **Cloud sync**: `/remote` (uses standard fetch — no peer)

Action: CLEO install does NOT pull `/local` (better-sqlite3 conflicts with
node:sqlite choice per ADR-010). Skip it. This aligns with owner constraint
2 (llmtxt stands alone — we don't force its local-backend choice on it).

---

## 6. Reciprocal STABILITY.md for @cleocode/cleo-sdk

**Yes — publish.** Four reasons:

1. **Symmetry**: llmtxt became a reference consumer for CLEO; CLEO owes the
   same contract to its own consumers (OpenClaw, future IDEs).
2. **Discoverability**: downstream agents already parse STABILITY.md from
   llmtxt. Same shape = zero new protocol to learn.
3. **Gate automation**: `@cleocode/cleo-sdk/STABILITY.md` is parseable by a
   CI check that compares `.d.ts` snapshots between releases and fails on
   breaking changes within a CalVer year.
4. **Canonical pattern for T948**: spec-writes itself — mirror llmtxt line
   for line, adapt the subpath list.

Draft subpath list for @cleocode/cleo-sdk (v0.1):

| Subpath | Exports | Stability |
|---|---|---|
| `@cleocode/cleo-sdk` | `createCleo`, `Cleo` facade, `TaskView`, `SessionView` | SemVer-within-CalVer |
| `@cleocode/cleo-sdk/rest` | Fetch client against `cleo-api` REST server | SemVer-within-CalVer |
| `@cleocode/cleo-sdk/stream` | AsyncIterable wrappers for long ops | peer-dep gated (node>=24) |

---

## 7. Revised Wave Plan (supersedes Round 1 Wave Plan)

Round 1 put llmtxt adoption entirely in W3. v2026.4.9 lets us split across
waves because `/blob` + `/sdk` are orthogonal to `/events` + `/identity`.

| Wave | T947 steps | Other epics | Rationale |
|---|---|---|---|
| **W1** | Step 0: version bump to `^2026.4.9` (5 min, zero risk) | T943 view + `computeTaskView`; T948 SDK scaffold promote | Version bump unblocks all subpath imports. |
| **W2** | Steps 1-3: `/blob` adoption + `/sdk` AgentSession wrap + `exportDocument` integration | T944 kind+scope additive migration; T946 Tier 1 daemon (no signing needed yet) | `/sdk` must land before Tier 3, so it goes early. Tier 1 can ship in parallel. |
| **W3** | Steps 4-5: `/events` Merkle log + `/identity` Ed25519 signing + JSONL migration tool | T945 graph auto-populate | Both signature-bearing subpaths ship together — Tier 3 consumes both. |
| **W4** | Steps 6-7: `/crdt` opt-in CRR mode + `/transport` replumbing for `cleo nexus sync` | T946 Tier 2 proposals + Tier 3 sandbox auto-merge (ENABLED by W3) | `/identity` + `/events` from W3 become the signing substrate for Tier 3 ContributionReceipts. |
| **W5** | Step 8 (optional): P2P mesh via `/transport` | Retire `tasks.pipelineStage` column (Option C convergence) | High-risk, low-priority — gated on actual multi-host demand. |

**Key change from R1**: W2 now includes `/sdk` (was in W3). W3 gains
`/identity` + `/events` (were vague "AgentSession" in R1). W4 Tier 3 is
now cleanly enabled by W3 artifacts.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Blob migration botches refCount → data loss | **HIGH** | Dual-write for one release: write to both `attachment_refs` table AND BlobFsAdapter; diff job reconciles nightly; cutover only after 2 weeks zero-drift. |
| `.cleo/audit/*.jsonl` → `/events` migration loses historical records | **MEDIUM** | One-shot replay tool reads existing JSONL with original timestamps; verifies Merkle chain ends at current state before overwrite. Keep JSONL backup under `.cleo/audit/.legacy/` for 2 releases. |
| Peer-dep install surprises existing users (upgrade friction) | **LOW** | Patch-release dist-upgrade guide in CHANGELOG. Default install unchanged (no peer deps in the base subpaths). |
| llmtxt contract drift (SemVer-within-CalVer violated) | **LOW** | STABILITY.md §3 guarantees `.d.ts` snapshot contract tests in their CI; CLEO integration test re-pins expected exports. |
| `/local` peer-dep collision with node:sqlite choice | **MEDIUM** | Do NOT adopt `/local`. Document rationale in CHANGELOG (ADR-010 alignment). |
| Ed25519 key management UX issue (lost keys → lost audit trail) | **MEDIUM** | KMS abstraction supports env/Vault/AWS adapters — document backup procedure. `cleo keys rotate` CLI plus offline recovery phrase. |

---

## 9. Documentation Debt Inventory

From `rg -c 'force-bypass|audit.*jsonl' --glob '*.md'` — 17 files, 35 total
occurrences. All must be updated to reference the new `/events` event log:

- `CHANGELOG.md` (1 hit)
- `docs/specs/T832-gate-integrity-spec.md` (8)
- `docs/specs/CLEO-LOGGING-CONTRACT.md` (2)
- `docs/generated/SKILL-monorepo/references/API-REFERENCE.md` (3)
- `docs/generated/api-reference.md` (3)
- `packages/skills/skills/ct-cleo/SKILL.md` (1)
- `packages/skills/skills/ct-orchestrator/SKILL.md` (1)
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` (2) — **ADDENDUM**
- `.cleo/adrs/ADR-024-multi-store-canonical-logging.md` (1)
- `packages/core/templates/CLEO-INJECTION.md` (1) — PROPAGATES to user's
  global CLAUDE.md! Update carefully.
- 7 others in `.cleo/agent-outputs/` (historic agent outputs, can be left as
  artifacts OR stamped with superseded notice)

ADR changes required:
- **ADR-051 addendum** — replace §6.1/§6.2 force-bypass.jsonl reference with
  `/events` appendEvent + Merkle chain. Preserve staleness invariant (atoms
  still re-validate commit SHA + file SHA256 + tool exit).
- **New ADR** — "ADR-054 llmtxt Subpath Adoption" documenting the
  zero-duplication contract and peer-dep matrix.

---

## 10. Verification Protocol (each step has one programmatic test)

All tests must live under `packages/cleo/test/integration/llmtxt/` and run
in CI:

```ts
// 1. blob adoption integration test
it('cleo docs add delegates to BlobFsAdapter', async () => {
  const spy = vi.spyOn(BlobFsAdapter.prototype, 'attachBlob');
  await dispatch('docs', 'add', { file: 'README.md', taskId: 'T1' });
  expect(spy).toHaveBeenCalledOnce();
});

// 2. AgentSession contribute integration test
it('cleo complete emits a ContributionReceipt', async () => {
  const receipt = await completeWithSession('T2');
  expect(receipt).toMatchObject({
    kind: 'ContributionReceipt',
    signature: expect.stringMatching(/^ed25519:/),
    timestamp: expect.any(String),
  });
});

// 3. Merkle chain verify
it('.cleo/audit events chain verifies end-to-end', async () => {
  const events = await queryEvents({ since: '2026-01-01' });
  const ok = await verifyHashChain(events);
  expect(ok).toBe(true);
});

// 4. Standalone constraint
it('llmtxt has no @cleocode/* imports', async () => {
  const pkg = readJson('node_modules/llmtxt/package.json');
  expect(Object.keys(pkg.dependencies ?? {}).filter(d => d.startsWith('@cleocode/'))).toHaveLength(0);
});

// 5. Zero-duplication constraint
it('CLEO has no residual BlobStore/AttachmentStore class', async () => {
  const hits = await exec('rg -c "class BlobStore|class AttachmentStore" packages/core/src');
  expect(hits.stdout).toBe('');
});
```

---

## 11. Before/After Code Examples (concrete)

### (a) `cleo docs add` — BEFORE

`packages/core/src/store/attachment-store.ts:1-643` implements a full
content-addressed store with our own sha256 hashing, ref-count ledger,
and `AttachmentIntegrityError`:

```ts
// attachment-store.ts (simplified, current)
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
export async function put(bytes: Buffer, cwd?: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = join(getCleoDirAbsolute(cwd), 'attachments', 'sha256', sha256.slice(0,2), sha256.slice(2));
  await writeFile(path, bytes);
  await incrementRefCount(sha256);          // ← our bespoke refCount
  return { sha256, path };
}
```

### (a) `cleo docs add` — AFTER

```ts
// new dispatch/domains/docs.ts (post-migration)
import { BlobFsAdapter } from 'llmtxt/blob';
const blobs = new BlobFsAdapter({ storagePath: getCleoDirAbsolute() + '/attachments' });
export async function addAttachment(bytes: Buffer, ownerId: string) {
  const { hash } = await blobs.attachBlob(bytes, { owner: ownerId });  // hashes, stores, ref-counts
  return { sha256: hash };
}
```

LoC retired: 643. Contract identical from the CLI perspective.

### (b) `.cleo/audit/force-bypass.jsonl` — BEFORE

`packages/core/src/tasks/gate-audit.ts:116-143`:

```ts
export async function appendForceBypassLine(projectRoot: string, record: ForceBypassRecord) {
  const path = resolvePath(projectRoot, '.cleo', 'audit', 'force-bypass.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n', 'utf-8'); // no hash chain, no signature
}
```

### (b) AFTER

```ts
import { appendEvent } from 'llmtxt/events';
import { signRequest, loadIdentity } from 'llmtxt/identity';
export async function recordForceBypass(record: ForceBypassRecord) {
  const identity = await loadIdentity('~/.cleo/keys/sentient.ed25519');
  const signed = await signRequest(record, identity);
  await appendEvent({
    kind: 'gate.override',
    payload: signed,
    // llmtxt handles Merkle chain + optional RFC 3161 timestamp anchor
  });
}
```

Wins: signed, hash-chained, tamper-evident, RFC 3161-anchored. Same API
shape callers consume.

### (c) `cleo complete T###` — BEFORE

`packages/core/src/tasks/complete.ts:221-260` directly mutates task row:

```ts
task.status = 'done';
task.completedAt = now;
task.pipelineStage = 'contribution';  // manual derived-state write
await store.update(task);             // no signed receipt
```

### (c) AFTER

```ts
import { AgentSession } from 'llmtxt/sdk';
const session = await AgentSession.resume({ cwd });
const receipt = await session.contribute({
  taskId: options.taskId,
  evidence: await loadEvidenceAtoms(options.taskId),  // ADR-051 atoms
  // session.contribute internally: appendEvent + signRequest + emit ContributionReceipt
});
task.status = 'done';
task.completedAt = now;
await store.update(task);
await appendEvent({ kind: 'task.completed', receipt });
return receipt;  // callable → Tier 3 auto-merge consumes
```

Wins: receipt is the unit Tier 3 autonomy signs on; the `.cleo/audit/`
chain is complete for owner override audit.

---

## 12. Summary

T947 v2026.4.9 acceptance is **not a version bump**. It is:

- Delete ~1,100 LoC of duplicated primitives
- Adopt 4 new subpaths under strict zero-duplication constraint
- Ship greenfield Ed25519 signing infra via `/identity`
- Migrate 4 JSONL audit files → hash-chained event log
- Publish reciprocal STABILITY.md for @cleocode/cleo-sdk
- Enable T946 Tier 3 autonomy by landing signature + event log deps in W3

Round 1's wave ordering (W3 llmtxt, W4 Tier 3) is preserved — but the W3
content is now precisely defined: `/blob` + `/sdk` in W2; `/events` +
`/identity` in W3.

**Next action for owner**: approve/modify the 10 acceptance criteria in §4
and confirm peer-dep matrix in §5 (specifically the "skip `/local`"
decision). Once approved, T947 can fan out to workers along the W1-W5 plan.
