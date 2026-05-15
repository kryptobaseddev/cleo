# CLEO Prime Sentient Masterplan — Tier 10/11/12/13/14 Decomposition

**Status**: PLANNING ONLY — no `cleo add` was run; no state mutated.
**Source-of-truth**: `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` §5 Tier 10, §16.B/H/I/J/K, §17, §18.
**Branch context**: `feat/T9261-phase4-w5-w8` — `packages/core/src/llm/tool-loop.ts` and `packages/core/src/llm/api.ts` are currently modified per `git status`. Tier 13 heartbeat work MUST coordinate or rebase against those changes.
**Anti-overlap**: This decomposition is restricted to Tier 10, 11, 12, 13, 14. Tiers 1–9 are NOT decomposed here.
**Naming**: All task IDs are placeholder strings (`E-PRIME-T11`, `T11.1`, etc.). The orchestrator MUST allocate concrete CLEO task IDs at creation time. Severity/size/kind annotations follow ADR-066.

**Discovery note (load-bearing)**: §16.J and the prompt both reference `packages/contracts/src/envelope.ts`, but the actual contracts file inventory has `lafs.ts` and `errors.ts` carrying envelope-shaped types. The first subtask of T13 MUST locate the canonical envelope module and either (a) confirm the path is correct or (b) update the masterplan + this decomposition to point at the real file before editing.

---

## E-PRIME-T10 — Conduit A2A (deferred Wave 9)

### Epic Identity
- **Type**: `epic`
- **Kind**: `work`
- **Severity**: P2
- **Size**: large
- **Wave**: W9 (deferred — runs after W4 four-bus integration lands)
- **Parent**: CLEO-PRIME masterplan
- **Title**: "Conduit A2A — structured `CANT /handoff @<peerId>` with linked observation IDs"

### Vision
Replace the deprecated `.cleo/agent-outputs/*.md` redirect-stub handoff pattern with a structured CANT directive that flows over `conduit.db`, carrying linked `brain_observations.id` references. Subscribers receive observation IDs rather than free-form markdown blobs. Design source: `.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-DESIGN.md`.

### Acceptance Criteria (pipe-separated, ready for `--acceptance`)
- `CANT /handoff @<peerId> --obs <id1>,<id2>` parses without error and is rejected if `@<peerId>` is not a canonical peer | 1-hop handoff round-trips an observation_ids set unchanged via `conduit.db` | Subscriber's `cleo conduit pull` envelope exposes `linkedObservationIds: string[]` per ADR-039 | The legacy `.cleo/agent-outputs/<TID>-handoff.md` redirect stub is removed from the dispatch surface and replaced with a CONDUIT message reference | `cleo doctor handoff` reports zero remaining redirect stubs in fresh clones | ADR shipped describing the A2A protocol envelope

### Milestone Gates (qualitative pass/fail — pair with quantitative atoms)
| Gate | Baseline | Target |
|---|---|---|
| CANT `/handoff` parser accepts directive without error | N/A | pass |
| 1-hop handoff round-trips observation_ids preserved | N/A | pass |
| Conduit topic + subscriber wired end-to-end on `conduit.db` | N/A | pass |
| ADR-NNN-conduit-a2a accepted and indexed | N/A | pass |
| Redirect-stub count in repo after migration | unknown N | 0 |

### Phase / Task Tree

#### T10.1 — Design & ADR (decision-heavy)
- **Kind**: `research` → followed by ADR
- **Size**: medium
- **Subtasks**:
  - **T10.1.1** — Audit `.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-DESIGN.md` and reconcile any drift against current `packages/core/src/conduit/*` surface.
    - *Files*: `.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-DESIGN.md`, `packages/core/src/conduit/`.
    - *Acceptance*: Audit note committed; deltas captured.
    - *Evidence*: `decision:D-conduit-a2a-design-current; files:.cleo/agent-outputs/T1075-psyche-integration-plan/CONDUIT-A2A-AUDIT.md`.
    - *Deps*: none.
  - **T10.1.2** — Survey all live `.cleo/agent-outputs/*.md` redirect stubs in main and recent merged branches; classify each (active / safe-to-retire / blocked-on-A2A).
    - *Acceptance*: Inventory committed.
    - *Evidence*: `files:.cleo/agent-outputs/T10-redirect-stub-inventory.md`.
  - **T10.1.3** — Draft envelope contract: `CantHandoffDirective` carrying `targetPeerId`, `linkedObservationIds`, `note?`, `requestAck?`.
    - *Files*: `packages/contracts/src/cant/handoff.ts` (NEW).
    - *Acceptance*: Type compiles; exported from contracts barrel.
    - *Evidence*: `commit:<sha>; files:packages/contracts/src/cant/handoff.ts; tool:typecheck`.
  - **T10.1.4** — Write **ADR-NNN-conduit-a2a-handoff** capturing directive shape, durability semantics on `conduit.db`, replay model.
    - *Files*: `.cleo/adrs/ADR-NNN-conduit-a2a-handoff.md`.
    - *Acceptance*: Accepted by reviewer.
    - *Evidence*: `decision:D-conduit-a2a-adr; files:.cleo/adrs/ADR-NNN-conduit-a2a-handoff.md`.
  - **T10.1.5** — Decision spec: error envelope when `@<peerId>` is unresolvable (`E_PEER_NOT_FOUND`) and when observation IDs are unknown (`E_OBS_REF_MISSING`).
    - *Files*: `packages/contracts/src/errors.ts`.
    - *Acceptance*: Both codes registered; tests reference them.
    - *Evidence*: `commit:<sha>; files:packages/contracts/src/errors.ts; tool:lint`.

