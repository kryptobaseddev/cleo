# ADR-030: Operation Model Rationalization (268→164)

**Status**: Accepted
**Date**: 2026-03-08
**Task**: T5611
**Epic**: T5517

---

## Context

Since the memory domain cutover (T5241, ADR-021) brought the operation count to 201, the CLEO registry continued to grow without a formal admission gate. By the time T5517 was scoped, the registry had reached **268 operations** (153 query + 115 mutate) across 10 domains.

Three concrete problems triggered this rationalization:

1. **Agent hallucination from bloated Tier 0.** The Tier 0 surface area had grown to 155 operations — virtually the entire registry. Agents presented with 155 operations at cold-start have no meaningful signal about what to call first. The mandatory efficiency sequence (session.status, admin.dash, tasks.current, tasks.next, tasks.show, session.start, tasks.complete, memory.find, memory.observe, admin.help) was indistinguishable from 145 ancillary operations cluttering the same tier.

2. **Nexus filesystem fallback bug.** `nexus.status` and `nexus.list` were assigned tier 2, meaning they were invisible until an agent already knew nexus was relevant. Agents defaulted to filesystem discovery instead of using CLEO operations. The tier assignment was wrong, not the operations themselves.

3. **Unbounded growth with no admission gate.** New features were added to the registry by default at tier 0 with no challenge. The `tools.skill.enable` and `tools.skill.disable` aliases violated VERB-STANDARDS (ADR-017) and had been silently routing to install/uninstall handlers for months. Stub operations like `tools.skill.configure` (always returned `{configured:true}`) and `tools.issue.generate.config` existed in the registry with no real behavior. The registry had no mechanism to prevent this.

The T5517 epic ran 10 domain review tasks (T5530–T5566), a tier assignment audit (T5608), a ct-cleo skill audit (T5607), and a cross-domain synthesis (T5609) to produce the decisions captured in this ADR.

---

## Decision

Rationalize the CLEO operation registry from 268 to **164 operations** (158 after plugin extraction), using four evaluation criteria applied to every operation:

1. **LAFS** (Lean, Agent-First, Functional, Scalable): Does this operation earn its place in a lean registry? Is it designed for agent callers, not human CLIs? Does it perform real work? Will it remain valid as the system scales?

2. **Progressive Disclosure**: Operations should be discoverable at the tier that matches when an agent needs them. Tier 0 = cold-start minimum. Tier 1 = after initial context. Tier 2 = advanced or specialized workflows.

3. **MVI** (Minimum Viable Interface): If two operations can be unified via a `mode`, `action`, `include`, or `scope` parameter without losing information fidelity, they should be.

4. **Agent-first ergonomics**: The mandatory efficiency sequence operations are non-negotiable tier 0. Every other operation must justify its tier assignment against the question: "Would an agent on a cold-start reasonably need this before it has any context?"

The rationalization produces these outcomes:

- **Operations removed**: 26 (aliases, stubs, duplicates, operations subsumed by LAFS-compliant alternatives)
- **Operations merged**: 57 eliminated by unification (e.g., `reopen` + `unarchive` → `restore {from}`)
- **Operations cross-moved**: 7 (net-neutral; change domain but not system count)
- **Operations extracted to plugin**: 6 (issue.* → ct-github-issues; not counted in core)
- **Net reduction**: -104 operations (-39% of surface area)

---

## Principles Enforced

### Five Challenge Questions

Every operation was evaluated against five questions before being retained:

1. Is this operation's use case covered by an existing operation with a parameter?
2. Does removing this operation force agents to use the CLI or filesystem instead?
3. Is this operation documented in at least one real agent workflow or mandatory sequence?
4. Does this operation have distinct schema-level behavior (not just a renamed alias for the same handler)?
5. Would a new CLEO user discover this operation naturally via `admin.help` progressive disclosure?

Operations failing questions 1, 4, or 5 without compensating answers to 2 or 3 were candidates for removal or merge.

### LAFS Compliance

