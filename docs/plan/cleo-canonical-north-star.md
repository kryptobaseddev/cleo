# CLEO — Canonical North Star

> **Status**: canonical · 2026-05-25 (v3 — full reconstruction after raw-write loss; integrates both work streams + BRAIN decisions D018-D024)
> **Supersedes**: nothing — consolidates two pre-existing canonical docs into a single navigable index
> **Purpose**: single entrypoint for "where does this work fit?" — links the persona/memory roadmap (`CLEO-PRIME-SENTIENT-MASTERPLAN.md`) with the harness/IPC architecture (`CleoCode-Architecture-Harness-Planning.md`) and maps every live saga onto a tier.

## 1. The two canonical source docs

Both remain authoritative for their layer. **Do not re-litigate them in this doc.** Edit them in place; bump this index when their relationship to the saga graph changes.

| Doc | Path | Layer it owns | Status |
|---|---|---|---|
| **Sentient Masterplan** | `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` (1,587 lines) | BRAIN / persona / memory / PSYCHE / 14 tiers (Tier 1-14) | canonical |
| **Harness Architecture** | `docs/research/CleoCode-Architecture-Harness-Planning.md` (95 lines) | UI / IPC / TUI / TS Daemon / ZeroMQ / VCM / PTY isolation | canonical — **promote to plans/ when first wave ships** |

**The seam between them** is the LAFS envelope (ADR-039): the harness layer transports envelopes, the persona layer produces and consumes them. The envelope contract itself is hardened by **T10343 SG-ENVELOPE-FIRST** (filed 2026-05-23) and specified for humans/agents in `docs/specs/LAFS-ENVELOPE-CONTRACT.md` (`lafs-envelope-contract`).

## 1.5 Glossary — disambiguating "harness"

The word **"harness"** is overloaded across canon docs and historical epics. Three distinct meanings show up:

