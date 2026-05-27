# T447 — CLI Coverage Specification
# Registry-to-CLI Gap Classification

**Date**: 2026-04-10
**Task**: T447 (Specification — CLI System Integrity)
**Parent**: T443 (CLI System Audit Epic)
**ADR reference**: ADR-042 (`.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md`)
**Registry source of truth**: `packages/cleo/src/dispatch/registry.ts` (231 ops)
**Constitution baseline**: `docs/specs/CLEO-OPERATION-CONSTITUTION.md` (209 ops before this ADR)

---

## Purpose

This specification classifies every operation present in the dispatch registry that has no
CLI handler (no `dispatchFromCli` / `dispatchRaw` call in any command module). Each operation
receives one of three dispositions:

| Category | Definition | Build action |
|----------|------------|-------------|
| **needs-cli** | Users or agents would reasonably invoke from terminal; absence creates friction | Add CLI command or subcommand |
| **agent-only** | Programmatic / orchestrator dispatch only; a terminal surface adds no value | No CLI needed |
| **deferred** | Tier-2 advanced feature, specialized tooling, or known low priority | Track for future sprint |

---

## Methodology

**CLI coverage analysis** was performed by scanning all 99 command module files under
`packages/cleo/src/cli/commands/` for calls to `dispatchFromCli` and `dispatchRaw` using
multi-line regex extraction. The `map.ts` command uses a variable gateway (`opts['store'] ?
'mutate' : 'query'`) covering both forms of `admin.map`.

**Verified totals** (as of 2026-04-10):

| Metric | Count |
|--------|-------|
| Registry operations | 231 |
| CLI-covered operations | 143 |
| Uncovered operations (this spec) | 84 |
| Conduit ops (will move to orchestrate per ADR-042) | 5 |
| Net non-conduit uncovered | 79 |

> The audit report estimated ~89 uncovered. The verified count is 84. The difference is
> explained by: `pipeline.stage.guidance` (covered via `lifecycle.ts`), `check.workflow.compliance`
> (covered via `compliance.ts`), `admin.config.set-preset` (covered via `config.ts`), `admin.map`
> (covered via `map.ts` with variable gateway), and `tasks.impact` (covered via `lifecycle.ts`).
> These 5 operations appear in the audit's "Phase 2 undocumented" list but do have CLI coverage.

---

## Section 1: Conduit Domain (5 operations)

Per ADR-042 Decision 1, these 5 operations MUST be moved from `domain: 'conduit'` to
`domain: 'orchestrate'` with `operation: 'conduit.*'` namespace before CLI or constitution
work proceeds. They are classified here under their post-migration identity.

Per ADR-042 Decision 2, all 5 conduit ops are classified **experimental** — no CLI surface
needed until the conduit messaging workflow is formally defined (Shell 2 of the 4-shell Conduit
stack per the Conduit Layered Stack architecture).

| Operation (post-migration) | Gateway | Disposition | Rationale |
|---------------------------|---------|-------------|-----------|
| `orchestrate.conduit.status` | query | **agent-only** | Connection/unread-count polling is orchestrator state management; not a terminal UX |
| `orchestrate.conduit.peek` | query | **agent-only** | One-shot poll without ack; programmatic pattern only |
| `orchestrate.conduit.start` | mutate | **agent-only** | Start polling loop; orchestrator lifecycle op |
| `orchestrate.conduit.stop` | mutate | **agent-only** | Stop polling loop; orchestrator lifecycle op |
| `orchestrate.conduit.send` | mutate | **deferred** | When the conduit workflow is formalized, `cleo conduit send` (or `cleo message send`) will be a natural CLI surface; deferred pending workflow documentation |

**Conduit CLI count contribution**: 0 needs-cli / 4 agent-only / 1 deferred

---

## Section 2: Tasks Domain (7 operations)

