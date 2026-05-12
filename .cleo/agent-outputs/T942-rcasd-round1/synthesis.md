# T942 Sentient CLEO Architecture — RCASD Round 1 Synthesis

**Session**: 2026-04-18 | **Parent Epic**: T942 | **Children**: T943-T948

Five parallel research agents ran Round 1 (Research + Positional Advocacy). Key findings per child, a decision matrix, and open questions for the owner.

---

## T943 — State SSoT Unification

**Two advocates argued opposing positions with code evidence. A hybrid synthesis emerges naturally.**

### Option D (materialized view + SDK function) — pragmatic case
- Fully reversible (DROP VIEW), zero data loss
- LEFT JOIN null-safe for pre-ADR-051 tasks with no atoms
- One API object LLMs can reason over: `computeTaskView(id) → TaskView`
- Kills the `/tasks` vs `/tasks/pipeline` divergence at Studio route level
- Shipping waves: add view → parity test → swap routes → publish SDK
- Cites: `packages/core/src/store/tasks-schema.ts:335-357, 401-440`, `packages/studio/src/routes/api/tasks/+server.ts:63-74`, `.../pipeline/+server.ts:33-43`, `tasks/+page.server.ts:102-145`

### Option C (evidence atoms as SSoT) — event-sourced case
- `status` + `pipelineStage` become DERIVED from `lifecycle_gate_results` + `lifecycle_evidence`
- Tamper-resistant (atoms re-validated against git+sha256+tool exit codes)
- Captures CAUSATION not just state — critical for Tier 3 autonomy audit
- Kills 7 manual writes at `packages/core/src/tasks/complete.ts:221-248`
- Weaknesses: cold-start (pre-ADR-051 tasks lack atoms), derivation cost per query

### Recommended Hybrid: **D is the vehicle, C is the destination**
1. Ship D: view + `computeTaskView()` SDK export (Wave 1)
2. View already reads `lifecycle_gate_results` — evidence atoms flow in naturally
3. As ADR-051 coverage grows (Tier 3 autonomy produces atoms for every change), the view's derivation converges toward pure C
4. Retire `tasks.pipelineStage` column in a follow-up release (Option A completes the arc)

**Decision needed**: Accept hybrid, or force pure D or pure C?

---

## T944 — Fractal Ontology (`kind` + `scope`)

**Recommendation: Option (a) namespace separation, additive migration, 3-release deprecation of `type`.**

### Inventory findings
- `tasks.type` touches ~45 call sites (read/write/validate) — mechanical refactor
- CANT `kind` (document frontmatter, filesystem) and task `kind` (DB column) never co-occur
- **Precedent in-repo**: `session.scope.type` vs `task.type` already coexist zero-confusion → same-field-name pattern proven

### Schema (Drizzle, additive)
```ts
kind:  text('kind',  { enum: ['initiative','work','experiment','bug','spike'] }).notNull().default('work'),
scope: text('scope', { enum: ['project','feature','unit']                     }).notNull().default('feature'),
type:  text('type',  { enum: TASK_TYPES }), // KEEP nullable, @deprecated for 3 releases
```

### Migration backfill
- `type='epic'` → `kind='initiative', scope='project'`
- `type='task'|null` → `kind='work', scope='feature'`
- `type='subtask'` → `kind='work', scope='unit'`

### Validation change (lifts epic-of-epics)
`packages/core/src/tasks/add.ts:800-807` forbids epic-with-parent. New rule: initiatives MAY nest into other initiatives (cycles + max-depth still checked).

### Open questions for owner (flagged by Agent 4)
- **Q1**: Should `experiment` kind carry mandatory provenance columns (`sandbox_branch`, `merged_at`) now, or as follow-up in T946?
- **Q2**: Does `bug` deserve a severity axis (scope=project ~ P0, scope=unit ~ typo)?
- **Q3**: Max `initiative` nesting depth? Recommend cap at **3**.
- **Q4**: Keep `epicLifecycle` column name or rename to `kindLifecycle`/`initiativeLifecycle`?

---

## T945 — Universal Semantic Graph

**Not yet researched in Round 1.** `brain_page_nodes`/`brain_page_edges` already exist and support nodes like `task:T###`, `decision:D-###`, `nexus:file::sym`. Auto-population triggers, edge type canonicalization, and SDK traversal surface (getRelated/getImpact/getContext) need design. Propose dispatching Round 2 research agent.

---

## T946 — Autonomous Self-Improving Loop

**Phased ship plan (Week 1 / 2 / 3-4).**

### Sandbox inventory (`/mnt/projects/cleo-sandbox/`)
**Present**: full `AGENTS.md:1-368`, `docker-compose.yml` with 3 nodes, 11 harnesses, 5 scenarios, machine-readable result schema, source mount READ-ONLY (security win).

**Missing**: Ed25519 signing infra, metrics-baseline capture, Tier 2 proposal queue, auto-merge bridge to main.

### Tier 1 — Execute existing tasks (Week 1, ship first)
- Daemon mirrors `packages/cleo/src/gc/daemon.ts` pattern (node-cron v4 sidecar per D014)
- Picker: `cleo orchestrate ready` → `cleo next`
- Worker: `cleo orchestrate spawn` → Claude Sonnet (OAuth, free) / Ollama+Gemma3-E4B-it fallback
- Kill switch: `cleo sentient stop` sets flag; daemon checks per tick
- **Tier 1 never mutates main** → no Ed25519 required yet