| Use | What it actually is | Where it lives | Owner saga |
|---|---|---|---|
| **"Daemon harness"** (the agent runtime) | TypeScript long-running process: `cleo daemon serve` + Gateway + VCM mutex + sentient loop + GC sidecar. Spawns workers, manages LLM calls, hosts the SDK API. Per T1737's original language "Native TypeScript + Rust via napi-rs" | `packages/cleo-os/src/` + `packages/core/src/sentient/` + `packages/core/src/gateway/` (new) | **T10401 SG-HARNESS-DAEMON-IPC** |
| **"Cockpit harness"** (the operator TUI) | Rust binary: `ratatui` + `crossterm` + `tokio`. Separate process. Connects to the Daemon over envelope-IPC. Renders panes, PTY isolation, Living Brain visualization. NOT in-process with the kernel | `crates/cockpit/` (new) | **T10402 SG-COCKPIT-HARNESS** |
| **"Harness layer"** (the architectural tier) | The whole Tier 0 of the system — both surfaces above PLUS the envelope contract that joins them. An abstract layer name, not a single artifact | spans T10400 + T10401 + T10402 + T10403 + T10409 + T10418 + T10419 | (no single saga — it's the tier name) |

**Why this matters**: T1737's original "Native TypeScript + Rust via napi-rs" referred to the **Daemon harness**, NOT the Cockpit. The Cockpit being Rust does not contradict T1737 — they're two different surfaces. The TS Daemon stays TypeScript (event-loop friendly for LLM orchestration, async I/O, npm ecosystem). The Cockpit is Rust (crash-resistant UI, ratatui ecosystem, in-process PTY multiplexing). Both consume the same envelope contract.

**Per envelope-first doctrine (T10343)**: language choice within a surface is implementation detail, NOT architecture. The architecture IS the envelope.

## 2. Tier inventory — Sentient Masterplan + Harness Layer

The masterplan defines Tier 1-14. The harness layer is **Tier 0** (not in the masterplan; introduced here). Lower tiers gate higher ones.

| Tier | Name | Source doc | What it owns |
|---|---|---|---|
| **0** | **Harness Layer** (NEW) | Harness Architecture | Cockpit TUI · TS Daemon · ZeroMQ IPC · VCM mutex queue · PTY worker isolation · daemon heartbeats · vault/gateway |
| **1** | Trust Foundation | Masterplan §5/Tier 1 | T9245 evidence-validator hardening · BBTT close-out · daemon liveness · **BRAIN-DB recoverability (P0 prereq, NOT in original masterplan — added 2026-05-23)** |
| **2** | Provenance, Quarantine, Auto-Extract Repair | Masterplan §5/Tier 2 | origin columns · test-fixture quarantine · auto-extract repair · promotion-log fulfillment |
| **3** | Peer-Graph Identity | Masterplan §5/Tier 3 | brain_peers · memory blocks · growing personas (CANT growth) · identity drift · sigil/diary/skills/rapport tables |
| **4** | Mem0 Write-Time Extraction Gate | Masterplan §5/Tier 4 | verifyAndStore chokepoint · Mem0 V3 ADDITIVE_EXTRACTION envelope · audit-by-default |
| **5** | Bitemporal + Four-Network Epistemology | Masterplan §5/Tier 5 | Graphiti bitemporal (created_at/expired_at/valid_at/invalid_at) · Hindsight 4-network (world/bank/opinion/observation) |
| **6** | PSYCHE Pipeline | Masterplan §5/Tier 6 | dialectic evaluator · derivation queue · dreamer specialists · reconciler |
| **7** | Four-Bus Integration | Masterplan §5/Tier 7 | spawn-context-builder · nexus.impact returns brainEvidence · pre-decomposition advisor · brain↔conduit handoff |
| **8** | Continuous Living | Masterplan §5/Tier 8 | idle dream · memory-git per peer · skill distillation |
| **9** | Sentient Tier-2 + Tier-3 | Masterplan §5/Tier 9 | Tier-2 detector wired · Tier-3 sandbox · CANT persona evolution |
| **10** | Conduit A2A | Masterplan §5/Tier 10 | deferred (Wave 9) — agent-to-agent messaging mesh |
| **11** | Memory Provider Plugin Substrate | Masterplan §17 | Hermes-Agent pattern |
| **12** | Mastra-Style Pre-Composed Context | Masterplan §17 | prompt-cache discipline |
| **13** | Episodes + LLM-edges + A-Mem Evolution | Masterplan §17 | LangMem episodes |
| **14** | Honcho MCP Front-End vs Native | Masterplan §17 | deferred decision |

## 3. Saga ↔ Tier mapping

Every existing/proposed saga listed with its tier alignment, full children rosters, and current status. Updated 2026-05-25 with the **10-saga Tier-0 mesh** (8 filed 2026-05-23 + 2 added 2026-05-24 from T1737 triage). Decisions D1-D7 are embedded inline in §5 below.

### Foundation (Tier 0-1) — must ship first

| Saga | Tier | Status | Note |
|---|---|---|---|
| **T10281 SG-BRAIN-DB-RESILIENCE** | 1 (P0 prereq) | pending | Wave 0 (T10286 BRAIN P0 hotfix) **shipped 2026-05-23**; brain.db `integrity_check=ok` confirmed. E1-E4 still in flight. Outputs feed T10405 SG-PSYCHE-FOUNDATION Tier 4 chokepoint |
| **T10343 SG-ENVELOPE-FIRST** (doctrine) | 0 (seam) | pending | LAFS envelope as canonical CLEO boundary; WorkloadIntent enum simplification; **implementation now lives in T10400 SG-CLEO-SDK-API** (via `extends` relation) |
| **T10295 SG-PROJECT-AUTHORITY** | 1 + 7 | pending | projectId as truth (kill CWD-walk-up); enables Gateway projectId routing in T10401; `getVaultDbPath()` helper for T10409 |
| T1892 BBTT | 1 | done | Tier 1 historical work; informed the masterplan |
| T9245 evidence-validator | 1 | done | the loophole fix |
| T9839 SG-GH-TRIAGE-2026-05-21 | 1 (cleanup) | done | bug triage round |

### Harness Layer (Tier 0) — 10-saga mesh (8 filed 2026-05-23 + 2 added 2026-05-24 from T1737 triage)

| Saga | Tier | Status | Children (T1737-absorption rosters in parens) | Depends on | Note |
|---|---|---|---|---|---|
| **T10400 SG-CLEO-SDK-API** | 0 (impl) | pending | T10417 vault-API (T1805, T1807, T1813) | T10343 doctrine | True Envelope SSoT + RESTful API surface; OpenAPI 3.2 spec; `@cleocode/cleo-sdk` client lib; CI gate `lint-envelope-compliance.mjs` |
| **T10401 SG-HARNESS-DAEMON-IPC** | 0 | pending | 10 (T1738/T1750/T1751/T1752/T1753/T1783/T1792/T1802/T1808/T1811) | T10400 + T10409 | `cleo daemon serve` hosts `crates/cleo-gateway` (vendored per T10409); HTTPS MITM + VCM mutex + heartbeats + WASI/Docker sandbox; **absorbs T1737 CleoOS Sentient Harness v3** |
| **T10402 SG-COCKPIT-HARNESS** | 0 | pending | T10420 (Wave 0 competitive intel — incl. RMUX + OpenCode 3-facet), T10345 (Wave 1 architecture decision), T1806, T1812 | T10401 + T10400 | **Rust** ratatui Cockpit TUI as separate process (distinct from TS Daemon harness — see §1.5 glossary); envelope-over-IPC to daemon; PTY worker isolation. **Multiplexer infra**: ADOPTING [**rmux**](https://github.com/helvesec/rmux) (native ratatui integration) per SG-WORKTRUNK-OWN vendor pattern — gated by T10420 council review. **Wave 0 = competitive intel survey before building** (4 categories: Rust TUI inspirations / agent harness competitors / memory + persona platforms / orchestration framework competitors) |
| **T10403 SG-GENKIT-MIDDLEWARE** | cross-cutting | pending | T1744, T1788, T1810 | T10400 + T10409 | Genkit middleware: LLMLingua-2 compression + **gaze-pii via NAPI-RS** (REPLACES OpenRedaction per D1) + provider-agnostic prompt caching; new `@cleocode/cleo-genkit` + `crates/cleo-pii-napi`; **LLM credentials flow through T10409 vault** |
| **T10404 SG-CANT-RUNTIME-V2** | cross-cutting | pending | 6 (T1747/T1748/T1749/T1784/T1804/T9154) | T10403 + T10400 | Harden CANT runtime per spec; wire `session` to Genkit Dotprompt under the hood; **approval-token state to conduit.db `conduit_approvals` table** (per D3) |
| **T10409 SG-VAULT-CORE** | 0 (vault/security) | pending | T10410-T10417 (8 epic children) + T1781, T1782 | T10400 | **Vendor `crates/vault-core` + `crates/cleo-gateway` from onecli**; canonical secure SSoT for ALL credentials (LLM + external APIs); AES-256-GCM via `ring`; JWT agent auth via Proxy-Authorization; SQLite default at XDG `vault.db` + Postgres opt-in; collapses ~4,678 LOC of TS credential plumbing to ~200 LOC wrapper |
| **T10418 SG-AGENT-TOOL-REGISTRY** *(NEW 2026-05-24)* | 0 (registry) | pending | 11 (T1739/T1740/T1741/T1742/T1743/T1746/T1785/T1786/T1787/T1790/T1791) | T10400 + T10404 + T10377 (IVTR coord) | 60+ tools registry (Hermes-Agent steal) — terminal/file/git/web/browser/memory/vision/media/cron + MCP client. Self-discovering agent-facing tool catalog. Coordinates with T10377 SG-IVTR-AC-BINDING's "4 CORE tools" subset to avoid duplication |
| **T10419 SG-CHANNELS** *(NEW 2026-05-24)* | 0 (adapters/UX) | pending | 8 (T1793-T1800) | T10400 + T10401 + T10403 (HITL) | 18 platform/messaging adapters (Telegram/Discord/Slack/WhatsApp/Signal/Matrix/Mattermost/HA/Feishu/WeCom/Weixin/DingTalk/QQBot/Email/SMS/Webhook/API/BlueBubbles/Local TUI) + Session Store + Delivery Router. Potential home for T1806 Web UI pending council |

### Persona / memory (Tier 3-9) — 2 new sagas filed 2026-05-23

| Saga | Tier | Status | Children | Depends on | Note |
|---|---|---|---|---|---|
| **T10405 SG-PSYCHE-FOUNDATION** | 4 + 5 + 6 | pending | T1803, T1809 | T10281 + T10404 | Mem0 chokepoint + Graphiti bitemporal + Hindsight 4-network + PSYCHE pipeline (3 of 4 subsystems exist per masterplan §16.A); **absorbs T1075 PSYCHE Theory-of-Mind Layer** (archived; unarchive blocked by CLI quirk — `absorbs` relation captures intent) |
| **T10406 SG-FOUR-BUS-INTEGRATION** | 7 | pending | T1745, T1789, T1801 | T10405 + T10295 + T9144 | BRAIN ↔ NEXUS ↔ TASKS ↔ CONDUIT seams: spawn-context-builder, wave-rollup BrainDigestEvent, conduit-ingester; subsumes parts of T9144 W2+W5 |
| T1085 peer_id column | 3 | done | — | — | Wave 1-2 PSYCHE partial ship |
| (Tier 8 Continuous Living) | 8 | NOT FILED | — | T10405, T10406 | Successor saga: idle dream, memory-git, skill distillation |
| (Tier 9 Sentient + Tier-3 sandbox) | 9 | absorbed | — | T10401 | T1737 cleanup completed 2026-05-24; sentient + cron + self-healing children now live under T10401 |

### Architecture / hygiene (cross-cutting)

| Saga | Tier | Status | Note |
|---|---|---|---|
| T9831 SG-ARCH-SOLID | cross-cutting (refactor) | **done** | — |
| T10176 SG-BOUNDARY-REGISTRY | cross-cutting (registry) | **done** | — |
| T10288 SG-DOCS-INTEGRITY | cross-cutting (docs SSoT) | **shipped 2026-05-24** | closed T9625 predecessor via `cleo saga reconcile T9625`; enforces this very North Star routing |
| T9787 SG-DOCS-CANON-CLOSURE | cross-cutting (docs) | **done** | — |
| T9839 SG-GH-TRIAGE-2026-05-21 | cross-cutting (bug triage) | **done** | — |
| T9800 SG-WORKTREE-CANON | cross-cutting (worktree) | **done 2026-05-24** | — |
| T9977 SG-WORKTRUNK-OWN | cross-cutting (Rust vendor) | pending | — |
| T9585 SG-CLEO-CORE-V2 | cross-cutting (CORE-first) | pending | — |
| T10326 SG-SUBSTRATE-RECONCILIATION | cross-cutting (governance) | **done** | enforcement-code central registry (I#/E#/D#/P#/ORC#/R#/evidence-atoms) + saga-as-TaskType migration |
| T10377 SG-IVTR-AC-BINDING | cross-cutting (validation) | pending | AC stable IDs + independent Validator role + 4 CORE tools for IVTR loop (coordinates with T10418 SG-AGENT-TOOL-REGISTRY) |

### Product / surface (orthogonal to tier ladder)

| Saga | Status | Note |
|---|---|---|
| T9625 SG-CLEO-DOCS-CANON | **closed** | via T10288 saga reconcile |
| T9758 SG-CLEO-RELEASE-PRODUCT | pending | `cleo release` as canonical release-management product |
| T9799 SG-CLEO-SKILLS-V2 | pending | Anthropic spec compliance — **absorbs T1754, T1755 (Hermes SKILL → CANT migration)** per T1737 triage |
| T9855 SG-TEMPLATE-CONFIG-SSOT | pending | unify templates + 4 config files into single CORE-owned manifests |
| T9862 SG-BUGS-2026-05-21 | **shipped v2026.5.121** | — |
| T9863 SG-FEAT-2026-05-21 | pending | feature backlog parking |
| T1042 Cleo Nexus vs GitNexus (Far-Exceed) | pending | top-level master; owns T9144 Nexus Restructure |
| **T1737 CleoOS Sentient Harness v3** | **structurally retired 2026-05-24** | 52 pending children triaged into 11-saga mesh (8 originally + 2 new + 1 absorbing existing saga); 0 pending children remaining; status update to `cancelled` blocked by transient CLI dist issue (verify + cancel on next clean build). Relations: T10401 + T10418 + T10419 + T9799 `absorbs`, plus pre-existing T1910 `related` |

## 4. Critical sequencing (updated 2026-05-25)

Dependency-ordered ship sequence (post 2026-05-24 deltas):

1. **DONE 2026-05-23** — T10286 BRAIN P0 hotfix shipped; brain.db `integrity_check=ok`
2. **DONE 2026-05-24** — T10288 SG-DOCS-INTEGRITY shipped (5/5 epics, v2026.5.115); enforces canon doc routing including this very North Star
3. **DONE 2026-05-24** — T9800 SG-WORKTREE-CANON shipped; T10326 SG-SUBSTRATE-RECONCILIATION shipped
4. **DONE 2026-05-24** — T1737 CleoOS Sentient Harness v3 structurally retired; 52 children triaged into 11-saga mesh (61 reparents total)
5. **NOW** — close remaining T10281 epics (E1 inventory + E2 integrity + E3 backup-recovery + E4 cross-links). Restores BRAIN trust ratchet
6. **NOW (parallel-safe)** — T10295 SG-PROJECT-AUTHORITY (path-resolution rewrite). Different code surface; no conflict
7. **NEXT** — T10343 SG-ENVELOPE-FIRST doctrine ratification (T10344 boundary-registry simplification + T10346 envelope-contract-hardening)
8. **THEN sequenced** — T10400 SG-CLEO-SDK-API (consumes T10343 doctrine)
9. **THEN sequenced** — T10409 SG-VAULT-CORE (vendors `crates/cleo-gateway` that T10401 hosts)
10. **THEN parallel pair** — T10401 SG-HARNESS-DAEMON-IPC + T10403 SG-GENKIT-MIDDLEWARE (both consume T10400 SDK API + T10409 gateway)
11. **THEN** — T10420 EP-COCKPIT-COMPETITIVE-INTEL (Wave 0 of T10402; RMUX + OpenCode council review)
12. **THEN** — T10402 SG-COCKPIT-HARNESS (consumes T10401 daemon + T10400 API + T10420 council verdict)
13. **THEN** — T10404 SG-CANT-RUNTIME-V2 (consumes T10403 Genkit/Dotprompt + T10400 SDK)
14. **THEN parallel pair** — T10418 SG-AGENT-TOOL-REGISTRY + T10419 SG-CHANNELS (both consume T10400+T10401+T10404)
15. **THEN** — T10405 SG-PSYCHE-FOUNDATION (consumes T10281 BRAIN substrate + T10404 CANT permissions for memory tools)
16. **THEN** — T10406 SG-FOUR-BUS-INTEGRATION (consumes T10405 Mem0 chokepoint + T10295 projectId + T9144 partial ship)
17. **FUTURE** — Tier 8 Continuous Living + Tier 11-14 from masterplan §17

## 5. Genkit + CANT integration map + decisions (BRAIN-referenced)

### 5.1 Decisions D1-D7 (ratified 2026-05-24, persisted in BRAIN)

Full decision text and rationale are stored as durable BRAIN decision records — the SSoT for architectural decisions.
Retrieve any via `cleo memory fetch <id>` or sqlite3 on `.cleo/brain.db`.

| Ref | BRAIN ID | Decision summary | Context saga | Lookup |
|---|---|---|---|---|
| **D1** | D018 | SDK-API + envelope-first split: KEEP AS PROPOSED — T10343 doctrine, T10400 implementation | T10400 | `cleo memory fetch D018` |
| **D2** | D019 | Gateway transport: HYBRID — HTTPS control plane + Unix socket fallback + ZeroMQ streaming data plane | T10401 | `cleo memory fetch D019` |
| **D3** | D020 | LLMLingua model: TinyBERT (57MB) default; larger variants opt-in via env or project config | T10403 | `cleo memory fetch D020` |
| **D4** | D021 | PII engine: gaze-pii Rust crate via NAPI-RS bridge (replaces OpenRedaction) | T10403 | `cleo memory fetch D021` |
| **D5** | D022 | CANT discretion rate limit: 100 evaluations/workflow default, per-`.cant` override available | T10404 | `cleo memory fetch D022` |
| **D6** | D023 | Approval token state: conduit.db `conduit_approvals` table (survives daemon crash) | T10404 | `cleo memory fetch D023` |
| **D7** | D024 | CANT discretion rate: owner-confirmed — closes open question from saga mesh charter | T10404 | `cleo memory fetch D024` |

The previous inline ledger (source: `sg-mesh-decisions-ledger-2026-05-24-home-t10400`) is superseded by the above BRAIN records. The ledger blob remains attached to T10400 for provenance but is no longer the decision SSoT.

**Open decisions** (TBD by next planning agent):
- **D8** — RMUX adoption for Cockpit multiplexer infra (gated by T10420 council review; ADOPT default per owner intent in `cockpit-competitive-intel-seed-2026-05-24`)
- **D9** — OpenCode 3-facet evaluation outcomes: (a) harness arch → T10401, (b) Webapp GUI → T1806/T10419, (c) chat history → T10405/T10402
- **D10** — T1806 Web UI placement: currently T10402; may move to T10401 (daemon admin surface) or T10419 (operator web channel surfaces) pending OpenCode Webapp evaluation in T10420

**Investigation findings from ledger §3** (additional ground-truth, 2026-05-24):
- `packages/core/src/llm/caching.ts` exists as Gemini-specific cached-content store (T1393) — T10403 EXTENDS this for Anthropic ephemeral + OpenAI prefix, does NOT rewrite
- `packages/core/src/llm/context-engines/` exists but minimal (only `rule-based-truncation.ts`) — T10403 adds LLMLingua-2 as NEW context engine alongside
- `packages/cant/src/` has parse + composer + types + mental-model + native-loader + hierarchy + document + worktree + bundle + context-provider-brain + migrate — **execution side is greenfield**
- `packages/core/src/cant/` does NOT exist — CANT spec §7.2 names `packages/core/src/cant/workflow-executor.ts` which must be CREATED by T10404
- `conduit.db` has precedent `attachment_approvals` table — schema pattern for D6 `conduit_approvals`

### 5.2 End-to-end data flow

How the new mesh threads together end-to-end:

```
USER input (CLI / Cockpit TUI)
         │
         ▼
[cleo daemon serve] ── HTTPS Gateway (axum+hyper+tokio-rustls per T10409) ── SG-HARNESS-DAEMON-IPC (T10401)
         │                                       │
         │                                       └── ZeroMQ PUB/SUB for STREAMING (heartbeats 1Hz, brain pulses, PTY firehose)
         ▼
[Envelope contracts (Zod / OpenAPI 3.2)] ── SG-CLEO-SDK-API (T10400)
         │
         ▼
[CANT workflow / pipeline dispatch] ── SG-CANT-RUNTIME-V2 (T10404)
         │
         ├── pipeline: Rust cant-runtime (NO LLM, deterministic shell-safe per spec P01-P07)
         │
         └── session: Genkit Dotprompt ── SG-GENKIT-MIDDLEWARE (T10403)
                  │
                  ▼
              [Genkit middleware stack — onion order]
                  ├── retry / fallback (out-of-box)
                  ├── hardenedAgenticHarness:
                  │   ├── gaze-pii NAPI-RS bridge (Rust, 10-50μs round-trip — REPLACES OpenRedaction per D1)
                  │   ├── LLMLingua-2 token compression (TinyBERT default per D2; XLM-RoBERTa opt-in via CLEO_LLMLINGUA_MODEL)
                  │   └── Recursive summarization (cheap model)
                  ├── Provider cache structuring (Anthropic ephemeral / OpenAI prefix / Gemini context-cache)
                  └── toolApproval (HITL gates persisted to conduit.db conduit_approvals table per D3)
                  │
                  ▼
              [Provider URL rewritten to localhost gateway, placeholder key (FAKE_KEY)]
                  │
                  ▼
              [Gateway (T10409) intercepts: vault.db lookup → AES-256-GCM decrypt → per-host header inject]
                  │   ├── api.anthropic.com → x-api-key header
                  │   └── else → Authorization: Bearer
                  │   audit: telemetry log entry per injection
                  ▼
              [Provider API call with REAL credentials — agent NEVER sees them]
                  │
                  ▼
              [Response → gaze-pii engine.restore() for tool execution]
                  │
                  ▼
              [Memory writes through Mem0 chokepoint] ── SG-PSYCHE-FOUNDATION (T10405)
                  │
                  ▼
              [BRAIN ↔ NEXUS ↔ TASKS ↔ CONDUIT seams] ── SG-FOUR-BUS-INTEGRATION (T10406)
```

## 6. Identified gaps remaining (after 10-saga mesh)

### 6.1 Tier 8 Continuous Living — NOT FILED yet
Successor saga to SG-PSYCHE-FOUNDATION. Idle dream, memory-git per peer, skill distillation. File when T10405 ships.

### 6.2 T1075 archive→pending blocked by CLI quirk
`cleo restore task T1075` returns "already active with status: archived" (logic contradiction). Filed as known CLI bug. `relates absorbs T10405→T1075` captures the intent; worker can navigate.

### 6.3 T1737 structural retirement — status flip blocked
52 children fully triaged into 11-saga mesh on 2026-05-24; 0 pending children remaining. Status update to `cancelled` blocked by transient CLI dist issue (`Cannot find package '@cleocode/worktree'` — needs rebuild). Verify + cancel on next clean build. Mapping documented above in Product/Surface table.

### 6.4 "Feature backlog" epics still not tier-aligned
T9863/T9864-T9870/T9903/T9919/T9927 — tactical work parking. Triage during next audit cycle.

### 6.5 RAW-WRITE LOSS LESSON (2026-05-25)
The original of this doc was written via raw `Write` to `docs/plans/` (wrong path; canon.yml says `docs/plan/`) and was NEVER committed — vanished via branch operations. **Lesson**: per AGENTS.md ADR-076 + the just-shipped T10288 SG-DOCS-INTEGRITY enforcement, EVERY canonical doc (plan / spec / research / handoff / note / adr / changeset / release-note / rcasd / llm-readme) MUST be created via `cleo docs add --type <kind>`. This reconstructed version IS routed via `cleo docs add --type plan` → SSoT blob + publish mirror at `docs/plan/cleo-canonical-north-star.md`. **The v2 reconstruction (2026-05-25) integrates BOTH work streams (vault-core additions from session A + RMUX/OpenCode/T1737-retirement from session B) plus inline decisions ledger D1-D7 since standalone ledger doc was never created (only referenced).**

### 6.6 T1806 Web UI placement TBD (D10)
T1806 (Web UI for daemon management) lives in `packages/cleo-os/src/web/` — daemon-side code, not cockpit-side. Currently under T10402 but may move to T10401 (daemon admin surface) or T10419 (operator web channel surface). Decision deferred to T10420 council review of OpenCode Webapp evaluation.

### 6.7 Decisions ledger migrated to BRAIN (RESOLVED in v3 → v4)

v2 incorrectly stated `sg-mesh-decisions-ledger-2026-05-24` was missing. In v3 the actual slug `sg-mesh-decisions-ledger-2026-05-24-home-t10400` was discovered. In v4 (T11058), the inline D1-D7 decisions table has been migrated to durable BRAIN decision records (D018-D024). The ledger blob remains attached to T10400 for provenance but is no longer the decision SSoT. For full investigation findings §3 (existing surfaces audit + dependency availability) run `cleo docs fetch sg-mesh-decisions-ledger-2026-05-24-home-t10400`.

## 7. Maintenance contract

This doc is **two pages of map, not a plan**. Update it when:

- A new saga is filed that doesn't fit a tier above
- An existing saga changes status (pending → active → done)
- A GAP row in §3 gets filled with a saga ID
- The two source docs' canonical status changes
- A new tier emerges in the masterplan (it's already added 4 tiers post-research-pass-2; future tiers welcome)
- A new D# decision is ratified — add to §5.1 inline

**Update mechanism**: `cleo docs update <slug>` OR write new content and re-run `cleo docs add --slug cleo-canonical-north-star --type plan --replace`. Then `cleo docs publish --for T10400 --to docs/plan/cleo-canonical-north-star.md` to refresh the mirror. **NEVER raw-write to `docs/plan/`** — that path is the publish mirror, not the SSoT.

**After publish**: `git add docs/plan/ && git commit` to lock the mirror to the branch.

Do NOT update this doc to:
- Re-architect a tier (edit the masterplan instead)
- Re-spec the harness layer (edit the harness doc instead)
- Detail saga acceptance criteria (use `cleo show <id>` — the saga IS the spec)

## 8. One-line summary

**Two canonical plans, fourteen-plus-one tiers, ten Tier-0 sagas + two persona/memory sagas, gated by BRAIN-DB-first, surfaced through envelopes, integrated via Genkit-middleware + gaze-pii + CANT, ending in a persistent Cleo persona that knows every project on the user's machine.**

## Appendix — file + slug references

### Source docs
- Sentient Masterplan: `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md`
- Harness Architecture: `docs/research/CleoCode-Architecture-Harness-Planning.md`
- CANT spec: `docs/specs/CANT-DSL-SPEC.md`
- Genkit research: `docs/research/{GenKit-PromptCompression-CANT-DotPrompt.txt, Architectural-Design-AgenticHarness-Genkit.txt}`

### Research doc slugs (via `cleo docs fetch <slug>`)
- `sg-canonical-saga-mesh-2026-05-23` — original mesh charter (7 sagas → expanded to 10)
- `sg-mesh-decisions-ledger-2026-05-24-home-t10400` — D1-D7 decisions ratification + investigation findings §3 (provenance only; decision SSoT is now BRAIN D018-D024 per §5.1)
- `sg-brain-db-resilience-deep-audit-2026-05-23` — BRAIN substrate audit
- `sg-project-authority-charter-2026-05-23` — projectId-as-truth charter
- `sg-envelope-first-doctrine-2026-05-23` — envelope SSoT doctrine
- `sg-vault-core-charter-2026-05-23` — vault + gateway vendor charter
- `cockpit-competitive-intel-seed-2026-05-24` — RMUX + OpenCode steal-candidates seed (under T10420)

### Key ADRs
- ADR-039 — LAFS envelope (the seam)
- ADR-073 — Saga/Epic/Task/Subtask hierarchy
- ADR-076 — Canonical docs routing (T9796) — enforces this doc's SSoT routing
- ADR-078 — Boundary Registry as SSoT for Rust/TS layering
- ADR-083 — Persona substrate (Cleo singleton)