An operation is LAFS-compliant when:
- It has a non-empty, non-stub implementation with real business logic
- Its name follows VERB-STANDARDS (ADR-017): add, show, find, list, start, stop, complete, restore, etc.
- It is not an exact alias routing to another operation's handler via switch-case
- It will remain valid across the next two major CLEO releases

### MVI Mandate

Where two or more operations differ only in a scalar parameter (status filter, action type, include flag), they MUST be unified. Examples from this rationalization:

- `tasks.reopen` + `tasks.unarchive` → `tasks.restore {from:"done"|"archive"}`
- `tasks.promote` → `tasks.reparent {newParentId: null}`
- `pipeline.release.prepare` + `pipeline.release.changelog` + `pipeline.release.commit` + `pipeline.release.tag` + `pipeline.release.push` + `pipeline.release.gates.run` → `pipeline.release.ship {step}`
- `admin.health` + `admin.doctor` → `admin.health {mode:"check"|"diagnose"}`
- `orchestrate.parallel.start` + `orchestrate.parallel.end` → `orchestrate.parallel {action:"start"|"end"}`

The MVI mandate does not apply when the operations have different schemas, different required parameters, or different side effects that cannot be expressed as a single operation contract.

### Tier Gate Invariant

Tier 0 MUST contain only operations that an agent reasonably needs before it has any project context. The mandatory efficiency sequence defines the non-negotiable tier 0 floor:

```
query session status     → step 1
query admin dash         → step 2
query tasks current      → step 3
query tasks next         → step 4
query tasks show         → step 5
mutate session start     → agent loop begin
mutate tasks complete    → agent loop end
memory.find              → memory protocol read
memory.observe           → memory protocol write
query admin help         → escalation
```

All 10 of these operations are confirmed tier 0 after rationalization. No other tier classification is non-negotiable.

### Plugin Boundary

An operation belongs in a plugin (not core) when it satisfies any of:
- It is tightly coupled to an external platform (GitHub, Linear, Jira) rather than to CLEO's internal data model
- Removing it from core would not break any mandatory workflow
- Its implementation imports platform-specific SDKs or reads platform-specific configuration files

The `ct-github-issues` plugin boundary established by this ADR (6 ops) is the first application of this principle. The `src/core/issue/` module and `template-parser.ts` move with the plugin.

---

## New Invariant: §11 Tier Gate Rule

> "No tier-2 gate may exist without an explicit escalation path surfaced at tier 0."

This invariant means: any cluster of operations at tier 2 must be reachable by an agent starting from tier 0, without requiring the agent to already know the tier-2 cluster exists. The escalation path may be:

- A tier-0 or tier-1 operation that hints at the tier-2 cluster (e.g., `nexus.status` at tier 1 as the entry point to the nexus tier-2 cluster)
- An `escalationHint` metadata field in the registry entry, emitted by `admin.help` in its tier-0 or tier-1 response

Current tier-2 clusters after rationalization that require escalation hints:
- `pipeline.chain.*` (8 ops) — WarpChain; hint via `admin.help --tier 2`
- `check.chain.*` (2 ops) — WarpChain gate history; same hint
- `admin.token.*` (2 ops query form) — token telemetry; hint via `admin.stats`
- `admin.export/import` (2 ops) — data portability; hint via `admin.backup`
- `nexus.*` tier-2 cluster — covered by `nexus.status` + `nexus.list` at tier 1

Enforcement mechanism: add `escalationHint` as an optional metadata field to the registry entry schema. The field is emitted in `admin.help` responses at the appropriate tier. Implementation is tracked as a follow-on to T5612.

---

## Domain-by-Domain Rationale

