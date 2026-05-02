# Audit D — Contracts Package Structure

**Date**: 2026-04-30  
**Auditor**: Architectural Audit (read-only investigation)  
**Package**: `packages/contracts/src/`  
**Health Score**: 5.5 / 10

---

## 1. Executive Summary

`@cleocode/contracts` is substantially built out — it covers most dispatch domains and exposes a broad public surface — but has accumulated several structural problems that undermine its SSoT mandate:

**Critical issues:**

1. **LAFS type duplication with semantic divergence**: `packages/contracts/src/lafs.ts` inlines its own copy of `LAFSError`, `LAFSEnvelope`, and `LAFSErrorCategory`. These are NOT consistent with `@cleocode/lafs/src/types.ts`. The `LAFSErrorCategory` union uses lowercase snake_case in contracts vs SCREAMING_SNAKE_CASE in the authoritative `@cleocode/lafs` package. The ownership boundary is muddied.

2. **53 `Result = unknown` stubs**: 53 operation Result types are typed as `unknown` across tasks, session, and nexus ops files. These are architectural IOUs — the type surface is declared but not actually specified. Any consumer relying on these is untyped at the boundary.

3. **`task.schema.json` is a broken stub**: The emitted schema contains only `"Task": {}` — an empty definition. The `emit-schemas.mjs` script builds Task from a Zod summary schema, but the emitted file is clearly stale/broken (the `$ref` points to a definition that is empty). This schema cannot be used for validation or LLM consumption.

4. **5 ops files excluded from the barrel (`operations/index.ts`)**: `admin.ts`, `dialectic.ts`, `docs.ts`, `intelligence.ts`, and `sticky.ts` exist in `operations/` but are NOT re-exported through `operations/index.ts`. Their types reach consumers only via direct top-level re-exports in `index.ts`. This creates a two-tier system — some ops are in the `ops.*` namespace, others are not.

5. **6 conflict/duplication instances across the package**: `GateStatus`, `TaskPriority`, `ConduitSendResult`, `AttachmentKind`, `AttachmentMetadata`, `SessionStartResult`, and `NexusWikiResult` are each defined twice with different shapes or ordering.

6. **6 root-level nexus ops files stranded outside `operations/`**: `nexus-contract-ops.ts`, `nexus-living-brain-ops.ts`, `nexus-query-ops.ts`, `nexus-route-ops.ts`, `nexus-tasks-bridge-ops.ts`, `nexus-wiki-ops.ts` — these live at the package root and are exposed as named sub-path exports in `package.json`, bypassing the `operations/` convention.

**Recommended improvements (highest priority):**
- Fix the LAFS ownership boundary (contracts should re-export from `@cleocode/lafs`, not inline definitions)
- Fill in the 53 `unknown` Result types
- Add `admin`, `dialectic`, `docs`, `intelligence`, `sticky` to `operations/index.ts`
- Migrate root-level nexus ops files into `operations/nexus-*.ts` sub-files
- Resolve all 6 type conflicts via a single canonical definition
- Regenerate `task.schema.json` to produce a real schema

---

## 2. Directory Tree