Registry count: 32 | CLI-covered: 25 | Uncovered: 7

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `tasks.cancel` | mutate | **needs-cli** | Distinct from `tasks.archive` (soft terminal state, reversible via `tasks.restore`); operators need `cleo cancel <id>` for task lifecycle management |
| `tasks.claim` | mutate | **needs-cli** | Multi-agent mutex ownership; agents need `cleo claim <id>` to prevent double-work; canonical per ADR-042 |
| `tasks.unclaim` | mutate | **needs-cli** | Pair of `tasks.claim`; needed for ownership release; canonical per ADR-042 |
| `tasks.complexity.estimate` | query | **agent-only** | Automated complexity scoring; called by orchestrators during planning; not a manual terminal operation |
| `tasks.sync.links` | query | **deferred** | External provider sync; tier-2 feature requiring provider config; low operator demand |
| `tasks.sync.links.remove` | mutate | **deferred** | Pair of `sync.links`; same reasoning |
| `tasks.sync.reconcile` | mutate | **deferred** | Full reconciliation with external provider; automated as part of provider workflows, not manual terminal use |

**Tasks CLI count contribution**: 3 needs-cli / 1 agent-only / 3 deferred

---

## Section 3: Session Domain (4 operations)

Registry count: 15 | CLI-covered: 11 | Uncovered: 4

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `session.show` | query | **needs-cli** | Shows a specific session by ID (absorbs `debrief.show` via include param); operators need `cleo session show <id>` to inspect past sessions |
| `session.suspend` | mutate | **needs-cli** | Suspends an active session without ending it; agents and operators need `cleo session suspend` for pause-and-resume workflows |
| `session.context.drift` | query | **agent-only** | Automated context drift detection; called by orchestrators during session health monitoring; not a manual terminal pattern |
| `session.record.assumption` | mutate | **agent-only** | Programmatic assumption logging; agents record assumptions during work; analogous to `session.record.decision` which is covered but rarely invoked manually |

**Session CLI count contribution**: 2 needs-cli / 2 agent-only / 0 deferred

---

## Section 4: Memory Domain (8 operations)

Registry count: 18 | CLI-covered: 10 | Uncovered: 8

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `memory.decision.find` | query | **needs-cli** | Operators and agents need to search decisions from the terminal; companion to the covered `memory.observe` / `memory.find` CLI surface |
| `memory.decision.store` | mutate | **agent-only** | Programmatic decision storage; agents call this automatically; `cleo observe` is the human-facing equivalent |
| `memory.graph.show` | query | **needs-cli** | PageIndex graph node inspection; useful for operators debugging knowledge graph state |
| `memory.graph.neighbors` | query | **deferred** | Graph traversal; tier-2 feature for advanced knowledge graph workflows; low operator demand relative to cost of exposing graph internals |
| `memory.graph.add` | mutate | **deferred** | Direct graph manipulation; agent-driven, low manual use case |
| `memory.graph.remove` | mutate | **deferred** | Direct graph manipulation; same reasoning |
| `memory.link` | mutate | **agent-only** | Programmatic brain-entry-to-task linking; agents call this as part of automated memory workflows |
| `memory.search.hybrid` | query | **needs-cli** | Hybrid FTS5+vector+graph search; this is the most powerful memory search operation; operators need `cleo memory search --hybrid <query>` for comprehensive knowledge retrieval |

**Memory CLI count contribution**: 3 needs-cli / 2 agent-only / 3 deferred

---

## Section 5: Check Domain (5 operations)

Registry count: 18 | CLI-covered: 13 | Uncovered: 5

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `check.gate.status` | query | **needs-cli** | Read-only gate state; operators need `cleo gate status` or `cleo check gate` to inspect pipeline gates without modifying them; canonical per ADR-042 |
| `check.gate.set` | mutate | **needs-cli** | Set/reset pipeline gates; operators need manual gate control for pipeline management; canonical per ADR-042 |
| `check.compliance.record` | mutate | **agent-only** | Programmatic compliance event recording; agents write compliance events during automated workflow execution |
| `check.chain.validate` | query | **deferred** | WarpChain definition validation; tier-2 feature; WarpChain is tier-2 throughout the pipeline domain; low operator demand |
| `check.output` | query | **deferred** | Check output validation; purpose is ambiguous from description alone; classified deferred pending clarification |