| Domain | Before | After | Key Changes |
|--------|--------|-------|-------------|
| tasks | 32 | 21 | `exists` removed (redundant with `find {exact:true}`); `reopen`+`unarchive` → `restore {from}`; `promote` → `reparent {newParentId:null}`; `relates.find` absorbed into `relates`; `label.show` absorbed into `label.list` |
| session | 19 | 15 | `history` removed (foldable into `show` if needed); `chain.show` removed (navigable via `show.previousSessionId`); `debrief.show` → `show {include:["debrief"]}`; `context.inject` moved to admin domain |
| memory | 18 | 11 | `show` removed (covered by `fetch` with single-element array); `stats`, `contradictions`, `superseded`, `pattern.stats`, `learning.stats` removed (dashboard-only); `find` and `observe` promoted to tier 0; `unlink` removed (inverse op rarely needed) |
| check | 19 | 16 | All 5 `protocol.*` typed ops folded into `check.protocol {protocolType}`; `compliance.violations` → `compliance.summary {detail:true}`; `coherence.check` renamed to `coherence`; `test.status`+`test.coverage` → `check.test {format}`; `gate.verify` split into `gate.status` (query) + `gate.set` (mutate); 3 ops incoming from admin |
| pipeline | 42 | 26 | 6 release step ops merged into `release.ship {step}`; `phase.start`+`phase.complete` → `phase.set {action}`; `stage.gates` absorbed into `stage.status {include:["gates"]}`; `stage.prerequisites` absorbed into `stage.validate`; `manifest.pending` → `manifest.list {filter:"pending"}`; `chain.*` moved to tier 2 |
| orchestrate | 19 | 15 | `critical.path` absorbed into `analyze {mode:"critical-path"}`; `tessera.show` absorbed into `tessera.list {id}`; `parallel.start`+`parallel.end` → `parallel {action}`; phantom ops `chain.plan` and `verify` removed (not registered, dead handler code) |
| tools | 32 | 19 (13 after plugin) | `skill.enable`+`skill.disable` removed (VERB-STANDARDS violation aliases); `skill.configure` removed (stub returning `{configured:true}`); 4 `skill.catalog.*` ops parameterized into `skill.catalog {type}`; 2 `skill.precedence.*` ops parameterized; 6 `issue.*` ops extracted to `ct-github-issues` plugin; 3 TodoWrite ops incoming from admin |
| admin | 50 | 28 | `doctor` → `health {mode:"diagnose"}`; `fix` → `health {mode:"repair"}`; `restore`+`backup.restore` → `backup {action}`; `job.list` absorbed into `job {action}`; `adr.list` absorbed into `adr.find`; `snapshot.export`+`export.tasks` → `export {scope}`; `snapshot.import`+`import.tasks` → `import {scope}`; `token.list`+`token.show` → `token {action}`; `sequence` mutate form removed; 5 ops moved out (sync→tools, grade/archive.stats→check) |
| nexus | 31 | 17 | 3 exact aliases removed (`critical-path`, `blocking`, `orphans` routing to same handlers); `query` renamed to `resolve` (VERB-STANDARDS); 5 git-wrapper ops removed (`share.remotes`, `share.sync.status`, `share.sync.gitignore`, `share.remote.add/remove`, `share.push/pull`); `sync.all` absorbed into `sync {name?}`; `status`+`list` promoted to tier 1 (fixes nexus filesystem fallback bug) |
| sticky | 6 | 6 | Validated lean per T5566; no removals; entire domain demoted from tier 0 to tier 1 as a block |

---

## Tier Reclassification

### Before: Tier 0 had 155 operations

The T5608 audit identified that the entire `orchestrate`, `pipeline`, `check`, and `sticky` domains had been assigned tier 0 by default when implemented. Additionally, 19 tasks ops, 11 session ops, 22 admin ops, and 17 tools ops were wrongly tier 0. The tier had lost all discriminating power.

### After: Tier 0 has 24 operations

| Domain | Tier 0 ops | Operations |
|--------|-----------|------------|
| tasks | 10 | show, find, next, plan, current, add, update, complete, start, stop |
| session | 5 | status, handoff.show, briefing.show, start, end |
| memory | 2 | find, observe |
| check | 0 | all tier 1 or tier 2 |
| pipeline | 0 | all tier 1; chain at tier 2 |
| orchestrate | 0 | all tier 1 |
| admin | 4 | version, health, dash, help |
| tools | 3 | skill.list, provider.list, provider.detect |
| nexus | 0 | tier 1 minimum (status, list) |
| sticky | 0 | all tier 1 |
| **Total** | **24** | — |