```
packages/contracts/src/                          (23,262 total LOC across all .ts files)
├── index.ts                    (1,200)  Master barrel — re-exports everything; 83 export blocks
│
├── CORE DOMAIN TYPES (leaf, zero runtime deps)
│   ├── task.ts                  (662)   Task, TaskStatus, TaskPriority, TaskType, etc. (SSoT)
│   ├── session.ts               (236)   Session, SessionStartResult, SessionScope, SessionView
│   ├── session-journal.ts       (148)   SessionJournalEntry + Zod schemas
│   ├── status-registry.ts       (169)   TASK_STATUSES, GATE_STATUSES, GateStatus, etc.
│   ├── task-record.ts           (104)   TaskRecord (string-widened for dispatch/LAFS)
│   ├── task-evidence.ts         (239)   TaskEvidence kinds + Zod schemas
│   ├── task-sync.ts             (217)   ExternalTask, ReconcileAction, SyncDirection
│   ├── results.ts               (296)   DashboardResult, StatsResult, LogQueryResult, etc.
│   ├── config.ts                (428)   CleoConfig, ProviderConfig, BrainConfig, etc.
│   ├── errors.ts                (382)   createErrorResult, formatError, createSuccessResult
│   ├── exit-codes.ts            (225)   ExitCode enum + guards
│   ├── archive.ts               (121)   ArchivedTask, ArchiveStats, etc.
│   ├── audit.ts                 (104)   CommitEntry, ReleaseTagEntry (audit lineage)
│
├── LAFS ENVELOPE TYPES
│   └── lafs.ts                  (386)   LAFS types inlined (NOT re-exported from @cleocode/lafs)
│                                        Contains: LAFSError, LAFSEnvelope, LAFSMeta, LAFSPage
│                                        Also: LafsError, LafsSuccess, LafsEnvelope (CLI subset)
│                                        Also: GatewayEnvelope, CleoResponse (gateway extension)
│                                        PROBLEM: LAFSErrorCategory diverges from @cleocode/lafs
│
├── BRAIN / MEMORY TYPES
│   ├── brain.ts                  (98)   BrainCognitiveType, BrainMemoryTier, BrainSourceConfidence
│   ├── brain-graph.ts           (282)   BrainNode, BrainEdge, BrainGraph (T989 canonical unification)
│   ├── memory.ts                (182)   MemoryBridgeContent, DispatchTrace, BridgeDecision, etc.
│   ├── graph.ts                 (299)   GraphNode, GraphNodeKind, ImpactResult, KnowledgeGraph
│                                        NOTE: graph.ts = code intelligence graph; brain-graph.ts = BRAIN substrate graph
│
├── AGENT REGISTRY
│   ├── agent-registry.ts        (159)   AgentCredential, AgentRegistryAPI, TransportConfig
│   └── agent-registry-v3.ts    (204)   AgentTier, ResolvedAgent, DoctorReport (T897 extensions)
│
├── NEXUS OPS (STRANDED — outside operations/, named sub-path exports)
│   ├── nexus-contract-ops.ts   (244)   Contract, HttpContract, ContractMatch, etc.
│   ├── nexus-living-brain-ops.ts (345) SymbolFullContext, ImpactFullReport, etc.
│   ├── nexus-query-ops.ts      (100)   NexusCteParams, NexusCteResult (recursive CTE DSL)
│   ├── nexus-route-ops.ts      (134)   RouteMapEntry, ShapeCheckResult, etc.
│   ├── nexus-tasks-bridge-ops.ts (71)  GitLogLinkerResult, TaskReference, etc.
│   └── nexus-wiki-ops.ts       (133)   NexusWikiResult, WikiDbHandle, etc.
│                                        PROBLEM: NexusWikiResult conflicts with operations/nexus.ts
│
├── ADAPTER / PROVIDER CONTRACTS
│   ├── adapter.ts               (126)   CLEOProviderAdapter, AdapterHealthStatus
│   ├── capabilities.ts          (small) AdapterCapabilities
│   ├── context-monitor.ts       (small) AdapterContextMonitorProvider
│   ├── discovery.ts              (31)   AdapterManifest, DetectionPattern
│   ├── hooks.ts                  (small) AdapterHookProvider
│   ├── install.ts               (small) AdapterInstallProvider, InstallOptions, InstallResult
│   ├── provider-paths.ts        (small) AdapterPathProvider
│   ├── spawn.ts                  (34)   AdapterSpawnProvider, SpawnContext, SpawnResult
│   ├── spawn-types.ts           (140)   CLEOSpawnAdapter, CAAMPSpawnOptions, Provider
│   └── transport.ts             (133)   Transport, TransportConnectConfig
│
├── MISCELLANEOUS / INFRASTRUCTURE
│   ├── acceptance-gate.ts       (370)   AcceptanceGate (12 types + subtypes)
│   ├── acceptance-gate-schema.ts (347)  Zod schemas for acceptance gates
│   ├── attachment.ts            (245)   Attachment, AttachmentKind, AttachmentMetadata (SSoT)
│   ├── attachment-schema.ts     (223)   Zod schemas for attachments
│   ├── backup-manifest.ts       (189)   BackupManifest, BackupMetadata, BackupScope
│   ├── branch-lock.ts           (280)   BranchLockErrorCode, WorktreeMergeResult, GitShimEnv
│   ├── code-symbol.ts            (73)   CodeSymbol, CodeSymbolKind, ParseResult (tree-sitter)
│   ├── conduit.ts               (283)   Conduit, ConduitMessage, ConduitSendResult (transport-layer)
│   ├── data-accessor.ts         (290)   DataAccessor (storage abstraction interface)
│   ├── dependency.ts             (97)   DependencySpec, DependencyReport
│   ├── evidence-record.ts       (182)   EvidenceRecord (IVTR typed proof)
│   ├── evidence-record-schema.ts (158)  Zod schemas for evidence records
│   ├── facade.ts                (652)   AdminAPI, TasksAPI, SessionsAPI, etc. (Cleo class surface)
│   ├── peer.ts                  (166)   PeerIdentity, PeerKind
│   ├── playbook.ts              (157)   PlaybookDefinition, PlaybookNode, PlaybookRun
│   ├── release/
│   │   └── pipeline.ts          (100)   ReleaseHandle, ReleaseGateStatus, VerifyResult (ADR-063)
│   ├── sentient.ts              (100)   ProposalCandidate, ProposedTaskMeta, Tier2Stats
│   ├── status-registry.ts       (169)   (see above)
│   ├── task-record.ts           (104)   (see above)
│   ├── task.ts                  (662)   (see above)
│   ├── tasks/
│   │   └── archive.ts           (186)   ArchiveReason (Zod enum + tombstone guard)
│   ├── tessera.ts                (35)   TesseraTemplate, TesseraVariable
│   ├── warp-chain.ts            (185)   WarpChain, WarpStage, GateContract, GateResult
│   └── ...
│
├── operations/                              (all wire-format op contracts)
│   ├── index.ts                  (29)   Barrel — MISSING: admin, dialectic, docs, intelligence, sticky
│   ├── admin.ts               (2,087)  ~80 param/result types + AdminOps tagged union (largest file)
│   ├── memory.ts              (1,295)  31 memory operations; rich result types
│   ├── nexus.ts               (1,284)  ~100 nexus op types; 22 have Result=unknown
│   ├── orchestrate.ts           (723)  OrchestrateSpawnParams, OrchestrateHandoffResult, etc.
│   ├── brain.ts                 (643)  BrainQueryParams, BrainSubstrateName, etc.
│   ├── tasks.ts                 (426)  ~40 task op types; 20+ have Result=unknown
│   ├── intelligence.ts          (399)  IntelligenceOps + result types
│   ├── validate.ts              (358)  CheckOps + 30+ validate op types
│   ├── conduit.ts               (335)  ConduitOps + 9 conduit op types
│   ├── session.ts               (332)  SessionOps + 25 session op types
│   ├── docs.ts                  (322)  DocsOps + attachment types (DUPLICATES attachment.ts)
│   ├── sticky.ts                (308)  StickyOps + 15 sticky op types
│   ├── worktree.ts              (293)  CreateWorktreeOptions, DestroyWorktreeResult, etc.
│   ├── release.ts               (271)  ReleaseOps + 7 release op types (OVERLAPS release/pipeline.ts)
│   ├── params.ts                (186)  ParamDef, ParamType, CittyArgDef (SSoT for param descriptors)
│   ├── sentient.ts              (208)  SentientOps + 10 sentient op types
│   ├── lifecycle.ts             (205)  LifecycleOps + GateStatus (CONFLICTS status-registry.ts)
│   ├── dialectic.ts             (167)  DialecticOps + 3 op types
│   ├── nexus-user-profile.ts   (211)  NexusProfileOps + 7 profile op types
│   ├── system.ts               (174)  SystemOps + system info types
│   ├── skills.ts               (210)  SkillOps + skill types
│   ├── pipeline.ts              (small) Pipeline stage types
│   ├── playbook.ts             (161)  PlaybookOps + run/approval types
│   ├── research.ts             (156)  ResearchOps + research types
│   ├── llm.ts                  (115)  LLMCallParams, ToolCallParams
│   ├── issues.ts                (86)  Diagnostics (minimal)
│   └── variable-substitution.ts (211) SubstitutionResult, VariableResolver, etc.
│
└── __tests__/
    ├── acceptance-gate.test.ts
    ├── agent-types.test.ts
    ├── attachment.test.ts
    ├── evidence-record.test.ts
    └── invariants.test.ts
```