**Check CLI count contribution**: 2 needs-cli / 1 agent-only / 2 deferred

---

## Section 6: Pipeline Domain (11 operations)

Registry count: 32 | CLI-covered: 21 | Uncovered: 11

WarpChain (`chain.*`) operations are marked tier 2 throughout the constitution. They are
advanced workflow composition tools with specialized use cases.

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `pipeline.chain.list` | query | **deferred** | WarpChain tier-2; list chain definitions; deferred until WarpChain workflow is formalized for operator use |
| `pipeline.chain.show` | query | **deferred** | WarpChain tier-2; show chain definition by ID; same reasoning |
| `pipeline.chain.add` | mutate | **deferred** | WarpChain tier-2; store a validated chain definition; programmatic in current usage |
| `pipeline.chain.advance` | mutate | **deferred** | WarpChain tier-2; advance chain instance; orchestrator-driven |
| `pipeline.chain.instantiate` | mutate | **deferred** | WarpChain tier-2; create chain instance for epic; orchestrator-driven |
| `pipeline.release.channel.show` | query | **needs-cli** | Shows current release channel from git branch; operators and CI pipelines need `cleo release channel` to determine release track (latest/beta/alpha) |
| `pipeline.release.rollback` | mutate | **needs-cli** | Release rollback; operators need `cleo release rollback` for production incident response; high operational value |
| `pipeline.stage.gate.pass` | mutate | **needs-cli** | Manually pass a stage gate; operators need `cleo stage gate pass` for CI/CD gate management |
| `pipeline.stage.gate.fail` | mutate | **needs-cli** | Manually fail a stage gate; operators need `cleo stage gate fail` for CI/CD gate management; pair with gate.pass |
| `pipeline.stage.history` | query | **needs-cli** | Stage transition history; operators need `cleo stage history` for pipeline audit trails and debugging |
| `pipeline.stage.reset` | mutate | **deferred** | Stage reset is a destructive recovery operation; deferred pending safety policy definition (should require confirmation flag) |

**Pipeline CLI count contribution**: 5 needs-cli / 0 agent-only / 6 deferred

---

## Section 7: Orchestrate Domain (11 operations, excluding conduit)

Registry count: 19 (post ADR-042: 14 native + 5 absorbed conduit) | CLI-covered: 8 | Uncovered native: 11

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `orchestrate.classify` | query | **agent-only** | CANT team registry classification; entry point for CANT-based request routing; orchestrators call this programmatically; not a manual terminal operation; canonical per ADR-042 |
| `orchestrate.fanout` | mutate | **agent-only** | Parallel spawn of N agents via `Promise.allSettled`; core orchestration primitive; programmatic only; canonical per ADR-042 |
| `orchestrate.fanout.status` | query | **agent-only** | Poll fanout progress by manifest entry ID; programmatic companion to `orchestrate.fanout`; canonical per ADR-042 |
| `orchestrate.bootstrap` | query | **agent-only** | Orchestrator bootstrap sequence; called by orchestrators at session start; programmatic |
| `orchestrate.status` | query | **needs-cli** | Orchestration status / active orchestrator state; operators need `cleo orchestrate status` to inspect running orchestration sessions |
| `orchestrate.handoff` | mutate | **agent-only** | Composite handoff (context.inject → session.end → spawn); automated transition between orchestration phases; programmatic only |
| `orchestrate.spawn.execute` | mutate | **agent-only** | Execute spawn for a task using adapter registry; called by orchestrators after task assignment; programmatic only |
| `orchestrate.parallel` | mutate | **agent-only** | Parallel start/end (absorbs parallel.start and parallel.end via action param); orchestrator lifecycle management; programmatic |
| `orchestrate.tessera.list` | query | **deferred** | List Tessera templates; tier-2 advanced workflow feature; low operator demand at present |
| `orchestrate.tessera.instantiate` | mutate | **deferred** | Instantiate Tessera template into chain instance; tier-2 advanced workflow feature; orchestrator-driven |
| `orchestrate.unblock.opportunities` | query | **agent-only** | Unblocking opportunity analysis; automated orchestrator reasoning; programmatic only |