### Tier 2 — Propose tasks (Week 2)
- Queue: reuse `tasks` table with `status='proposed'` (additive enum, zero migration)
- Inputs: BRAIN recurring pain (≥3 occurrences), nexus anomalies, failing/flaky tests, coverage gaps
- Approval CLI: `cleo propose {list|accept|reject|diff}`
- Safety: prompt-hygiene pass (no tools/memory reads at ingest), 3 proposals/day rate limit

### Tier 3 — Sandbox experiments with auto-merge (Week 3-4, gated on llmtxt v2026.4.8)
- Host worktree model: `git worktree add /mnt/projects/cleo-sandbox/experiments/<id>` (source mount stays RO)
- New gate: `metricsImproved` (extends ADR-051 EvidenceAtom union with `metrics-delta:` atom)
- Ed25519 signing via llmtxt `AgentSession` receipts → `.cleo/audit/receipts.jsonl` (append-only, hash-chained)
- Auto-merge: `git merge --ff-only` only; straight-line history → trivially revertable
- Kill switch: `cleo revert --from <receiptId>` walks chain, squashed revert, `kind:"revert"` receipt, all tiers pause

### Security
- Source mount RO preserved (`docker-compose.yml:33`)
- Key at `~/.cleo/keys/sentient.ed25519` mode 0600
- Signer runs in separate process from experiment agent (defense-in-depth)
- ADR-051 staleness check already defeats "agent modifies own gates"

---

## T947 — llmtxt v2026.4.8 Adoption

**Not yet researched in Round 1.** Issue #96 has a clear step matrix (0-7) ranging from risk:none/5min (version bump) to risk:high/1week (P2P mesh). Propose dispatching Round 2 adoption-strategist with sandbox prototype phase. Critical: **AgentSession is Tier 3 blocker per T946 design**.

---

## T948 — SDK + REST Surface

**Key finding: the service layer already exists.**

### Current state
- `@cleocode/core`'s `Cleo` facade is built at `packages/core/src/cleo.ts:1-140`
- Facade contract lives at `packages/contracts/src/facade.ts:264-584`
- CLI dispatch already delegates to core (`packages/cleo/src/dispatch/domains/tasks.ts:68-110`)
- **Studio violates DRY**: routes at `packages/studio/src/routes/api/tasks/+server.ts:33-80` run raw SQL bypassing core

### Recommended package layout
```
packages/cleo-sdk/       # thin re-export of core facade (zero new logic)
  src/index.ts           # createCleo(opts) → Cleo instance
  src/rest/              # optional fetch client for cleo-api
  src/stream/            # AsyncIterable wrappers

packages/cleo-api/       # standalone REST server (Hono — already in Studio deps)
  src/server.ts
  src/routes/tasks.ts    # GET /v1/tasks/:id → envelope(cleo.tasks.computeView(id))
```

### Refactor scope
- Studio routes shrink to: `await createCleo({cwd}).tasks.list(...)` → no raw SQL anywhere
- CLI keeps argv/envelope/exit-code duties but delegates logic to SDK
- `cleo sdk describe [domain]` CLI for live LLM tool introspection
- OpenClaw (issue #97) drops `child_process` wrapping

### SDK discovery for LLMs
- TSDoc on facade → forge-ts generates `llms.txt` + `SKILL.md` + OpenAPI 3.2
- Agents fetch `node_modules/@cleocode/cleo-sdk/llms.txt` or live `cleo sdk describe tasks`

---

## Proposed Wave Plan

| Wave | Tasks | Ship | Dependencies |
|---|---|---|---|
| **W1** | T943 Option D (view + `computeTaskView`) + T948 SDK promotion | 1-2 weeks | None |
| **W2** | T944 Ontology migration (additive kind+scope) + T946 Tier 1 daemon | 1-2 weeks | W1 SDK for `cleo sentient` surface |
| **W3** | T945 Universal Graph auto-populate + T947 llmtxt upgrade v2026.4.8 | 2 weeks | W1 SDK |
| **W4** | T946 Tier 2 proposals + T946 Tier 3 sandbox auto-merge | 2 weeks | W3 llmtxt AgentSession |
| **W5** | Retire `tasks.pipelineStage` (complete Option C convergence) | 1 week | W1 parity test green for 1 release |

---

## Round 2 Options

1. **Challenge Round**: contrarians attack Round 1 advocates (e.g. kill Option D claim, kill kind+scope claim)
2. **Research Round**: T945 graph + T947 llmtxt deep research (missing from R1)
3. **Audit Round**: neutral evaluators fact-check Round 1 claims
4. **Synthesize + Decide**: skip more research, owner decides now with Round 1 output

---

## References

- Agent outputs: retained in parent task results (T943-C, T943-D, T944, T946, T948)
- ADR-051: `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- D014: BRAIN memory (node-cron v4 sidecar, Claude Sonnet OAuth, Ollama Gemma3)
- Issue #96: llmtxt v2026.4.8 step matrix
- Issue #97: OpenClaw Command Center SDK need