#### T10.2 — Parser & validator
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T10.2.1** — Extend CANT parser to recognize `/handoff @<peerId> --obs <ids>`.
    - *Files*: `packages/cant/src/parser/*`.
    - *Acceptance*: 8 parser tests pass including edge cases (no obs, multiple peers rejected, malformed IDs).
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T10.2.2** — Validator wires `canonicalPeerId()` (Tier 3.1 dep — assert present before merge).
    - *Files*: `packages/cant/src/validate/handoff.ts`.
    - *Acceptance*: Rejects non-canonical peer IDs.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T10.2.3** — Observation-ID resolver: rejects unknown observation IDs against `brain_observations`.
    - *Files*: `packages/cant/src/validate/handoff.ts`, `packages/core/src/memory/brain-observations*.ts` (read-only).
    - *Acceptance*: `E_OBS_REF_MISSING` raised on unknown id.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T10.3 — Conduit transport
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T10.3.1** — Add `handoff` topic family to `conduit.db` writer.
    - *Files*: `packages/core/src/conduit/writer.ts` (or equivalent), migration if topic-family table exists.
    - *Acceptance*: Topic emits ordered messages with monotonic seq.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T10.3.2** — Subscriber `cleo conduit pull --topic handoff` returns envelopes carrying `linkedObservationIds`.
    - *Files*: `packages/core/src/conduit/reader.ts`, `packages/cleo/src/commands/conduit/pull.ts`.
    - *Acceptance*: CLI roundtrip integration test passes.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T10.3.3** — Ack semantics: `requestAck=true` directives mark delivered on consumer pull.
    - *Files*: `packages/core/src/conduit/ack.ts` (NEW or extend).
    - *Acceptance*: Ack visible in `cleo conduit stats`.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T10.4 — Migration off redirect stubs
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T10.4.1** — Add `cleo doctor handoff` lint that warns on any new `.cleo/agent-outputs/*.md` matching `*-handoff*.md` pattern.
    - *Files*: `packages/core/src/doctor/handoff-lint.ts` (NEW), CLI command handler.
    - *Acceptance*: Lint reports current inventory and exit 0 if --strict not set.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T10.4.2** — Remove redirect-stub generation paths from orchestrator handoff code, replace with `cleo conduit publish --topic handoff`.
    - *Files*: `packages/core/src/orchestrate/handoff-ops.ts`.
    - *Acceptance*: Orchestrator handoff e2e test now writes to conduit, NOT to file.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T10.5 — Integration test & smoke
- **Kind**: `experiment`; **Size**: small
- **Subtasks**:
  - **T10.5.1** — End-to-end test: orchestrator publishes handoff with 3 obs IDs → subscriber receives → resolves IDs → reads obs rows.
    - *Files*: `packages/core/src/__tests__/conduit-a2a.test.ts` (NEW).
    - *Acceptance*: Test green in CI.
    - *Evidence*: `commit:<sha>; tool:test; test-run:/tmp/conduit-a2a.json`.
  - **T10.5.2** — Doctor gate flip: after 7-day soak with `--warn`, flip `cleo doctor handoff --strict` to blocking in CI.
    - *Files*: `.github/workflows/ci.yml`.
    - *Acceptance*: CI gate is blocking; one failing PR proves it.
    - *Evidence*: `commit:<sha>; tool:test`.

**E-PRIME-T10 deps**: `canonicalPeerId()` (Tier 3.1 — depend on E-PRIME-T03), brain-digest Wave 4 (Tier 7.4), conduit-ingester (Tier 7.5).

---

## E-PRIME-T11 — MemoryProvider Plugin Substrate (Hermes-Agent pattern)

### Epic Identity
- **Type**: `epic`; **Kind**: `work`; **Severity**: P1; **Size**: large; **Wave**: W10.

### Vision
Define a `MemoryProvider` ABC in `packages/core/src/memory/provider.ts` with `sync_turn / prefetch / shutdown / post_setup` lifecycle hooks. Make BRAIN, NEXUS, and llmtxt-core all conform. Add a provider registry so future backends (Honcho, Letta, Mem0) become drop-in. Cite Hermes' `plugins/memory/{honcho,mem0,hindsight,supermemory,retaindb,byterover,openviking,holographic}/` directory layout as the structural model (§16.B).

### Acceptance Criteria
- ABC defined with 4 lifecycle methods and TSDoc on each | BRAIN provider implements ABC and existing `cleo memory observe` path routes through it without regression | NEXUS provider implements ABC for query/upsert | llmtxt provider implements ABC (minimum: `prefetch` returns blob refs) | Provider registry resolves all 3 providers by name | Integration test instantiates BRAIN + a mock alternate, calls `cleo memory observe`, verifies dual-write via the ABC | Provider plugin-registry persisted (table or config) so providers can be enabled/disabled without code change | Hermes-Agent prompt-cache hygiene rule documented: auxiliary providers run on a different LLM client than the foreground orchestrator (§16.B last row)

### Milestone Gates
| Gate | Baseline | Target |
|---|---|---|
| Integration test dual-writes via ABC to brain + mock provider | N/A | pass |
| Provider registry resolves N implementations | 0 | 3 |
| `cleo memory provider list` enumerates registered providers | N/A | pass |
| Lint rule blocks direct `brain-sqlite` imports outside `providers/brain.ts` | N/A | pass |
| Auxiliary-client rule documented in §11.8 of masterplan | absent | present |

### Phase / Task Tree