---

## 3. Public Surface Inventory

The `index.ts` barrel has 83 export blocks (~860 named symbol exports based on line count analysis). Top exports grouped by category:

### Envelope / LAFS
`LAFSEnvelope`, `LAFSError`, `LAFSErrorCategory`, `LAFSMeta`, `LAFSPage`, `LAFSPageNone`, `LAFSPageOffset`, `LAFSTransport`, `LafsEnvelope`, `LafsError`, `LafsSuccess`, `LafsAlternative`, `LafsErrorDetail`, `GatewayEnvelope`, `GatewayError`, `GatewayMeta`, `GatewaySuccess`, `CleoResponse`, `ConformanceReport`, `FlagInput`, `MVILevel`, `Warning`, `isLafsSuccess`, `isLafsError`, `isGatewayEnvelope`

### Task Domain
`Task`, `TaskCreate`, `TaskStatus`, `TaskPriority`, `TaskSize`, `TaskType`, `TaskRole`, `TaskScope`, `TaskSeverity`, `TaskOrigin`, `TaskWorkState`, `TaskProvenance`, `TaskRelation`, `TaskRecord`, `MinimalTaskRecord`, `AcceptanceItem`, `EvidenceAtom`, `GateEvidence`, `FileMeta`, `Phase`, `PhaseStatus`, `EpicLifecycle`, `VerificationGate`, `CancelledTask`, `CompletedTask`, `SessionNote`