**Orchestrate CLI count contribution**: 1 needs-cli / 8 agent-only / 2 deferred

---

## Section 8: Admin Domain (8 operations)

Registry count: 39 | CLI-covered: 31 | Uncovered: 8

> Note: `admin.map` (both query and mutate) is covered by `map.ts` which selects gateway
> based on the `--store` flag. `admin.config.set-preset` is covered by `config.ts`.
> `admin.paths`, `admin.smoke`, `admin.scaffold-hub`, `admin.hooks.matrix` are all covered.

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `admin.init` | mutate | **needs-cli** | Project initialization; foundational bootstrapping operation; should have `cleo admin init` as an explicit dispatch-routed path (distinct from the bypass `init.ts` which runs before dispatch is available) |
| `admin.detect` | mutate | **needs-cli** | Refresh `project-context.json`; operators need `cleo admin detect` or `cleo detect` (dispatch-routed) to re-detect project type after significant codebase changes |
| `admin.install.global` | mutate | **deferred** | Refresh global CLEO setup; tier-2 admin operation; typically run once at install; low demand for terminal surface |
| `admin.job` | query | **needs-cli** | Job status and list (absorbs job.status and job.list via action param); operators need `cleo admin job` or `cleo job` to inspect background jobs |
| `admin.job.cancel` | mutate | **needs-cli** | Cancel a running background job; operators need `cleo admin job cancel` for job lifecycle management |
| `admin.migrate` | mutate | **deferred** | Database migration; typically automated; requires schema knowledge; deferred pending migration workflow documentation |
| `admin.cleanup` | mutate | **deferred** | Admin cleanup; purpose is generic from description; deferred pending clarification of cleanup scope |
| `admin.context.inject` | mutate | **agent-only** | Inject protocol content into session context (moved from session domain per T5615); agents call this programmatically during session setup; not a manual terminal pattern |

**Admin CLI count contribution**: 4 needs-cli / 1 agent-only / 3 deferred

---

## Section 9: Nexus Domain (8 operations)

Registry count: 22 | CLI-covered: 14 | Uncovered: 8

> Note: `nexus.show`, `nexus.graph`, `nexus.share.status` appear in the constitution tables
> and were covered by the older audit, but are confirmed uncovered in CLI dispatch scan.

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `nexus.show` | query | **needs-cli** | Show a specific project by name or hash; operators need `cleo nexus show <name>` to inspect project details; already in constitution (missing CLI implementation) |
| `nexus.graph` | query | **needs-cli** | Global dependency graph across all projects; operators need `cleo nexus graph` for cross-project dependency visualization; already in constitution |
| `nexus.share.status` | query | **needs-cli** | Sharing status; operators need `cleo nexus share status` to check project sharing configuration; already in constitution |
| `nexus.transfer` | mutate | **needs-cli** | Transfer tasks between NEXUS projects; canonical per ADR-042; operators need `cleo nexus transfer` for cross-project task handoff |
| `nexus.transfer.preview` | query | **needs-cli** | Preview cross-project task transfer without committing; canonical per ADR-042; required safety step before `nexus.transfer` |
| `nexus.permission.set` | mutate | **deferred** | Update project permissions; tier-2 administration; low demand relative to other NEXUS ops; deferred pending permission model documentation |
| `nexus.share.snapshot.export` | mutate | **deferred** | Export project snapshot; tier-2 sharing feature; specialized use case; deferred |
| `nexus.share.snapshot.import` | mutate | **deferred** | Import project snapshot; tier-2 sharing feature; pair with export; deferred |

**Nexus CLI count contribution**: 5 needs-cli / 0 agent-only / 3 deferred

---

## Section 10: Tools Domain (17 operations)

Registry count: 25 | CLI-covered: 8 | Uncovered: 17