#### T11.1 — ABC + types
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T11.1.1** — Author `packages/core/src/memory/provider.ts` with `MemoryProvider` ABC.
    - *Methods*: `post_setup(ctx)`, `prefetch(query, ctx)`, `sync_turn(turn, ctx)`, `shutdown()`.
    - *Files*: `packages/core/src/memory/provider.ts` (NEW).
    - *Acceptance*: Compiles; TSDoc on every method; no `any`.
    - *Evidence*: `commit:<sha>; tool:typecheck; tool:lint`.
  - **T11.1.2** — Add `MemoryProviderContext`, `MemoryTurn`, `MemoryQuery` contracts.
    - *Files*: `packages/contracts/src/memory/provider.ts` (NEW).
    - *Acceptance*: Re-exported from contracts barrel; consumers import from contracts only.
    - *Evidence*: `commit:<sha>; tool:typecheck`.
  - **T11.1.3** — TSDoc + forge-ts coverage check for new module.
    - *Files*: same.
    - *Acceptance*: forge-ts coverage gate green.
    - *Evidence*: `tool:lint; tool:typecheck`.

#### T11.2 — Registry
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T11.2.1** — Build registry at `packages/core/src/memory/provider-registry.ts` with `register(name, factory)`, `resolve(name)`, `list()`.
    - *Files*: `packages/core/src/memory/provider-registry.ts` (NEW).
    - *Acceptance*: 8 registry tests pass (register, resolve, missing, duplicate, list, ordering, shutdown propagation, post_setup ordering).
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T11.2.2** — Schema migration for `memory_providers` config table (`name TEXT PK, enabled INTEGER, priority INTEGER, config_json TEXT, created_at INTEGER`). Place under brain.db migrations.
    - *Files*: `packages/core/src/memory/migrations/NNNN-memory-providers.ts` (NEW).
    - *Acceptance*: `cleo doctor brain --strict` recognizes the new table; rollback path tested.
    - *Evidence*: `commit:<sha>; tool:test; files:packages/core/src/memory/migrations/NNNN-memory-providers.ts`.
  - **T11.2.3** — CLI: `cleo memory provider list|enable|disable`.
    - *Files*: `packages/cleo/src/commands/memory/provider.ts` (NEW).
    - *Acceptance*: All three subcommands return LAFS envelope.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T11.3 — BRAIN provider implementation
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T11.3.1** — `packages/core/src/memory/providers/brain.ts` implements ABC; routes `sync_turn` → existing `verifyAndStore` funnel.
    - *Files*: NEW.
    - *Acceptance*: All existing brain integration tests pass unchanged.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T11.3.2** — `prefetch` consults `brain-retrieval.ts` (cold/warm/hot bundle).
    - *Files*: same.
    - *Acceptance*: 5 retrieval tests pass when invoked through ABC.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T11.3.3** — Move direct callers of `brain-sqlite` writers to route via the provider; add lint rule forbidding direct imports outside `providers/brain.ts`.
    - *Files*: `packages/core/src/memory/*.ts`, biome config.
    - *Acceptance*: Lint passes; no `brain-sqlite` import outside providers folder.
    - *Evidence*: `commit:<sha>; tool:lint`.

#### T11.4 — NEXUS provider implementation
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T11.4.1** — `packages/core/src/memory/providers/nexus.ts` — `prefetch` returns nexus context bundle; `sync_turn` upserts code-symbol observations.
    - *Files*: NEW.
    - *Acceptance*: `cleo nexus context` continues to work end-to-end through ABC.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T11.4.2** — Wire `cleo nexus impact <symbol>` through provider's `prefetch` so callers can stay agnostic.
    - *Files*: `packages/core/src/nexus/*`.
    - *Acceptance*: CLI command output unchanged.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T11.5 — llmtxt-core provider implementation
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T11.5.1** — `packages/core/src/memory/providers/llmtxt.ts` — minimum viable: `prefetch` returns BlobOps refs; `sync_turn` records AgentSession events.
    - *Files*: NEW.
    - *Acceptance*: Provider registers; mock-driven smoke test passes.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T11.6 — Auxiliary-client hygiene rule (Hermes prompt-cache discipline)
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T11.6.1** — Document rule in masterplan `§11.8`: "Auxiliary providers MUST use a separate LLM client from the foreground orchestrator to preserve KV cache."
    - *Files*: `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md`.
    - *Acceptance*: Section added.
    - *Evidence*: `commit:<sha>; files:docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md`.
  - **T11.6.2** — Wire `MemoryProviderContext.llmClient` to be either `foreground` or `auxiliary` (enum). Sentient daemon + reflection executors always select `auxiliary`.
    - *Files*: `packages/core/src/memory/provider.ts`, `packages/core/src/sentient/daemon.ts`.
    - *Acceptance*: Daemon test asserts `auxiliary` client used.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T11.7 — Integration & rollout
- **Kind**: `experiment`; **Size**: small
- **Subtasks**:
  - **T11.7.1** — Integration test instantiates BRAIN + mock alternate, calls `cleo memory observe`, verifies dual-write through ABC.
    - *Files*: `packages/core/src/memory/__tests__/provider-substrate.test.ts` (NEW).
    - *Acceptance*: Test green.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T11.7.2** — Backwards-compat smoke: every existing brain test still passes when run through provider substrate.
    - *Files*: same test files, no source change.
    - *Acceptance*: 100% pass.
    - *Evidence*: `tool:test`.

**E-PRIME-T11 deps**: Tier 3 peer canonical IDs (T03 — passes peer IDs through provider context); Tier 4 Mem0 V3 verdict envelope (provider-agnostic by construction). NO dep on T12/T13/T14.

---

## E-PRIME-T12 — Mastra Pre-Composed Context (prompt-cache discipline)

### Epic Identity
- **Type**: `epic`; **Kind**: `work`; **Severity**: P0 (cost-reduction lever); **Size**: large; **Wave**: W11 (lands within or right after W4 four-bus integration).