### Operations (namespace `ops.*`)
All of: `ops.brain.*`, `ops.conduit.*`, `ops.issues.*`, `ops.lifecycle.*`, `ops.llm.*`, `ops.memory.*`, `ops.nexus.*`, `ops.nexus-user-profile.*`, `ops.orchestrate.*`, `ops.params.*`, `ops.pipeline.*`, `ops.playbook.*`, `ops.release.*`, `ops.research.*`, `ops.sentient.*`, `ops.session.*`, `ops.skills.*`, `ops.system.*`, `ops.tasks.*`, `ops.validate.*`, `ops.variable-substitution.*`, `ops.worktree.*`

Also directly re-exported from operations (bypassing `ops.*` namespace): admin types (~50), conduit op types (~18), dialectic types (~6), docs types (via ops.docs sub-path only), intelligence types, lifecycle types (~17), memory retrieval types (~12), nexus types (~100+), nexus-user-profile types (~17), sentient types (~13), session types (~26), tasks types (~55), validate types (~40), variable-substitution types (~6), worktree types (~10)

### Status Registry
`TASK_STATUSES`, `TaskStatus`, `SESSION_STATUSES`, `SessionStatus`, `GATE_STATUSES`, `GateStatus`, `LIFECYCLE_PIPELINE_STATUSES`, `LIFECYCLE_STAGE_STATUSES`, `TERMINAL_TASK_STATUSES`, `STATUS_REGISTRY`, `isValidStatus`, `PIPELINE_STATUS_ICONS`, `STAGE_STATUS_ICONS`, `TASK_STATUS_SYMBOLS_ASCII`, `TASK_STATUS_SYMBOLS_UNICODE`

### Schema / Validation (Zod)
`acceptanceGateSchema`, `acceptanceArraySchema`, `attachmentSchema`, `blobAttachmentSchema`, `urlAttachmentSchema`, `evidenceRecordSchema`, `commandOutputRecordSchema`, `implDiffRecordSchema`, `taskEvidenceSchema`, `sessionJournalEntrySchema`, `ArchiveReason`, `ArchiveReasonSchema`, `ArchiveReasonValues`

### Agent / Adapter
`AgentCredential`, `AgentRegistryAPI`, `AgentTier`, `ResolvedAgent`, `DoctorReport`, `CLEOProviderAdapter`, `CLEOSpawnAdapter`, `CAAMPSpawnOptions`, `PeerIdentity`, `PeerKind`

### Brain / Memory
`BrainNode`, `BrainEdge`, `BrainGraph`, `BrainNodeKind`, `BrainSubstrate`, `BrainCognitiveType`, `BrainMemoryTier`, `BrainSourceConfidence`, `BrainEntryRef`, `DispatchTrace`, `BridgeDecision`, `MemoryBridgeContent`

### Graph / Intelligence
`GraphNode`, `GraphNodeKind`, `GraphRelation`, `GraphRelationType`, `ImpactResult`, `KnowledgeGraph`, `CommunityNode`, `CodeSymbol`, `CodeSymbolKind`, `ParseResult`

---

## 4. Domain Coverage Table

Audit domains from the mandate vs. operations file presence:

| Domain | Op File | Params Types | Result Types | Result=unknown | Error Types | Schema File |
|--------|---------|-------------|-------------|---------------|-------------|-------------|
| tasks | `operations/tasks.ts` | YES (20+) | PARTIAL — 20/38 are `unknown` | 20 stubs | None | `task.schema.json` (BROKEN stub) |
| session | `operations/session.ts` | YES (25+) | PARTIAL — 2 are `unknown` | 2 stubs | None | None |
| memory | `operations/memory.ts` | YES (31) | YES — rich result types | 0 | None | None |
| nexus | `operations/nexus.ts` | YES (80+) | PARTIAL — 22 are `unknown` | 22 stubs | None | None |
| orchestrate | `operations/orchestrate.ts` | YES (15+) | YES — mostly typed | 0 | None | None |
| release | `operations/release.ts` + `release/pipeline.ts` | YES | YES — split across 2 files | 0 | None | None |
| sticky | `operations/sticky.ts` | YES (15) | YES — typed | 0 | None | None |
| pipeline | `operations/pipeline.ts` | PARTIAL | PARTIAL | unknown | None | None |
| hooks | MISSING | — | — | — | — | None |
| diagnostics | `operations/issues.ts` (minimal) | PARTIAL | PARTIAL | — | None | None |
| init | Embedded in `operations/admin.ts` as `admin.init` | YES | YES | 0 | None | None |
| config | `config.ts` (domain types only, no ops file) | None | — | — | — | None |
| code / codebase-map | MISSING | — | — | — | — | None |
| conduit | `operations/conduit.ts` | YES (9) | YES | 0 | None | None |
| playbook | `operations/playbook.ts` | YES | YES | 0 | None | None |
| ivtr | MISSING (only `ivtrHistory` flag in tasks.show params) | — | — | — | — | None |
| intelligence | `operations/intelligence.ts` | YES | YES | 0 | None | None |
| sentient | `operations/sentient.ts` | YES (10) | YES | 0 | None | None |
| admin | `operations/admin.ts` | YES (~80 types) | YES | 0 | None | None |
| validate/check | `operations/validate.ts` | YES (30+) | YES | 0 | None | None |
| tools | MISSING | — | — | — | — | None |
| docs | `operations/docs.ts` | YES (5) | YES | 0 | None | `attachment.schema.json` |
| brain | `operations/brain.ts` | YES | YES | 0 | None | None |
| lifecycle | `operations/lifecycle.ts` | YES (12) | YES | 0 | None | `gate-result.schema.json`, `gate-result-details.schema.json` |