The tools domain has the lowest coverage rate (32%) among non-conduit domains. Its uncovered
operations fall into three sub-domains: `adapter.*`, `provider.*`, and advanced `skill.*`.

### 10.1 Adapter Sub-domain (6 operations)

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `tools.adapter.list` | query | **needs-cli** | List all discovered provider adapters; operators and agents need `cleo adapter list` to see available adapters; foundational discovery operation |
| `tools.adapter.show` | query | **needs-cli** | Show details for a specific adapter; companion to `adapter.list`; operators need `cleo adapter show <id>` |
| `tools.adapter.detect` | query | **needs-cli** | Detect active providers in current environment; operators need `cleo adapter detect` to see what's available in current shell |
| `tools.adapter.health` | query | **needs-cli** | Health status for all adapters; operators need `cleo adapter health` for provider diagnostics |
| `tools.adapter.activate` | mutate | **deferred** | Load and activate a provider adapter; typically orchestrator-driven or automated; deferred pending adapter lifecycle workflow documentation |
| `tools.adapter.dispose` | mutate | **deferred** | Dispose one or all adapters; cleanup operation; deferred pending adapter lifecycle workflow documentation |

### 10.2 Provider Sub-domain (6 operations)

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `tools.provider.list` | query | **needs-cli** | List all providers; operators need `cleo provider list` as the human-facing complement to `adapter.list`; foundational discovery |
| `tools.provider.detect` | query | **needs-cli** | Detect available providers; operators need `cleo provider detect` to see current environment capabilities |
| `tools.provider.supports` | query | **needs-cli** | Check if provider supports a capability; operators need `cleo provider supports <provider> <capability>` for capability routing decisions |
| `tools.provider.hooks` | query | **deferred** | List providers by hook event support; specialized query; useful but low priority compared to basic provider discovery |
| `tools.provider.inject` | mutate | **agent-only** | Provider injection; programmatic operation called by agents when activating provider integrations |
| `tools.provider.inject.status` | query | **agent-only** | Provider injection status; programmatic monitoring companion to `provider.inject` |

### 10.3 Advanced Skill Sub-domain (5 operations)

| Operation | Gateway | Disposition | Rationale |
|-----------|---------|-------------|-----------|
| `tools.skill.catalog` | query | **needs-cli** | CAAMP catalog (absorbs catalog.protocols/profiles/resources/info via type param); operators need `cleo skill catalog` to browse available protocols and profiles |
| `tools.skill.dependencies` | query | **needs-cli** | Skill dependency graph; operators need `cleo skill dependencies <skill>` to understand skill composition before installing |
| `tools.skill.dispatch` | query | **agent-only** | Skill dispatch metadata query; programmatic; called by orchestrators selecting skills |
| `tools.skill.precedence` | query | **agent-only** | Skill precedence resolution (absorbs precedence.show and precedence.resolve); orchestrator routing logic; programmatic |
| `tools.skill.spawn.providers` | query | **deferred** | List spawn-capable providers by capability; specialized orchestration query; deferred pending spawn workflow documentation |

**Tools CLI count contribution**: 9 needs-cli / 4 agent-only / 4 deferred

---

## Section 11: Summary Classification Table

### By Domain

| Domain | Uncovered | needs-cli | agent-only | deferred |
|--------|-----------|-----------|------------|----------|
| tasks | 7 | 3 | 1 | 3 |
| session | 4 | 2 | 2 | 0 |
| memory | 8 | 3 | 2 | 3 |
| check | 5 | 2 | 1 | 2 |
| pipeline | 11 | 5 | 0 | 6 |
| orchestrate (native) | 11 | 1 | 8 | 2 |
| conduit (→ orchestrate.conduit.*) | 5 | 0 | 4 | 1 |
| admin | 8 | 4 | 1 | 3 |
| nexus | 8 | 5 | 0 | 3 |
| tools | 17 | 9 | 4 | 4 |
| sticky | 0 | — | — | — |
| **Total** | **84** | **34** | **23** | **27** |

### Needs-CLI Master List (34 operations)