### Vision
Restructure spawn prompts into a stable cacheable prefix + volatile suffix per Mastra's Observational Memory pattern (§16.H). Wire Anthropic `cache_control` markers. Add Observer/Reflector pair as between-turn agents. Add `priority: P0|P1|P2`, traffic-light emoji rendering 🔴🟡🟢, and 3-date model (`observation_date / referenced_date / relative_date`) to `brain_observations`. Expected impact: 4–10× cost reduction on spawns.

### Acceptance Criteria
- `composeSpawnForTask` returns a 2-block payload (stable | volatile) with explicit cache boundary | Anthropic SDK `cache_control` marker emitted at the boundary | Stable block layout: `<CLEO-INJECTION + project context + observation prefix>`; volatile block: `<task instructions + recent conduit messages>` | Observer agent writes ≥1 priority-tagged observation per turn into BRAIN | Reflector agent fires when stable-prefix observations cross a token threshold, condenses, and re-emits | `brain_observations` gains `priority` (`P0|P1|P2`), `observation_date`, `referenced_date`, `relative_date` columns (additive migration) | Traffic-light emoji 🔴🟡🟢 rendered in prompt-prefix output | Cache hit-rate measured on a benchmark set ≥60% | Token cost per medium-spawn measurably reduced ≥50% relative to baseline | Anthropic SDK version compatibility documented (minimum SDK version that supports `cache_control`)

### Milestone Gates
| Gate | Baseline | Target |
|---|---|---|
| Anthropic prompt-cache hit rate on spawn prompts | ~0% | ≥60% |
| Token cost per spawn (medium task) | (measured at T12.0) | -50% to -90% |
| Observer writes priority-tagged observation per turn | 0 | ≥1 |
| Reflector emits condensed observation when threshold crossed | N/A | pass |
| 3-date model populated on new observations | 0% | 100% |

### Phase / Task Tree

#### T12.0 — Baseline measurement (gate prerequisite)
- **Kind**: `experiment`; **Size**: small
- **Subtasks**:
  - **T12.0.1** — Capture current spawn-prompt token cost on 10 representative medium-tasks; record cache hit-rate (expected ~0%).
    - *Files*: `.cleo/agent-outputs/T12-baseline-measurement.md`.
    - *Acceptance*: Baseline table committed.
    - *Evidence*: `files:.cleo/agent-outputs/T12-baseline-measurement.md; test-run:/tmp/t12-baseline.json`.

#### T12.1 — Schema: priority + 3-date model
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T12.1.1** — Migration adds `priority TEXT CHECK(priority IN ('P0','P1','P2'))` to `brain_observations` (additive, nullable). Reuses existing task-level priority enum (do NOT redefine).
    - *Files*: `packages/core/src/memory/migrations/NNNN-observations-priority.ts` (NEW), `packages/core/src/memory/memory-schema.ts`.
    - *Acceptance*: Migration runs forward + back cleanly.
    - *Evidence*: `commit:<sha>; tool:test; files:packages/core/src/memory/migrations/NNNN-observations-priority.ts`.
  - **T12.1.2** — Migration adds `observation_date INTEGER`, `referenced_date INTEGER`, `relative_date TEXT` to `brain_observations`.
    - *Files*: `packages/core/src/memory/migrations/NNNN-observations-3dates.ts` (NEW).
    - *Acceptance*: New rows populate; old rows tolerate NULL.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.1.3** — Update `brain-row-types.ts` + contracts to reflect new columns.
    - *Files*: `packages/core/src/memory/brain-row-types.ts`, `packages/contracts/src/brain.ts`.
    - *Acceptance*: Types compile; existing readers untouched.
    - *Evidence*: `commit:<sha>; tool:typecheck`.

#### T12.2 — Prompt-prefix builder
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T12.2.1** — Create `packages/core/src/orchestrate/prompt-prefix-builder.ts` (NEW). Exports `buildStableBlock(ctx)` and `buildVolatileBlock(ctx)`.
    - *Files*: NEW.
    - *Acceptance*: Both functions return strings; pure; tested with golden-master.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.2.2** — Stable block composition: CLEO-INJECTION → project-context.json digest → observation prefix (top-K priority-tagged observations rendered with traffic-light 🔴🟡🟢).
    - *Files*: same.
    - *Acceptance*: Golden-master test passes; output stable across two consecutive calls with same input.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.2.3** — Volatile block composition: task instructions + recent conduit messages (last N).
    - *Files*: same.
    - *Acceptance*: Golden-master test passes.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.2.4** — Traffic-light renderer (`renderPriorityEmoji(P0|P1|P2)`) — pure function; covered by unit test.
    - *Files*: `packages/core/src/orchestrate/prompt-prefix-builder.ts`.
    - *Acceptance*: Returns 🔴🟡🟢 respectively; rejects unknown values.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T12.3 — Wire `composeSpawnForTask` to consume split blocks
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T12.3.1** — Refactor `composeSpawnForTask` in `packages/core/src/orchestrate/spawn-ops.ts` to return `{stable, volatile, cacheBoundary}` instead of one flat string.
    - *Files*: `packages/core/src/orchestrate/spawn-ops.ts`.
    - *Acceptance*: All existing spawn integration tests pass after caller migration.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.3.2** — Update all callers of `composeSpawnForTask` (run `cleo nexus impact composeSpawnForTask` first; report all callers).
    - *Files*: per impact report.
    - *Acceptance*: All callers migrated.
    - *Evidence*: `commit:<sha>; tool:typecheck; tool:test`.