**Missing ops files for declared dispatch domains: `hooks`, `ivtr`, `code`/`codebase-map`, `tools`**

**Error types**: Zero operation files define `<Op>Error` types — errors are all expressed through generic LAFS envelope error shapes rather than domain-specific typed errors.

---

## 5. Internal Duplication Report

Seven confirmed duplications within contracts:

### 5.1 `GateStatus` — SEMANTIC CONFLICT
- `status-registry.ts:65`: `type GateStatus = 'pending' | 'passed' | 'failed' | 'waived'`
- `operations/lifecycle.ts:26`: `type GateStatus = 'passed' | 'failed' | 'blocked' | null`

These are semantically different: `status-registry` has `'waived'` + no `null`; lifecycle has `'blocked'` + `null`. The `index.ts` explicitly comments that `GateStatus` from lifecycle ops is NOT re-exported at top level to avoid collision — it resolves the conflict by hiding it, not fixing it.

### 5.2 `TaskPriority` — ORDERING MISMATCH
- `task.ts:42`: `'critical' | 'high' | 'medium' | 'low'`
- `operations/tasks.ts:26`: `'low' | 'medium' | 'high' | 'critical'`

Same values, opposite ordering. Unlikely to cause type errors but signals drift. The ops file re-declares rather than importing from `task.ts`.

### 5.3 `ConduitSendResult` — SHAPE DIVERGENCE
- `conduit.ts:123`: `interface ConduitSendResult { messageId: string; timestamp: string; ... }` (transport-layer)
- `operations/conduit.ts:188`: `interface ConduitSendResult { ... }` (op-layer — different shape)

The `index.ts` explicitly notes: "ConduitSendResult from operations/conduit.ts is intentionally NOT re-exported here because conduit.ts already exports a ConduitSendResult of a different shape." Two shapes, same name — resolved by hiding the ops-layer version.

### 5.4 `AttachmentKind` — VALUE SET DIVERGENCE
- `attachment.ts:174`: `type AttachmentKind = Attachment['kind']` (derived, includes `'llmtxt-doc'`)
- `operations/docs.ts:56`: `type AttachmentKind = 'local-file' | 'blob' | 'url' | 'llms-txt'` (manually listed, MISSING `'llmtxt-doc'`)

The ops version is incomplete — it is missing the `'llmtxt-doc'` variant that `attachment.ts` carries via derived typing.

### 5.5 `AttachmentMetadata` — FIELD DIVERGENCE
- `attachment.ts:185`: `interface AttachmentMetadata { id, kind, name, mimeType, size, sha256, ... }` (full attachment metadata)
- `operations/docs.ts:63`: `interface AttachmentMetadata { id, sha256, kind, mime, size, description, labels, createdAt, refCount }` (wire-format subset with different field names)

`mimeType` vs `mime`, `name` vs `description` — these represent the same concept but with divergent field naming.

### 5.6 `SessionStartResult` — SHAPE DIVERGENCE
- `session.ts:148`: `interface SessionStartResult { session: Session; sessionId: string }`
- `operations/session.ts:216`: `type SessionStartResult = Session` (a plain Session alias)

Different shapes: one wraps Session with a convenience `sessionId`; the other IS Session.

### 5.7 `NexusWikiResult` — LOCATION CONFLICT
- `nexus-wiki-ops.ts:25`: `interface NexusWikiResult { success: boolean; outputDir: string; communityCount: number; ... }` (fully typed)
- `operations/nexus.ts:903`: `type NexusWikiResult = unknown` (untyped stub)