The 24-op tier 0 is intentionally conservative. The gap between 24 and the ≤90 target is headroom. The T5608 tier audit identified up to 31 additional tier-1 candidates that could be promoted to tier 0 as operational data confirms their cold-start utility, bringing the practical upper bound to ~55 ops. The mandatory efficiency sequence ops are non-negotiable and are confirmed tier 0.

### Mandatory Promotions

Two operations were promoted from tier 1 to tier 0 because they appear in the mandatory efficiency sequence defined in CLEO-INJECTION.md:

- `memory.find` (was tier 1 after T5241 cutover) → promoted to tier 0
- `memory.observe` (was tier 1 after T5241 cutover) → promoted to tier 0

### Nexus Entry-Point Fix

`nexus.status` and `nexus.list` were promoted from tier 2 to tier 1. This directly fixes the nexus filesystem fallback behavior: agents can now discover nexus context without already knowing the tier-2 cluster exists.

---

## Plugin Extraction

### `ct-github-issues` plugin (6 ops)

The following operations move out of the core CLEO registry into the `ct-github-issues` plugin package:

| Operation | Gateway | Reason |
|-----------|---------|--------|
| `tools.issue.templates` | query | Reads `.github/ISSUE_TEMPLATE/`; GitHub coupling |
| `tools.issue.validate.labels` | query | Validates against GitHub label set |
| `tools.issue.add.bug` | mutate | Creates GitHub issues via template |
| `tools.issue.add.feature` | mutate | Creates GitHub issues via template |
| `tools.issue.add.help` | mutate | Creates GitHub issues via template |
| `tools.issue.generate.config` | mutate | GitHub YAML generation (stub with no real behavior — remove entirely) |

The `src/core/issue/` module and `template-parser.ts` implementation move with the plugin.

`tools.issue.diagnostics` remains in core: it checks CLEO install integrity, not GitHub-specific state. It is retained at tier 1.

### Criteria for Plugin vs Core

An operation belongs in a plugin when: (a) it requires an external platform API or SDK, (b) it reads platform-specific configuration files not managed by CLEO, and (c) removing it from core would not break any mandatory agent workflow. All three criteria are satisfied for the 6 extracted issue ops.

Future candidates for plugin extraction: `pipeline.chain.*` and `check.chain.*` (WarpChain, tracked as open question O6 in T5609).

---

## Consequences

### Positive

- **Agent discoverability vastly improved.** Tier 0 shrinks from 155 to 24 operations. The mandatory efficiency sequence is now the obvious starting point rather than a needle in a 155-op haystack.
- **Nexus filesystem fallback eliminated.** `nexus.status` and `nexus.list` are now reachable at tier 1 without prior nexus knowledge.
- **VERB-STANDARDS compliance enforced.** `skill.enable`/`skill.disable` aliases removed; `nexus.query` renamed to `nexus.resolve`; `search` verb eliminated from the memory domain (ADR-021 completed here).
- **Dead code removed.** Phantom operations `orchestrate.chain.plan` and `orchestrate.verify` were not registered and had no callers. Stub operations `tools.skill.configure` and `tools.issue.generate.config` returned hard-coded values with no implementation. All removed.
- **Plugin boundary established.** The ct-github-issues extraction creates the first formal external-integration plugin boundary. Future GitHub-coupled operations have a clear home outside core.
- **Merge ergonomics improved.** 57 operations eliminated by unification. Agents no longer need to choose between `reopen` and `unarchive`, or between 6 sequential release-step operations.

### Negative / Risks