#### T12.4 — Anthropic `cache_control` wiring
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T12.4.1** — Audit current Anthropic SDK version in `packages/core/src/llm/` and `packages/core/package.json`; document minimum SDK version that supports `cache_control` (5min/1h marker).
    - *Files*: `docs/plans/cleo-prime-decomposition/T12-anthropic-sdk-compat.md`.
    - *Acceptance*: Compat note committed; SDK bumped if required.
    - *Evidence*: `commit:<sha>; files:docs/plans/cleo-prime-decomposition/T12-anthropic-sdk-compat.md`.
  - **T12.4.2** — Emit `cache_control: { type: "ephemeral" }` marker between stable + volatile blocks in `packages/core/src/llm/request-builder.ts` (or wherever Anthropic message is built — locate via nexus impact first).
    - *Files*: per impact analysis; likely `request-builder.ts` + `caching.ts`.
    - *Acceptance*: Marker appears in built request; integration test asserts presence.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.4.3** — Telemetry: add `cache_creation_input_tokens` / `cache_read_input_tokens` accounting to `usage-pricing.ts`.
    - *Files*: `packages/core/src/llm/usage-pricing.ts`.
    - *Acceptance*: Pricing path counts cache tokens at correct discount; unit-tested.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T12.5 — Observer agent (between-turn)
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T12.5.1** — Create `packages/core/src/sentient/observer.ts` (NEW). Defines `observeTurn(turn) -> Observation[]` — runs as auxiliary-client (Tier 11 rule) on each foreground turn boundary.
    - *Files*: NEW.
    - *Acceptance*: Unit test: given a turn fixture, emits ≥1 priority-tagged observation.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.5.2** — Wire observer into sentient daemon tick; ensure auxiliary-client constraint (Tier 11.6.2) honored.
    - *Files*: `packages/core/src/sentient/daemon.ts`.
    - *Acceptance*: Daemon-integration test confirms observer fires per turn.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T12.6 — Reflector agent (between-turn)
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T12.6.1** — Create `packages/core/src/sentient/reflector.ts` (NEW). Watches stable-prefix observation token count; when threshold crossed, condenses + re-emits.
    - *Files*: NEW.
    - *Acceptance*: Threshold trigger test passes.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T12.6.2** — Persist reflector output as new priority-tagged observation with `referenced_date` linking originals.
    - *Files*: same.
    - *Acceptance*: New observation row references source observation IDs.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T12.7 — Cost-impact verification
- **Kind**: `experiment`; **Size**: small
- **Subtasks**:
  - **T12.7.1** — Re-run T12.0 baseline scenarios with new prefix + cache markers; capture hit-rate and token cost.
    - *Files*: `.cleo/agent-outputs/T12-impact-measurement.md`.
    - *Acceptance*: Hit-rate ≥60%; cost reduction ≥50%.
    - *Evidence*: `files:.cleo/agent-outputs/T12-impact-measurement.md; test-run:/tmp/t12-impact.json`.
  - **T12.7.2** — Publish before/after report; gate ship on numbers meeting target.
    - *Files*: same.
    - *Acceptance*: Numbers green; if not, file remediation tasks.
    - *Evidence*: `decision:D-t12-ship-gate; files:.cleo/agent-outputs/T12-impact-measurement.md`.

**E-PRIME-T12 deps**: T07.1 spawn-context-builder must exist before T12.3 (callers update); Tier 11 auxiliary-client rule before T12.5/T12.6.

---

## E-PRIME-T13 — Episodes + LLM-Edges + Heartbeat

### Epic Identity
- **Type**: `epic`; **Kind**: `work`; **Severity**: P1; **Size**: large; **Wave**: W12.

### Vision
Add a third memory type beyond Collections (observations) and Profiles (peer cards): **Episodes** — completed task trajectories stored as few-shot exemplars (§16.I). On task complete, distill `{task, plan, outcome, surprise}` into `brain_episodes`. Spawn-time retrieval injects matching episodes as `## Prior Successful Approaches` BEFORE Tier 7.1's `## Prior Context (from BRAIN)`. Add MemGPT heartbeat (§16.J) to envelope `meta` + `tool-loop.ts`. Add A-Mem LLM-edges + memory evolution (§16.K) as a separate pass after `verifyAndStore`.

### Acceptance Criteria
- `brain_episodes` table migration shipped: `(id, taskId, plan, outcome, surprise, embedding, peer_id, created_at)` | Task-complete hook distills episode without blocking the complete path | Spawn-time retrieval injects ≥1 matching episode into `## Prior Successful Approaches` block for ≥30% of spawns on similar-task fixtures | Envelope `meta` schema extended with `requestHeartbeat?: boolean` | `tool-loop.ts` honors `requestHeartbeat` and re-enters without yielding; bounded by `maxHeartbeats: 10` per turn | LLM-edge pass emits non-empty `linkedNodes: {id, kind, reason}[]` for ≥1 high-leverage observation per dream cycle | LLM-edge pass capped at 3 neighbors per ingest | A-Mem memory-evolution may rewrite `description` field on neighbor nodes (NOT the fact body) | Episodes path is SEPARATE from `brain_learnings` (distinct table, distinct semantics)

### Milestone Gates
| Gate | Baseline | Target |
|---|---|---|
| Episode retrieval injects matching exemplar into spawn prompt for similar task | 0% | ≥30% |
| Tool-loop heartbeat chain executes 3-step retrieval in single turn | N/A | pass |
| LLM-edge pass emits non-empty linkedNodes for high-leverage observations | 0 | ≥1 per dream cycle |
| Memory-evolution rewrites neighbor descriptions, never facts | N/A | pass |
| `brain_episodes` table present + migration tested | absent | present |