The operations/nexus.ts stub clobbers the well-typed root-level definition. At runtime, consumers who import via `ops.*` get `unknown`; consumers importing from the root get the real shape.

---

## 6. Naming Inconsistencies

### 6.1 Operations files not in `operations/index.ts` barrel
Five operations files that exist but are excluded from the `ops.*` namespace:
- `operations/admin.ts` — exported only at root `index.ts` level
- `operations/dialectic.ts` — exported only at root `index.ts` level
- `operations/docs.ts` — exported only via sub-path `@cleocode/contracts/operations/docs`
- `operations/intelligence.ts` — exported at root level
- `operations/sticky.ts` — exported at root level

### 6.2 Mixed Result type completeness
53 Result types are `= unknown`. Distribution:
- `operations/tasks.ts`: 20 unknown results (e.g. `TasksShowResult`, `TasksAddResult`, `TasksCancelResult`)
- `operations/nexus.ts`: 22 unknown results (e.g. `NexusContextResult`, `NexusAugmentResult`, `NexusDiffResult`)
- `operations/session.ts`: 2 unknown results (`SessionShowResult`, `SessionBriefingShowResult`)
- Other files: 9 more (in validate, conduit, research)

### 6.3 Inconsistent Ops-map naming
The named dispatch-map type (the union of all `{op, params, result}` tuples) is named inconsistently:
- `AdminOps` (in `operations/admin.ts`) — uses `AdminOp` for the operation-name union and `AdminOps` for the tuple map
- `NexusOps` (in `operations/nexus.ts`)
- `ConduitOps` (in `operations/conduit.ts`)
- `SentientOps` (in `operations/sentient.ts`)
- `SessionOps` (in `operations/session.ts`)
- `TasksOps` (in `operations/tasks.ts`)
- `CheckOps` (in `operations/validate.ts`) — uses `CheckOps` not `ValidateOps`
- `IntelligenceOps` (in `operations/intelligence.ts`)
- `DocsOps` (in `operations/docs.ts`)

**Inconsistency**: `CheckOps` instead of `ValidateOps`; `TasksOps` plural vs `AdminOps`, `NexusOps` singular treatment.

### 6.4 No `<Op>Error` types anywhere
Zero operation files define domain-specific error types. All error handling is handled through the generic LAFS envelope. While intentional, this is a gap if typed error narrowing is desired.

### 6.5 `warp-chain.ts` naming
`GateCheck`, `GateContract`, `GateName`, `GateResult` in `warp-chain.ts` vs `GateStatus`, `Gate` in `operations/lifecycle.ts` — overlapping "Gate*" vocabulary in different files with no clear relationship.

---

## 7. LAFS Boundary

**Current state**: Ambiguous and problematic.

`packages/contracts/src/lafs.ts` defines LAFS types inline (by design — the file comment states "contracts has ZERO external dependencies" and the types are "inlined from @cleocode/lafs for maximum portability").

However this creates a divergence problem:

| Type | `packages/contracts/src/lafs.ts` | `packages/lafs/src/types.ts` |
|------|----------------------------------|------------------------------|
| `LAFSErrorCategory` | lowercase: `'validation'`, `'not_found'`, `'conflict'`, `'authorization'`, `'internal'`, `'rate_limit'`, `'timeout'`, `'dependency'` (8 values) | SCREAMING_SNAKE_CASE: `'VALIDATION'`, `'AUTH'`, `'PERMISSION'`, `'NOT_FOUND'`, `'CONFLICT'`, `'RATE_LIMIT'`, `'TRANSIENT'`, `'INTERNAL'`, `'CONTRACT'`, `'MIGRATION'` (10 values) |
| `LAFSError` | `{ code, category, message, fix?, details? }` | More fields, different shape |
| `LAFSEnvelope` | `{ success, data?, error?, _meta }` | Different `_meta` structure |

**Verdict**: Two canonical LAFS type definitions exist and they have DIVERGED. This is a live correctness risk. A consumer importing `LAFSErrorCategory` from contracts will get `'validation'` etc., while one importing from `@cleocode/lafs` gets `'VALIDATION'` etc. These are not interchangeable.

**Recommended boundary**:
- `@cleocode/lafs` OWNS all canonical LAFS types (`LAFSEnvelope`, `LAFSError`, `LAFSErrorCategory`, `LAFSMeta`, `LAFSPage`, `LAFSTransport`, `MVILevel`)
- `@cleocode/contracts` SHOULD re-export these from `@cleocode/lafs` OR keep a single agreed inlined copy that is kept in sync via a test
- The CLEO-specific extensions (`LafsSuccess`, `LafsError` (CLI wrapper), `GatewayEnvelope`, `CleoResponse`) legitimately belong in contracts since they are CLEO-specific wrappers

---