These operations MUST have CLI surface built. They are ordered by domain then urgency.

| # | Operation | Gateway | Priority note |
|---|-----------|---------|--------------|
| 1 | `tasks.cancel` | mutate | Common task lifecycle op |
| 2 | `tasks.claim` | mutate | Multi-agent mutex; canonical per ADR-042 |
| 3 | `tasks.unclaim` | mutate | Pair of claim; canonical per ADR-042 |
| 4 | `session.show` | query | Session inspection; in constitution already |
| 5 | `session.suspend` | mutate | Pause/resume workflow |
| 6 | `memory.decision.find` | query | Decision search; agent and operator use |
| 7 | `memory.graph.show` | query | Graph node inspection |
| 8 | `memory.search.hybrid` | query | Most powerful memory search |
| 9 | `check.gate.status` | query | Pipeline gate inspection; canonical per ADR-042 |
| 10 | `check.gate.set` | mutate | Pipeline gate control; canonical per ADR-042 |
| 11 | `pipeline.release.channel.show` | query | Release track detection |
| 12 | `pipeline.release.rollback` | mutate | Production incident response |
| 13 | `pipeline.stage.gate.pass` | mutate | CI/CD gate management |
| 14 | `pipeline.stage.gate.fail` | mutate | CI/CD gate management |
| 15 | `pipeline.stage.history` | query | Pipeline audit trail |
| 16 | `orchestrate.status` | query | Active orchestration inspection |
| 17 | `admin.init` | mutate | Project bootstrapping (dispatch-routed path) |
| 18 | `admin.detect` | mutate | Project type re-detection |
| 19 | `admin.job` | query | Background job monitoring |
| 20 | `admin.job.cancel` | mutate | Background job management |
| 21 | `nexus.show` | query | Project inspection; in constitution already |
| 22 | `nexus.graph` | query | Cross-project dependency graph; in constitution |
| 23 | `nexus.share.status` | query | Sharing status; in constitution already |
| 24 | `nexus.transfer` | mutate | Cross-project task handoff; canonical per ADR-042 |
| 25 | `nexus.transfer.preview` | query | Safe preview before transfer; canonical per ADR-042 |
| 26 | `tools.adapter.list` | query | Adapter discovery |
| 27 | `tools.adapter.show` | query | Adapter details |
| 28 | `tools.adapter.detect` | query | Active adapter detection |
| 29 | `tools.adapter.health` | query | Adapter diagnostics |
| 30 | `tools.provider.list` | query | Provider discovery |
| 31 | `tools.provider.detect` | query | Provider capability detection |
| 32 | `tools.provider.supports` | query | Capability routing check |
| 33 | `tools.skill.catalog` | query | CAAMP protocol/profile browser |
| 34 | `tools.skill.dependencies` | query | Skill dependency inspection |

---

## Section 12: Reconciled Operation Count Table

This table shows the full count reconciliation per ADR-042, incorporating the conduit fold
and the 16 canonical additions.

### Per-Domain Registry vs Constitution (Pre-ADR-042)

| Domain | Registry | Constitution (before) | Delta | ADR-042 canonical adds |
|--------|----------|-----------------------|-------|------------------------|
| tasks | 32 | 29 | +3 | +3 (impact, claim, unclaim) |
| session | 15 | 15 | 0 | 0 |
| memory | 18 | 18 | 0 | 0 |
| check | 18 | 17 | +1 | +1 (workflow.compliance) |
| pipeline | 32 | 31 | +1 | +1 (stage.guidance) |
| orchestrate | 19 | 16 | +3 | +3 (classify, fanout, fanout.status) |
| tools | 25 | 25 | 0 | 0 |
| admin | 39 | 32 | +7 | +7 (paths, smoke, scaffold-hub, config.presets, config.set-preset, hooks.matrix, backup[query]) |
| nexus | 22 | 20 | +2 | +2 (transfer, transfer.preview) |
| sticky | 6 | 6 | 0 | 0 |
| conduit | 5 | 0 | +5 | 0 (fold into orchestrate; experimental, not canonical) |
| **Total** | **231** | **209** | **+22** | **+16** |