### Phase / Task Tree

#### T13.0 — Envelope path discovery (load-bearing)
- **Kind**: `research`; **Size**: small
- **Subtasks**:
  - **T13.0.1** — Locate canonical envelope module. Masterplan claims `packages/contracts/src/envelope.ts`; actual contracts inventory shows `lafs.ts` + `errors.ts`. Determine and document the correct file.
    - *Files*: `packages/contracts/src/`.
    - *Acceptance*: Path identified; masterplan + this decomposition updated if necessary.
    - *Evidence*: `decision:D-t13-envelope-path; files:packages/contracts/src/<resolved>.ts`.

#### T13.1 — Schema migration: `brain_episodes`
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T13.1.1** — Migration: `brain_episodes (id TEXT PK, taskId TEXT, plan TEXT, outcome TEXT, surprise REAL, embedding BLOB, peer_id TEXT, created_at INTEGER, FOREIGN KEY(peer_id) REFERENCES brain_peers(id))`.
    - *Files*: `packages/core/src/memory/migrations/NNNN-brain-episodes.ts` (NEW), `packages/core/src/memory/memory-schema.ts`.
    - *Acceptance*: Migration up/down clean; index on `(taskId)` + `(peer_id, created_at)`.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.1.2** — Contracts: `Episode` type in `packages/contracts/src/brain.ts` (or `episodes.ts`).
    - *Files*: `packages/contracts/src/brain.ts` (or NEW `episodes.ts`).
    - *Acceptance*: Type compiles; exported from barrel.
    - *Evidence*: `commit:<sha>; tool:typecheck`.

#### T13.2 — Episode distillation on task-complete
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T13.2.1** — Create `packages/core/src/memory/episodes.ts` (NEW). Exports `distillEpisode(task) -> Episode` and `storeEpisode(ep)`.
    - *Files*: NEW.
    - *Acceptance*: Pure distill; unit-tested with fixture task.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.2.2** — Hook into `cleo complete` path: after evidence validation, dispatch distill on auxiliary-client (Tier 11 rule).
    - *Files*: `packages/core/src/tasks/complete-ops.ts` (or equivalent).
    - *Acceptance*: Complete path latency NOT regressed (distill is fire-and-forget); episode row appears.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.2.3** — Embedding for episode plan + outcome via `embedding-worker.ts`.
    - *Files*: `packages/core/src/memory/embedding-worker.ts` (extend).
    - *Acceptance*: Embedding stored on row.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.2.4** — Assert Episodes ≠ `brain_learnings`: separate writer, separate consumer, separate doctor check.
    - *Files*: `packages/core/src/memory/brain-doctor.ts`.
    - *Acceptance*: Doctor enumerates both tables independently.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T13.3 — Spawn-time episode retrieval
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T13.3.1** — Extend `spawn-context-builder.ts` (from Tier 7.1) to query top-K matching episodes by embedding similarity to incoming task.
    - *Files*: `packages/core/src/orchestrate/spawn-context-builder.ts`.
    - *Acceptance*: When ≥1 similar episode exists, retrieval returns it.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.3.2** — Inject `## Prior Successful Approaches` block in spawn prompt BEFORE `## Prior Context (from BRAIN)`.
    - *Files*: `packages/core/src/orchestrate/spawn-context-builder.ts`, `packages/core/src/orchestrate/prompt-prefix-builder.ts` (Tier 12 boundary).
    - *Acceptance*: Golden-master test confirms ordering.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.3.3** — Fixture-driven hit-rate test: for 10 similar-task pairs, episode injection rate ≥30%.
    - *Files*: `packages/core/src/orchestrate/__tests__/episode-injection.test.ts` (NEW).
    - *Acceptance*: Hit-rate ≥30%.
    - *Evidence*: `commit:<sha>; tool:test; test-run:/tmp/t13-injection.json`.

#### T13.4 — Heartbeat envelope + tool-loop
- **Kind**: `work`; **Size**: medium; **COORDINATION**: this branch already has `tool-loop.ts` + `api.ts` modified — rebase or coordinate before T13.4 starts.
- **Subtasks**:
  - **T13.4.1** — Extend envelope `meta` schema with optional `requestHeartbeat?: boolean`.
    - *Files*: per T13.0.1 resolved envelope file.
    - *Acceptance*: Type compiles; existing envelopes still validate.
    - *Evidence*: `commit:<sha>; tool:typecheck`.
  - **T13.4.2** — Modify `packages/core/src/llm/tool-loop.ts` so that when a tool result's envelope returns `meta.requestHeartbeat=true`, the loop re-enters without yielding.
    - *Files*: `packages/core/src/llm/tool-loop.ts` (CURRENTLY MODIFIED on branch — coordinate).
    - *Acceptance*: 3-step retrieval chain executes in a single turn.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.4.3** — Bound the loop with `maxHeartbeats: 10` per turn (MemGPT default). Exceed → emit `E_HEARTBEAT_LIMIT` and stop.
    - *Files*: `packages/core/src/llm/tool-loop.ts`, `packages/contracts/src/errors.ts`.
    - *Acceptance*: Bound enforced; error code registered.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.4.4** — Integration test: 3-step BRAIN retrieval chain via heartbeats; passes in single turn.
    - *Files*: `packages/core/src/llm/__tests__/heartbeat.test.ts` (NEW).
    - *Acceptance*: Green.
    - *Evidence*: `commit:<sha>; tool:test; test-run:/tmp/t13-heartbeat.json`.