## 8. Dependency Check

**`packages/contracts/` is confirmed as a leaf with ONE caveat.**

Direct `import` analysis of all non-relative imports in `packages/contracts/src/`:

| Import | Source | Assessment |
|--------|--------|------------|
| `import { z } from 'zod'` | `acceptance-gate-schema.ts`, `attachment-schema.ts`, `task-evidence.ts`, `session-journal.ts`, `evidence-record-schema.ts`, `tasks/archive.ts` | UNDECLARED — `zod` is used but NOT listed in `contracts/package.json` dependencies. It is in the root `package.json` devDependencies. Works in monorepo context via hoisting but is a portability/packaging risk for standalone use. |
| `zod-to-json-schema` | `scripts/emit-schemas.mjs` only (build-time script) | OK — listed in `dependencies` |
| No `@cleocode/*` imports | — | CONFIRMED — contracts does NOT import from any other workspace package |

**Verdict**: Contracts is effectively a leaf. The `zod` omission from `contracts/package.json` is a dependency declaration gap — `zod` should appear in `contracts/package.json` as a peer or regular dependency since it ships Zod schemas in its public `dist/`.

---

## 9. Schema Sync

Seven JSON schema files exist in `packages/contracts/schemas/`:

| Schema File | Source Type | Status |
|-------------|-------------|--------|
| `task.schema.json` | Hand-built Zod summary schema | **BROKEN** — contains `"Task": {}` empty definition. The `$ref` resolves to an empty object. Unusable for validation. |
| `acceptance-gate.schema.json` | `acceptanceGateSchema` (Zod) | Present — appears generated correctly |
| `attachment.schema.json` | `attachmentSchema` (Zod) | Present — appears generated correctly |
| `gate-result.schema.json` | `acceptanceGateResultSchema` (Zod) | Present — appears generated correctly |
| `gate-result-details.schema.json` | `gateResultDetailsSchema` (Zod) | Present — appears generated correctly |
| `task-evidence.schema.json` | `taskEvidenceSchema` (Zod) | Present — appears generated correctly |
| `manifest-v1.json` | Hand-authored JSON Schema | Present — manually maintained backup manifest schema |

**Coverage gaps**: The following types have Zod schemas in source but no emitted JSON schema:
- `EvidenceRecord` / `evidenceRecordSchema`
- `SessionJournalEntry` / `sessionJournalEntrySchema`
- `ArchiveReason` / `ArchiveReasonSchema`

No JSON schemas exist for any of the `operations/*` Op params or result types. These are pure TS interfaces with no Zod backing — meaning no runtime validation at dispatch boundaries.

**Root cause of `task.schema.json` breakage**: The `emit-schemas.mjs` script builds Task from an ad-hoc Zod `taskSummarySchema`. When this schema was last updated (or not updated to match the `zodToJsonSchema` output), the result became a broken `$ref` pointing to an empty `definitions.Task`. The build script needs to be re-run after fixing.

---

## 10. Recommended Refactor Plan

Listed by priority (no code changes — file/dir changes only):

### Priority 1: Fix active correctness bugs

**P1-A: Resolve LAFS type divergence**
- Decide: does `@cleocode/contracts` inline or re-export LAFS canonical types?
- Option A (recommended): Add `@cleocode/lafs` as a peer dependency, re-export `LAFSEnvelope`, `LAFSError`, `LAFSErrorCategory`, `LAFSMeta`, `LAFSPage`, `LAFSTransport`, `MVILevel` from `@cleocode/lafs` in `contracts/src/lafs.ts`
- Keep CLEO-specific wrappers (`LafsSuccess`, `LafsError` CLI wrapper, `GatewayEnvelope`, `CleoResponse`) defined locally in contracts
- Add invariant test: `LAFSErrorCategory` values in contracts must match `@cleocode/lafs` at import time

**P1-B: Fix `task.schema.json` stub**
- Re-run `pnpm run build:schemas` in `packages/contracts/` after ensuring `taskSummarySchema` properly emits
- Verify the generated file has a non-empty `Task` definition before committing

**P1-C: Resolve `GateStatus` conflict**
- Rename `operations/lifecycle.ts` version to `LifecycleGateStatus` (it has different semantics: `'blocked' | null` vs `'pending' | 'waived'`)
- Remove the `index.ts` workaround comment about omitting it

**P1-D: Fix `NexusWikiResult` conflict**
- Remove `export type NexusWikiResult = unknown` from `operations/nexus.ts`
- Import and re-export from `nexus-wiki-ops.ts` instead
- Update the `NexusOps` tuple map accordingly

### Priority 2: Eliminate duplication