> Session: The T445 consensus phase reported a session discrepancy, but direct verification
> of registry and constitution both confirm 15 session operations. This is a verified false
> positive from the consensus phase, corrected in ADR-042.

### Grand Total Reconciliation

| Source | Count | Notes |
|--------|-------|-------|
| Constitution before ADR-042 | 209 | Documented baseline |
| Registry (verified by 3 agents + this spec) | 231 | Source of truth |
| Delta | +22 | All 22 accounted for in ADR-042 |
| Canonical additions (ADR-042 Decision 2) | +16 | Must be added to constitution |
| Experimental (not added to constitution) | +6 | 5 conduit ops + 1 admin.map (query and mutate counted as 2 but both experimental) |
| **Constitution target after ADR-042** | **225** | 209 + 16 canonical additions |
| Registry-constitution gap after ADR-042 | 6 | Intentional: experimental ops not yet at stability bar |

> The 6 experimental operations (orchestrate.conduit.status, orchestrate.conduit.peek,
> orchestrate.conduit.start, orchestrate.conduit.stop, orchestrate.conduit.send,
> admin.map[query], admin.map[mutate]) remain in the registry without constitutional
> documentation. Registry presence without constitutional documentation is the correct
> state for experimental operations per ADR-030.

> Reconciliation note: ADR-042 states "7 experimental" and separately "admin.map query and
> mutate" = 2. 5 conduit + 2 admin.map = 7 experimental. The gap of 6 vs 7 in ADR-042 is
> because admin.map has CLI coverage (map.ts handles both gateways), so it does not appear
> in the uncovered operations list but remains experimental from a constitutional standpoint.
> The registry-constitution gap of 6 is: 5 conduit ops (now orchestrate.conduit.*) + 1 for
> admin.map[both gateways counted as one constitutional entry].

---

## Section 13: Implementation Priority Guidance

This section is advisory only. CLI implementation is a separate IVTR task (not T447 scope).

### Priority 1 — Canonical Ops with No CLI (High)

These are classified canonical in ADR-042 but have no CLI surface. Build first:

- `tasks.claim`, `tasks.unclaim` — multi-agent ownership mutex
- `tasks.cancel` — task lifecycle completeness
- `nexus.transfer`, `nexus.transfer.preview` — cross-project handoff
- `check.gate.status`, `check.gate.set` — pipeline gate management
- `session.show`, `session.suspend` — session lifecycle completeness

### Priority 2 — High Operator Value (Medium)

- `tools.adapter.list/show/detect/health` — provider ecosystem visibility
- `tools.provider.list/detect/supports` — provider capability discovery
- `pipeline.release.rollback` — production incident response
- `pipeline.stage.gate.pass/fail` — CI/CD gate management
- `nexus.show`, `nexus.graph`, `nexus.share.status` — NEXUS introspection (in constitution already)

### Priority 3 — Deferred

All 27 deferred operations. No action until a formal workflow need is documented.

---

## Section 14: Non-Decisions and Exclusions

- **admin.map (both gateways)**: Has CLI coverage via `map.ts`. Classified experimental in
  ADR-042 from a constitutional standpoint but is not in the uncovered set.
- **pipeline.stage.guidance**: Has CLI coverage via `lifecycle.ts`. Not in uncovered set.
- **check.workflow.compliance**: Has CLI coverage via `compliance.ts`. Not in uncovered set.
- **tasks.impact**: Has CLI coverage. Canonical per ADR-042. Not in uncovered set.
- **admin.config.set-preset**: Has CLI coverage via `config.ts`. Canonical per ADR-042.
- **17 intentional bypass commands**: `init.ts`, `env.ts`, `otel.ts`, and 14 others documented
  in the audit report as having no dispatch route by design. These are out of scope for this spec.

---

*Coverage specification complete. Classify all ~84 uncovered registry operations. See Section 11
for disposition summary. See Section 12 for reconciled counts matching ADR-042 targets.*