#### T13.5 — A-Mem LLM-edge pass
- **Kind**: `work`; **Size**: medium
- **Subtasks**:
  - **T13.5.1** — Create `packages/core/src/memory/llm-edges.ts` (NEW). Exports `emitLinkedNodes(observation, knnNeighbors) -> LinkedNode[]`. Cap output at 3.
    - *Files*: NEW.
    - *Acceptance*: Pure adapter around auxiliary LLM client; unit-tested with stub.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.5.2** — Plumb llm-edges pass alongside (NOT inside) `verifyAndStore`. Run after the Mem0 V3 verdict (Tier 4).
    - *Files*: `packages/core/src/memory/extraction-gate.ts` (or wherever verdict funnel concludes).
    - *Acceptance*: New observations may receive `linkedNodes: []` populated.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.5.3** — Persist `linkedNodes` on BRAIN node. Schema migration adds `linked_nodes_json TEXT` column to `brain_observations` (or to `brain_links` if it already exists).
    - *Files*: `packages/core/src/memory/migrations/NNNN-linked-nodes.ts` (NEW), `packages/core/src/memory/memory-schema.ts`.
    - *Acceptance*: Migration up/down clean.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.5.4** — Dream-cycle integration: per-cycle, ensure ≥1 high-leverage observation gets non-empty linkedNodes.
    - *Files*: `packages/core/src/memory/dream-cycle.ts`.
    - *Acceptance*: Assertion holds across fixture dream.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T13.6 — A-Mem memory evolution
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T13.6.1** — Define `evolveNeighborDescription(neighborId, newObs) -> {neighborId, newDescription}` in `llm-edges.ts`. MUST only rewrite `description` field, NEVER the fact body.
    - *Files*: `packages/core/src/memory/llm-edges.ts`.
    - *Acceptance*: Unit test: fact body unchanged; description mutated.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T13.6.2** — Wire evolution into LLM-edge pass; emit `update-description` ops on neighbors.
    - *Files*: same.
    - *Acceptance*: Op-log shows description rewrites.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T13.7 — Doctor + governance
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T13.7.1** — `cleo doctor brain --strict` adds 2 checks: (a) episode liveness (`COUNT(brain_episodes) > 0` after first task complete), (b) heartbeat-limit not chronically hit (avg < 10).
    - *Files*: `packages/core/src/memory/brain-doctor.ts`.
    - *Acceptance*: Both checks pass on fresh smoke.
    - *Evidence*: `commit:<sha>; tool:test`.

**E-PRIME-T13 deps**: Tier 7.1 spawn-context-builder (T13.3 extends it); Tier 4 Mem0 V3 verdict (T13.5 runs alongside); branch's currently-modified `tool-loop.ts` (T13.4 must rebase).

---

## E-PRIME-T14 — Honcho-MCP-vs-Native Decision (research-track)

### Epic Identity
- **Type**: `epic`; **Kind**: `research` (decision spec, NOT implementation); **Severity**: P2; **Size**: medium; **Wave**: post-W10 (depends on T11 substrate).

### Vision
Decide whether CLEO connects to Honcho's existing MCP server (Bun + TS + Wrangler on Cloudflare Workers) as a memory backend OR sticks with native BRAIN. Phases: (1) install Honcho's MCP server as a sidecar; (2) A/B compare against MemoryProvider-wrapped BRAIN via the substrate from T11; (3) write ADR with the verdict.

### Acceptance Criteria
- Honcho MCP sidecar deployable locally via a documented one-command bring-up | `MemoryProvider` implementation for Honcho-MCP exists and conforms to ABC | A/B benchmark harness produces quantitative comparison across ≥3 dimensions (latency, recall quality, cost) | ADR shipped at `.cleo/adrs/ADR-NNN-honcho-mcp-vs-native.md` with explicit verdict + rationale | Verdict is binary: adopt-Honcho-MCP OR stay-native (or hybrid with explicit boundary)

### Milestone Gates
| Gate | Baseline | Target |
|---|---|---|
| Honcho MCP sidecar reachable from CLEO | N/A | pass |
| Honcho provider implements MemoryProvider ABC | N/A | pass |
| A/B harness produces 3-dimension comparison | N/A | pass |
| ADR shipped with quantitative A/B verdict | N/A | pass |

### Phase / Task Tree

#### T14.1 — Honcho MCP sidecar (experiment)
- **Kind**: `experiment`; **Size**: medium
- **Subtasks**:
  - **T14.1.1** — Clone/install Honcho's `/mcp/` directory (Bun + TS + Wrangler). Document setup at `docs/research/honcho-mcp-sidecar.md`.
    - *Files*: `docs/research/honcho-mcp-sidecar.md` (NEW).
    - *Acceptance*: One-command bring-up documented and verified locally.
    - *Evidence*: `files:docs/research/honcho-mcp-sidecar.md; note:sidecar verified locally`.
  - **T14.1.2** — Network reachability: CLEO talks to sidecar over local HTTP; smoke test connects.
    - *Files*: same doc + a smoke test under `packages/core/src/__tests__/honcho-mcp-smoke.test.ts` (NEW).
    - *Acceptance*: Smoke green.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T14.2 — Honcho provider implementation
- **Kind**: `experiment`; **Size**: medium
- **Subtasks**:
  - **T14.2.1** — `packages/core/src/memory/providers/honcho-mcp.ts` (NEW) implements `MemoryProvider` ABC (from T11) against Honcho's MCP surface.
    - *Files*: NEW.
    - *Acceptance*: ABC conformance test passes.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T14.2.2** — Register Honcho-MCP provider in `provider-registry.ts` under feature-flag `cleo.memory.providers.honcho-mcp.enabled`.
    - *Files*: `packages/core/src/memory/provider-registry.ts`, config.
    - *Acceptance*: Provider appears in `cleo memory provider list` when flag on.
    - *Evidence*: `commit:<sha>; tool:test`.