**P2-A: Fix `AttachmentKind` and `AttachmentMetadata`**
- `operations/docs.ts`: remove local `AttachmentKind` and `AttachmentMetadata` definitions
- Import canonical versions from `'../attachment.js'` and use them in the docs op types

**P2-B: Fix `TaskPriority` redeclaration**
- `operations/tasks.ts`: remove `export type TaskPriority = ...`
- Import from `'../task.js'` and re-export

**P2-C: Fix `SessionStartResult` conflict**
- Decide which shape is canonical (the wrapper `{ session, sessionId }` or the plain `Session`)
- Align `operations/session.ts` to import from `'../session.js'` or define a clearly named distinction (`SessionStartPayload` for the ops result)

**P2-D: Fix `ConduitSendResult` conflict**
- Rename `operations/conduit.ts`'s `ConduitSendResult` to `ConduitSendOpResult` (the op-layer result)
- Update `ConduitOps` tuple map accordingly
- Document the distinction in both files

### Priority 3: Structural cleanup

**P3-A: Add missing ops to `operations/index.ts` barrel**
- Add `export * from './admin.js'` to `operations/index.ts`
- Add `export * from './dialectic.js'`
- Add `export * from './docs.js'`
- Add `export * from './intelligence.js'`
- Add `export * from './sticky.js'`
- These 5 files are already usable via root `index.ts` re-exports but are invisible under `ops.*`

**P3-B: Migrate root-level nexus ops files into `operations/`**
- Move `nexus-contract-ops.ts` → `operations/nexus-contracts.ts`
- Move `nexus-living-brain-ops.ts` → `operations/nexus-living-brain.ts`
- Move `nexus-query-ops.ts` → `operations/nexus-cte.ts`
- Move `nexus-route-ops.ts` → `operations/nexus-routes.ts`
- Move `nexus-tasks-bridge-ops.ts` → `operations/nexus-tasks-bridge.ts`
- Move `nexus-wiki-ops.ts` → `operations/nexus-wiki.ts`
- Update `package.json` sub-path exports to point to new locations
- Add them all to `operations/index.ts`

**P3-C: Add `zod` to `contracts/package.json` dependencies**
- Contracts ships Zod schemas in its `dist/` — consumers need `zod` at runtime
- Add `"zod": "catalog:"` (or version) to `contracts/package.json` `dependencies`

**P3-D: Fill in 53 `Result = unknown` stubs**
- Prioritize: `TasksShowResult`, `TasksAddResult`, `SessionShowResult`, `NexusContextResult`
- Many can be typed as `Task`, `TaskRecord`, or existing result types from `results.ts`

**P3-E: Create missing ops files for coverage gaps**
- `operations/hooks.ts` — hook event params/result types (admin.hooks.matrix is currently embedded in admin)
- `operations/ivtr.ts` — IVTR loop operation contracts
- `operations/tools.ts` — tool invocation params/results

**P3-F: Rename `CheckOps` → `ValidateOps`**
- `operations/validate.ts`: rename `CheckOps` type to `ValidateOps` for consistency
- Update all consumers

**P3-G: Add missing Zod schemas to emit-schemas**
- Add `evidenceRecordSchema` → `evidence-record.schema.json`
- Add `sessionJournalEntrySchema` → `session-journal.schema.json`

### Priority 4: Structural decisions (owner input required)

**P4-A: Adapter contracts in contracts package — is this correct?**
- `adapter.ts`, `capabilities.ts`, `context-monitor.ts`, `discovery.ts`, `hooks.ts`, `install.ts`, `provider-paths.ts`, `spawn.ts`, `spawn-types.ts`, `transport.ts` — these are implementation contracts for the `@cleocode/adapters` package
- Question: should these live in `@cleocode/adapters` package itself or remain in contracts?
- If adapters define these, contracts would no longer need them (reducing surface)

**P4-B: `release/pipeline.ts` vs `operations/release.ts`**
- `release/pipeline.ts` defines `ReleaseHandle`, `ReleaseGateStatus`, `VerifyResult`, `PublishResult`, `ReleaseVersionScheme`, `ReleaseReconcileResult`
- `operations/release.ts` defines `ReleaseGate`, `ChangelogSection`, `ReleaseType`, and 7 op Params/Result types
- There is no overlap but two files serve the release domain — candidate for consolidation into a single `operations/release.ts`

**P4-C: Separate `facade.ts` into `core-api/`**
- `facade.ts` defines `TasksAPI`, `SessionsAPI`, `AdminAPI`, `MemoryAPI`, etc. — the entire `Cleo` facade interface (652 lines)
- This is an internal API surface for `@cleocode/cleo-os` and SDK consumers
- Consider moving to `core-api/facade.ts` or `sdk/api.ts` for better discoverability

---

*End of Audit D report.*