- **Breaking changes for hardcoded agents.** Any agent implementation that calls removed operations by name will fail. Affected operations: `tasks.exists`, `tasks.reopen`, `tasks.unarchive`, `tasks.promote`, `session.history`, `session.chain.show`, `memory.show`, `memory.stats`, `memory.contradictions`, `memory.superseded`, `memory.pattern.stats`, `memory.learning.stats`, `memory.unlink`, and the 6 extracted issue ops. Agents using the ct-cleo skill (rewritten in T5613) will receive updated guidance automatically.
- **ct-github-issues plugin must be published before issue.* removal.** The plugin package must reach a stable release before the core registry removes the operations. A phased deprecation (keep with deprecation warnings, then remove) is acceptable per open question O4 from T5609.
- **The `convert` verb in sticky domain is a VERB-STANDARDS exception.** `sticky.convert` uses a verb not in the canonical set (ADR-017). It is retained because the operation's semantics (converting an ephemeral sticky note into a persistent task) have no canonical-verb equivalent. This is documented as an accepted exception.
- **Open questions deferred.** Six architectural questions from T5609 are not resolved by this ADR: WarpChain plugin extraction (O6), check.chain.gate registration (O1), session.history fold-in (O2), admin.context.inject gateway classification (O3), check.grade parameterization (O5), and admin.health dual-gateway form (O7). These do not block the rationalization but must be resolved before T5612 finalizes the CLEO-OPERATION-CONSTITUTION.

### Migration Path

Agents calling removed operations should migrate as follows:

| Removed operation | Replacement |
|-------------------|-------------|
| `tasks.exists` | `tasks.find {query, exact:true}` — check `results.length > 0` |
| `tasks.reopen` | `tasks.restore {taskId, from:"done"}` |
| `tasks.unarchive` | `tasks.restore {taskId, from:"archive"}` |
| `tasks.promote` | `tasks.reparent {taskId, newParentId: null}` |
| `tasks.relates.find` | `tasks.relates {taskId, mode:"suggest"|"discover"}` |
| `tasks.label.show` | `tasks.label.list {label}` |
| `session.history` | `session.show {id, include:["history"]}` (if implemented) or audit log query |
| `session.chain.show` | Navigate via `session.show` → `previousSessionId`/`nextSessionId` |
| `session.debrief.show` | `session.show {id, include:["debrief"]}` |
| `memory.show` | `memory.fetch {ids: [id]}` |
| `memory.stats` | Not replaced — dashboard metric, not agent workflow |
| `memory.unlink` | Not replaced — direct repair via `memory.link` |
| `nexus.query` | `nexus.resolve` (rename only) |
| `nexus.critical-path` | `nexus.path.show` (canonical alias removed) |
| `nexus.blocking` | `nexus.blockers.show` (canonical alias removed) |
| `nexus.orphans` | `nexus.orphans.list` (canonical alias removed) |
| `admin.doctor` | `admin.health {mode:"diagnose"}` |
| `admin.fix` | `admin.health {mode:"repair"}` (mutate gateway) |
| `admin.restore` | `admin.backup {action:"restore"}` |
| `pipeline.release.prepare/changelog/commit/tag/push/gates.run` | `pipeline.release.ship {step:"prepare"|"changelog"|...}` |
| `tools.skill.enable` | `tools.skill.install` |
| `tools.skill.disable` | `tools.skill.uninstall` |
| `tools.issue.*` | `ct-github-issues` plugin (after publication) |

---

## References

- T5517: Epic — Rationalize CLEO API Operations (268→≤180)
- T5530–T5566: Domain review subtasks (10 domains)
- T5607: ct-cleo skill audit
- T5608: Tier assignment audit
- T5609: Cross-domain synthesis and decision matrix (CLEO-OPERATIONS-CONSOLIDATION-DECISION.md)
- T5611: This ADR (current task)
- T5612: CLEO-OPERATION-CONSTITUTION update (depends on this ADR)
- T5613: ct-cleo skill rewrite (depends on T5612)
- ADR-017: Verb and naming standards (VERB-STANDARDS)
- ADR-021: Memory domain refactor (T5241 cutover)
- ADR-025: WarpChain protocol chains (context for chain.* open questions)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — Updated in T5612
- `docs/specs/VERB-STANDARDS.md` — Canonical verb standards
- `src/dispatch/registry.ts` — Registry source of truth