#### T14.3 — A/B benchmark harness
- **Kind**: `experiment`; **Size**: medium
- **Subtasks**:
  - **T14.3.1** — Build benchmark harness at `tools/bench/memory-provider-ab.ts` (NEW). Runs the same workload through BRAIN provider AND Honcho-MCP provider.
    - *Files*: `tools/bench/memory-provider-ab.ts` (NEW).
    - *Acceptance*: Harness emits structured JSON per provider per scenario.
    - *Evidence*: `commit:<sha>; tool:test`.
  - **T14.3.2** — Metric: latency p50/p95 per `prefetch` and `sync_turn`.
    - *Files*: same.
    - *Acceptance*: Numbers captured.
    - *Evidence*: `test-run:/tmp/t14-latency.json`.
  - **T14.3.3** — Metric: recall quality on a fixture eval set (precision @ K for known queries).
    - *Files*: same.
    - *Acceptance*: Numbers captured.
    - *Evidence*: `test-run:/tmp/t14-recall.json`.
  - **T14.3.4** — Metric: monetary cost per workload (token cost when LLM hops needed; infra cost otherwise).
    - *Files*: same.
    - *Acceptance*: Numbers captured.
    - *Evidence*: `test-run:/tmp/t14-cost.json`.

#### T14.4 — Decision spec ADR
- **Kind**: `work`; **Size**: small
- **Subtasks**:
  - **T14.4.1** — Compose `.cleo/adrs/ADR-NNN-honcho-mcp-vs-native.md` with: (a) context, (b) options, (c) quantitative A/B results, (d) verdict, (e) rationale, (f) reversibility/migration path.
    - *Files*: `.cleo/adrs/ADR-NNN-honcho-mcp-vs-native.md`.
    - *Acceptance*: ADR accepted + indexed in `adr-index.jsonl`.
    - *Evidence*: `decision:D-honcho-mcp-vs-native; files:.cleo/adrs/ADR-NNN-honcho-mcp-vs-native.md`.
  - **T14.4.2** — If verdict = adopt-Honcho-MCP: file follow-up epic E-PRIME-T14F migration. If verdict = stay-native: archive sidecar setup doc and close the experiment.
    - *Files*: per verdict.
    - *Acceptance*: Follow-up captured.
    - *Evidence*: `note:follow-up recorded`.

**E-PRIME-T14 deps**: T11 MemoryProvider ABC (T14.2 implements it). Hard-blocked until T11.1+T11.2 land.

---

## Cross-Epic Risk Register

| Risk | Tier | Mitigation |
|---|---|---|
| `packages/contracts/src/envelope.ts` doesn't exist by that path | T13 | T13.0.1 discovery subtask resolves up front; masterplan and this doc to be amended |
| `tool-loop.ts` already modified on this branch — heartbeat changes collide | T13 | T13.4.x coordination clause: rebase or sequence after current branch lands |
| Anthropic SDK version may not support `cache_control` markers | T12 | T12.4.1 audits and may bump SDK first |
| Cost-reduction targets (50–90%) may not materialize on current workloads | T12 | T12.0 baseline + T12.7 verification gate ships, with remediation captured if numbers miss |
| Honcho MCP sidecar pulls Cloudflare-specific deps | T14 | T14.1.1 documents Linux/local bring-up path explicitly; experiment-kind not work |
| BRAIN provider migration breaks existing brain integration tests | T11 | T11.3.x asserts existing tests pass unchanged; rollback plan via migration down |
| Episodes table grows unbounded | T13 | Follow-up: archival policy in T13.7 doctor (file as separate cleanup task if absent) |
| Observer/Reflector flooding BRAIN with low-value observations | T12 | Priority gating + Tier 11 auxiliary-client rule + reflector condense threshold |
| LLM-edge pass cost regression on every observe | T13 | Cap at 3 neighbors per ingest; only run on high-leverage; auxiliary-client |
| Conduit A2A redirect-stub removal breaks legacy agents in flight | T10 | T10.4.1 ships warn-only doctor first; flip to strict only after soak |

---

## Deferred / Out-of-Scope Follow-Ups

- Episode archival/decay policy (after T13.7 doctor flags growth).
- Tier-3 sandbox transport pluggability (Letta-style — separate epic).
- Letta v2 `memory_apply_patch` headers (Tier 3.2 — owned by T03 decomposition, not here).
- LangMem `ReflectionExecutor` debounced reflection on activity rather than cron (Tier 6 continuous living follow-up).
- Honcho `times_derived` counter on `brain_observations` (referenced in §16.G — pick up in Tier 5 follow-up).
- Tier-2 propose-tick + Hermes Curator integration (W7 — separate decomposition).

---

## Subtask Count Summary

| Epic | Phases | Atomic subtasks |
|---|---|---|
| E-PRIME-T10 | 5 | 14 |
| E-PRIME-T11 | 7 | 14 |
| E-PRIME-T12 | 8 (incl. T12.0 baseline) | 17 |
| E-PRIME-T13 | 8 (incl. T13.0 discovery) | 19 |
| E-PRIME-T14 | 4 | 10 |
| **TOTAL** | **32** | **74** |

74 atomic subtasks sits within the target 60–120 band.

---

## Author / Provenance

- Author: cleo-prime (SignalDock)
- Date: 2026-05-15
- Source: `docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` §5 Tier 10, §16.B/H/I/J/K, §17, §18
- This file: `docs/plans/cleo-prime-decomposition/E-PRIME-T10-T11-T12-T13-T14-substrate.md`
- No CLI state mutated. No `cleo add` invoked.
