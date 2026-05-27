# ADR-042: CLI System Integrity — Conduit Domain Disposition and Registry Alignment

**Status**: SUPERSEDED
**Date**: 2026-04-10
**Superseded-By**: T962 / T964 (2026-04-17, commit forthcoming). Decision 1 of this ADR (fold conduit into `orchestrate` to preserve the 10-domain invariant) has been fully reversed. CONDUIT is now canonical dispatch domain #15, registered via `handlers.set('conduit', new ConduitHandler())` in `packages/cleo/src/dispatch/domains/index.ts`. The 10-domain invariant that motivated the fold was broken four additional times (intelligence, diagnostics, docs, playbook) between ADR-042 and T964; promoting CONDUIT aligns the registry with the wire-format, the CLI surface (`cleo conduit *`), and the core module layout (`packages/core/src/conduit/`). Rationale and file-by-file change list live in `.cleo/agent-outputs/T910-reconciliation/conduit-collision-research.md`.
**Prior Supersession Note**: T565 (v2026.4.42) — `intelligence` added as the 11th canonical domain. Decision 1 of this ADR (fold conduit into orchestrate, preserve 10-domain invariant) was executed and the conduit fold stood temporarily. However, the "exactly 10 canonical domains" invariant no longer held: the canonical count reached **14** (`tasks`, `session`, `memory`, `check`, `pipeline`, `orchestrate`, `tools`, `admin`, `nexus`, `sticky`, `intelligence`, `diagnostics`, `docs`, `playbook`), then **15** via T964. All references to "10 canonical domains" within this ADR reflect the state at time of authoring and are preserved as historical record. [UPDATED 2026-04-17: fully superseded by T964]
**Related Tasks**: T443, T444, T445, T446
**Related ADRs**: ADR-030, ADR-036, ADR-037, ADR-039
**Keywords**: conduit, registry, constitution, domain-count, invariant, cli-audit, undocumented-ops, canonical, experimental
**Topics**: cli-architecture, registry-integrity, constitutional-alignment

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### The Audit That Triggered This ADR

Task T443 commissioned a full CLI dispatch integrity audit. Three lead agents independently
verified the results (T444 research phase, T445 consensus phase). The audit found two categories
of drift between the live registry (`packages/cleo/src/dispatch/registry.ts`) and the
CLEO-OPERATION-CONSTITUTION (`docs/specs/CLEO-OPERATION-CONSTITUTION.md`):

**Structural drift** — the runtime type definition (`CANONICAL_DOMAINS` in
`packages/cleo/src/dispatch/types.ts`) includes 11 domains, while the constitution states
exactly 10 as an invariant. The 11th domain is `conduit`.

**Operational drift** — the registry contains 231 operations while the constitution documents
209, a delta of +22. All 22 excess operations are present in the registry with real
implementations but absent from the constitution's domain tables.

### Constitution Invariant Under Pressure

Section 4 of the constitution states:

> "CLEO defines exactly **10 canonical domains**. These are the runtime contract."

The `CANONICAL_DOMAINS` array in the code already includes `conduit` as the 11th entry,
but the comment above the array says "The 10 canonical domain names." This comment/code
disagreement is the visible surface of the drift.

### The Conduit Domain: What It Is

The `conduit` domain was added to the registry as part of the T310/ADR-037 work
(Conduit + Signaldock Separation, v2026.4.12). It contains 5 operations:

| Gateway | Operation | Description | Tier |
|---------|-----------|-------------|------|
| query | `status` | Check agent connection status and unread count | 1 |
| query | `peek` | One-shot poll for new messages without acking | 1 |
| mutate | `start` | Start continuous message polling for the active agent | 1 |
| mutate | `stop` | Stop the active polling loop | 1 |
| mutate | `send` | Send a message to an agent or conversation | 1 |

All 5 operations target `conduit.db`, the project-scoped SQLite store for agent-to-agent
messaging established in ADR-037. Zero CLI surface exists for any of them (0% CLI coverage
per the T443 audit).

### The System Flow Atlas Position on Conduit

The CLEO System Flow Atlas (`docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md`) classifies Conduit as:

> "**Conduit** | relay path | orchestrate, session, nexus | Agent relay path. 4-shell stack..."

The CANT conceptual document (`docs/concepts/CLEO-CANT.md`) further states:

> "Conduit is the relay path. Dispatch is the router."

And the CLEO Manifesto (`docs/concepts/CLEO-MANIFESTO.md`):

> "**Conduit** is the relay path between agents, and it speaks only in LAFS envelopes with
> A2A delegation."

These three canonical sources consistently classify Conduit as a **relay path** and a
**runtime form** (overlay concept), not a **dispatch domain** in the constitutional sense.
The System Flow Atlas explicitly maps Conduit's primary domains as `orchestrate, session, nexus` —
not `conduit` as a standalone domain.

### The 22 Undocumented Operations

Beyond the conduit question, 22 operations exist in the registry without constitution documentation:

| Domain | Operations | Count |
|--------|-----------|-------|
| conduit | status, peek, start, stop, send | 5 |
| tasks | impact, claim, unclaim | 3 |
| session | (15 in registry vs 15 in constitution — actually zero drift here; see Decision 2 notes) | 0 |
| check | workflow.compliance | 1 |
| pipeline | stage.guidance | 1 |
| orchestrate | classify, fanout, fanout.status | 3 |
| admin | paths, smoke, scaffold-hub, map (query), map (mutate), config.presets, config.set-preset, hooks.matrix, backup (query form) | 9 |
| nexus | transfer, transfer.preview | 2 |

> **Note on session count**: Registry and constitution both show 15 session operations.
> The T445 consensus brief listed "1 extra session op" but direct verification of the registry
> and constitution tables confirms both at 15. The session count discrepancy is a false positive
> from the consensus phase and is corrected here. Adjusted total: **21 genuinely undocumented
> operations** outside session, plus the 5 conduit ops.

---

## Decision

### Decision 1: Conduit Domain Disposition

**Decision: Fold conduit's 5 operations into the `orchestrate` domain as `orchestrate.conduit.*`.**

The `conduit` entry in `CANONICAL_DOMAINS` MUST be removed. The `orchestrate` domain MUST absorb
the 5 conduit operations under the `conduit.*` sub-namespace. The comment on `CANONICAL_DOMAINS`
MUST be corrected to accurately state 10 domains.

**Rationale:**

1. **Constitutional invariant**: The constitution states "exactly 10 canonical domains" as a
   runtime contract. Breaking this invariant requires either a formal superseding ADR or
   compliance. Promoting conduit to a constitutional 11th domain is architecturally significant —
   it requires consensus on what the new domain's unique identity and data store ownership
   would be.

2. **Conceptual misclassification**: Every canonical source (System Flow Atlas, CANT, Manifesto)
   classifies Conduit as a relay path and runtime form, not a dispatch domain. The System Flow
   Atlas explicitly assigns Conduit's domain coverage to `orchestrate, session, nexus`. Adding
   it as a 11th dispatch domain contradicts its own architectural definition.

3. **No unique data store ownership**: Constitution Section 4 implicitly links domains to primary
   stores. The `conduit.db` store is architecturally owned by the admin domain (backup/migration)
   as per ADR-036 and ADR-037. No constitutional invariant grants data store ownership to conduit
   as a domain separate from admin.

4. **Semantic fit**: The 5 conduit operations are all agent coordination utilities — status checks,
   message polling, and send. These are orchestration primitives. The `orchestrate` domain already
   owns "multi-agent coordination, wave planning, parallel execution." Agent messaging falls
   naturally within this scope.

5. **VERB-STANDARDS compliance**: The operations `status`, `peek`, `start`, `stop`, `send` are
   all canonical verbs (ADR-017). They remain valid under an `orchestrate.conduit.*` namespace.
   `peek` is an accepted variant of `show` for polling semantics where the operation explicitly
   does not acknowledge.

6. **CLI coverage**: Zero of 5 conduit operations have CLI surface. Moving them to `orchestrate`
   before building CLI coverage avoids creating CLI commands under a to-be-removed domain namespace.

**Rejected alternative — conduit as domain #11:**

Making conduit a constitutional 11th domain was evaluated and rejected. The core problem is
that Conduit is a conceptual relay system, not a data management domain. If conduit were
admitted as domain #11, the same logic would apply to adding Hearth, BRAIN, LOOM, and other
named runtime forms as additional domains — defeating the purpose of the fixed-count domain
invariant. The constitution explicitly notes "Conceptual systems (BRAIN, LOOM, NEXUS, LAFS)
are overlays, not domains." Conduit belongs in the same overlay category.

**Implementation:**

The following changes MUST be made in a single atomic commit:

1. `packages/cleo/src/dispatch/types.ts`: Remove `'conduit'` from `CANONICAL_DOMAINS`.
   Update the comment from "The 10 canonical domain names" to match the actual count.

2. `packages/cleo/src/dispatch/registry.ts`: Update the 5 conduit operation entries to use
   `domain: 'orchestrate'` and rename their operations from the current bare verbs to the
   `conduit.*` sub-namespace:

   | Current | After |
   |---------|-------|
   | `domain: 'conduit', operation: 'status'` | `domain: 'orchestrate', operation: 'conduit.status'` |
   | `domain: 'conduit', operation: 'peek'` | `domain: 'orchestrate', operation: 'conduit.peek'` |
   | `domain: 'conduit', operation: 'start'` | `domain: 'orchestrate', operation: 'conduit.start'` |
   | `domain: 'conduit', operation: 'stop'` | `domain: 'orchestrate', operation: 'conduit.stop'` |
   | `domain: 'conduit', operation: 'send'` | `domain: 'orchestrate', operation: 'conduit.send'` |

3. `docs/specs/CLEO-OPERATION-CONSTITUTION.md`:
   - Update Section 4 to remove conduit from the domain list.
   - Add the 5 `orchestrate.conduit.*` operations to the orchestrate domain table (Section 6.6).
   - Update the CANONICAL_DOMAINS code block to remove `'conduit'`.
   - Update the total count from 209 to 214 (after all Decision 2 canonical ops are added;
     see Decision 2 below).

---

### Decision 2: Classification of All 21 Undocumented Operations

Each undocumented operation is classified as **canonical**, **experimental**, or **deprecated**.

**Definitions:**
- **canonical** — belongs in the constitution; was missed during documentation updates; MUST be
  added to the constitution's domain tables in the next constitution update pass.
- **experimental** — in the registry for development or specialized use; not yet at the stability
  bar for constitutional status; MAY be promoted in a future ADR when operationally validated.
- **deprecated** — should be removed from the registry; fails ADR-030 five challenge questions;
  no known agent workflow depends on it.

---

#### conduit domain (5 operations)

These are reassigned to `orchestrate` per Decision 1. Their classification as canonical or
experimental is evaluated in the orchestrate section below.

---

#### tasks domain (3 operations)

**`tasks.impact` (query) — canonical**

Predicts downstream effects of a free-text change description using keyword matching and reverse
dependency graph traversal. This is a genuine planning utility for orchestrators reasoning about
change blast radius. It passes all five ADR-030 challenge questions: it has distinct behavior
(graph traversal, not a parameterized alias), no existing operation covers it, and it belongs
in tier 1 task analysis. The constitution MUST add it to the tasks table.

**`tasks.claim` (mutate) — canonical**

Claims a task by assigning it to the current session. This is a prerequisite for multi-agent
task ownership semantics where two agents must not work on the same task simultaneously. With
parallel orchestrators now common (per session handoff notes), `tasks.claim` and `tasks.unclaim`
form a mutex pair that is non-substitutable by `tasks.update`. The constitution MUST add both.

**`tasks.unclaim` (mutate) — canonical**

Pair of `tasks.claim`. See above. The constitution MUST add this to the tasks table.

---

#### check domain (1 operation)

**`check.workflow.compliance` (query) — canonical**

WF-001 through WF-005 compliance dashboard showing AC rate, session rate, and gate rate. The
registry comment attributes this to T065 agent workflow compliance telemetry. This is a genuine
compliance monitoring surface for orchestrators and operators. It has distinct schema-level
behavior (cross-session aggregate metrics), no existing operation covers it, and it is
discoverable via `check` domain escalation. The constitution MUST add it to the check table.

---

#### pipeline domain (1 operation)

**`pipeline.stage.guidance` (query) — canonical**

Stage-aware LLM prompt guidance. Pi extensions shell out to this on `before_agent_start`. This
is documented behavior in the registry as part of the Pi harness (ADR-035). It is actively used
by the Pi runtime on agent start, which means removing it would break a mandatory workflow.
The constitution MUST add it to the pipeline table.

---

#### orchestrate domain (3 operations, plus 5 conduit ops absorbed per Decision 1)

**`orchestrate.classify` (query) — canonical**

Classifies a request against the CANT team registry to route to the correct team, lead, and
protocol. This is a core orchestration primitive — the entry point for CANT-based request routing.
With CleoOS shipping multi-agent orchestration (T377), this operation is non-experimental. It
has distinct behavior (team registry classification), no existing operation covers it. The
constitution MUST add it.

**`orchestrate.fanout` (mutate) — canonical**

Fans out N spawn requests in parallel via `Promise.allSettled`. This is the workhorse of
multi-agent parallel dispatch. Any orchestrator using the RCASD wave execution model calls this
operation. It is fundamental to the agentic execution layer and cannot be expressed as a
parameterized alias of any existing operation. The constitution MUST add it.

**`orchestrate.fanout.status` (query) — canonical**

Gets status of a running fanout by its manifest entry ID. This is the polling complement to
`orchestrate.fanout`. Without it, orchestrators have no programmatic way to check parallel
dispatch progress. These two form an atomic pair. The constitution MUST add it.

**`orchestrate.conduit.status` (query) — experimental**

Checks agent connection status and unread message count. Useful but has zero CLI surface and
no documented agent workflow in the mandatory sequence or any known RCASD protocol. Classify
experimental pending CLI surface and integration into at least one canonical agent workflow.

**`orchestrate.conduit.peek` (query) — experimental**

One-shot poll for new messages without acking. Same reasoning as `conduit.status`. Experimental
pending workflow documentation and CLI surface.

**`orchestrate.conduit.start` (mutate) — experimental**

Starts continuous message polling. Experimental pending CLI surface and workflow documentation.
The polling architecture (Shell 2 of the 4-shell Conduit stack) is not yet fully documented as
a canonical agent workflow pattern.

**`orchestrate.conduit.stop` (mutate) — experimental**

Stops the active polling loop. Experimental pending CLI surface and workflow documentation.

**`orchestrate.conduit.send` (mutate) — experimental**

Sends a message to an agent or conversation. This is the most likely of the conduit ops to be
promoted to canonical quickly — it is the primary agent-to-agent communication primitive. However,
with no CLI surface and no documented mandatory workflow, it remains experimental until a
protocol (CANT or RCASD) formally requires it.

---

#### admin domain (9 operations)

**`admin.paths` (query) — canonical**

Reports all CleoOS paths (project + global hub) and scaffolding status. This is a diagnostic
utility essential for agents troubleshooting installation or path issues. It has distinct
behavior (multi-path reporting), passes the "does removing it force filesystem fallback?" test
(yes — agents would read `~/.cleo/` directly), and is discoverable via `admin.help`. The
constitution MUST add it.

**`admin.smoke` (query) — canonical**

Operational smoke test: one read-only query per domain. This is the lightweight equivalent of
`admin.health {mode:"diagnose"}` but operates at the dispatch layer rather than the core layer.
It validates that all domains are reachable in a single call. Essential for CI pipelines and
post-upgrade verification. The constitution MUST add it.

**`admin.scaffold-hub` (mutate) — canonical**

Creates CleoOS Hub directories (global-recipes, pi-extensions, cant-workflows, agents) and
seeds a starter justfile. This is the bootstrapping operation for the Hub architecture (ADR-035).
Without it, users must manually create the Hub directory structure. The constitution MUST add it.

**`admin.map` (query) — experimental**

Analyzes codebase structure and returns a structured mapping. This is a development utility
for code comprehension. It does not have a clearly documented mandatory workflow, and its scope
overlaps with existing introspection tools. Classify experimental pending workflow documentation
and validation that it is non-duplicative with other code analysis operations.

**`admin.map` (mutate) — experimental**

Analyzes codebase and stores findings to brain.db. Same reasoning as the query form. Experimental
pending workflow documentation. The mutate form has broader impact (writes to brain.db) and
warrants additional operational validation before canonical promotion.

**`admin.config.presets` (query) — canonical**

Lists all strictness presets with descriptions and values. This is the read-only companion to
`admin.config.set-preset`. Any agent or operator configuring CLEO strictness needs this to
discover available presets. The operation is minimal and has distinct behavior from
`admin.config.show`. The constitution MUST add it.

**`admin.config.set-preset` (mutate) — canonical**

Applies a strictness preset (strict, standard, minimal). This is the prescribed way to configure
CLEO enforcement levels. It is non-substitutable by `admin.config.set` because it applies a
named profile rather than individual fields. The constitution MUST add it.

**`admin.hooks.matrix` (query) — canonical**

Cross-provider hook support matrix using CAAMP canonical taxonomy. This provides agent visibility
into which hooks are available across providers — essential for agents selecting execution
environments or debugging hook failures. It has distinct behavior (cross-provider matrix, not
per-provider detail), and no existing operation covers it. The constitution MUST add it.

**`admin.backup` (query form) — canonical**

The query form of `admin.backup` lists available backups. The constitution currently documents
`admin.backup` only in context of the mutate gateway (create/restore). The query form is a
necessary companion for operators to discover what snapshots exist before restoring. The
constitution MUST document both gateway forms explicitly.

---

#### nexus domain (2 operations)

**`nexus.transfer.preview` (query) — canonical**

Previews a cross-project task transfer without committing it. This is a required safety step
before any `nexus.transfer` execution. Without a preview, agents executing cross-project
transfers have no way to validate the operation before committing. The constitution MUST add it.

**`nexus.transfer` (mutate) — canonical**

Transfers tasks between NEXUS projects. Cross-project task handoff is a documented capability
of the NEXUS coordination layer. It has distinct behavior (cross-DB operation), no existing
operation covers it, and it is non-substitutable by any existing nexus operation. The
constitution MUST add it.

---

## Classification Summary Table

| Domain | Operation | Classification | Constitution Action |
|--------|-----------|---------------|---------------------|
| tasks | impact | canonical | Add to tasks table |
| tasks | claim | canonical | Add to tasks table |
| tasks | unclaim | canonical | Add to tasks table |
| check | workflow.compliance | canonical | Add to check table |
| pipeline | stage.guidance | canonical | Add to pipeline table |
| orchestrate | classify | canonical | Add to orchestrate table |
| orchestrate | fanout | canonical | Add to orchestrate table |
| orchestrate | fanout.status | canonical | Add to orchestrate table |
| orchestrate | conduit.status | experimental | No constitution addition yet |
| orchestrate | conduit.peek | experimental | No constitution addition yet |
| orchestrate | conduit.start | experimental | No constitution addition yet |
| orchestrate | conduit.stop | experimental | No constitution addition yet |
| orchestrate | conduit.send | experimental | No constitution addition yet |
| admin | paths | canonical | Add to admin table |
| admin | smoke | canonical | Add to admin table |
| admin | scaffold-hub | canonical | Add to admin table |
| admin | map (query) | experimental | No constitution addition yet |
| admin | map (mutate) | experimental | No constitution addition yet |
| admin | config.presets | canonical | Add to admin table |
| admin | config.set-preset | canonical | Add to admin table |
| admin | hooks.matrix | canonical | Add to admin table |
| admin | backup (query) | canonical | Document both gateways in admin table |
| nexus | transfer.preview | canonical | Add to nexus table |
| nexus | transfer | canonical | Add to nexus table |

**Canonical additions**: 16 operations (to be added to constitution)
**Experimental (no addition)**: 7 operations (conduit ×5 + admin.map ×2)
**Deprecated**: 0 operations

---

## Reconciled Operation Count

| Source | Count | Notes |
|--------|-------|-------|
| Constitution (before this ADR) | 209 | Documented baseline per ADR-030/T5612 |
| Registry (verified by 3 agents) | 231 | Source of truth |
| Delta | +22 | All 22 accounted for in this ADR |
| Canonical additions approved | +16 | Must be added to constitution |
| Experimental (not added) | +5 | Conduit ops moved to orchestrate but not documented |
| Experimental admin.map (not added) | +2 | Not yet at stability bar |
| Constitution target after this ADR | **225** | 209 + 16 canonical additions |
| Remaining registry-constitution gap | **6** | 7 experimental ops that remain undocumented by design |

> The 6 experimental operations remain in the registry but outside the constitution. This is
> intentional — they are not ready for constitutional promotion. Registry presence without
> constitutional documentation is the correct state for experimental operations.

---

## Consequences

### Positive

- **Constitutional integrity restored**: `CANONICAL_DOMAINS` returns to 10 entries, resolving
  the comment/code disagreement and honoring the invariant established in ADR-030.
- **Conduit semantics preserved**: The 5 conduit operations remain available under
  `orchestrate.conduit.*`. No functionality is lost — only the domain namespace changes.
- **22 undocumented operations accounted for**: Each is either promoted to canonical status or
  formally marked experimental. No operation is left in a gray zone.
- **Registry admission gate applied retroactively**: The 16 canonical operations passed all five
  ADR-030 challenge questions. The 7 experimental operations failed one or more questions
  (typically: no documented mandatory workflow, no CLI surface, or overlap with existing ops).
- **Correct count for external communication**: The 231 registry count vs 209 constitution count
  discrepancy is explainable: 16 were simply missed in documentation, 7 are intentionally
  experimental, and 8 were an artifact of a corrected counting methodology.

### Negative / Risks

- **Naming disruption**: Any agent or script calling `cleo dispatch conduit status` will break
  after the domain rename. However, since CLI coverage for conduit is 0%, this risk applies
  only to direct dispatch callers. No CLI command migration is needed.
- **Registry change required before constitution update**: The `types.ts` and `registry.ts`
  changes MUST land before the constitution is updated, so the constitution accurately reflects
  the live code. The constitution update task MUST be sequenced after the registry change.
- **Experimental ops need lifecycle tracking**: The 7 experimental operations have no formal
  review cadence. They should be revisited at the next registry rationalization (similar to
  ADR-030 T5517). An `escalationHint` or experimental flag on their `OperationDef` entries
  would make their non-canonical status machine-readable.

### Non-Decisions

- **Experimental promotion criteria**: This ADR does not set a formal threshold for promoting
  experimental operations to canonical. The ADR-030 five challenge questions remain the standard.
  When an experimental operation has (a) documented workflow, (b) CLI surface, and (c) passing
  all five questions, it SHOULD be promoted via constitution update with accompanying ADR note.
- **admin.map disposition**: Both forms of `admin.map` are experimental. If the codebase analysis
  use case proves essential to a mandatory workflow, a follow-on ADR should evaluate whether
  `admin.map` is better served by an existing introspection path (e.g., `code.ts` CLI module)
  or deserves canonical promotion.

---

## Trade-offs

### Conduit as domain #11 vs. Fold into orchestrate

| Dimension | conduit as #11 | Fold into orchestrate |
|-----------|----------------|----------------------|
| Constitutional invariant | Breaks §4 invariant | Preserves §4 invariant |
| Conceptual accuracy | Contradicts Flow Atlas, CANT, Manifesto | Aligns with overlay classification |
| Data store ownership | Ambiguous (admin owns conduit.db per ADR-036) | No ownership change needed |
| Semantic clarity | New domain = new identity; unclear boundary | orchestrate.conduit.* is clear sub-namespace |
| Future growth | Encourages more "overlay-as-domain" additions | Sets precedent: overlays stay overlays |
| Migration burden | None (keep current domain) | Low (rename 5 entries, remove 1 CANONICAL_DOMAINS entry) |
| CLI surface impact | None (0% covered either way) | None (0% covered either way) |
| Chosen | No | **Yes** |

### Canonical vs. Experimental classification

The threshold applied throughout Decision 2 was: an operation is canonical when it satisfies
all five ADR-030 challenge questions AND has at minimum one documented agent workflow or
mandatory sequence reference. Operations with real implementations but no workflow documentation
are classified experimental rather than deprecated, because removing them would be premature —
they may have callers in agent skill files or non-CLI orchestrator dispatch.

---

## Implementation Sequence

1. **Registry change** (T447 or equivalent): Update `types.ts` (remove conduit from
   `CANONICAL_DOMAINS`) and `registry.ts` (move conduit ops to orchestrate domain).
2. **Constitution update** (T448 or equivalent): Add 16 canonical operations to the
   appropriate domain tables. Update domain list. Correct total count to 225.
3. **Experimental flag** (optional follow-on): Add an `experimental: boolean` field to
   `OperationDef` and mark the 7 experimental operations. Emit a warning in `admin.help`
   output when experimental operations are queried.
4. **CLI surface for conduit ops** (future): When the conduit messaging workflow is formally
   defined (Shell 2 of the 4-shell Conduit stack), add CLI commands and promote the
   `orchestrate.conduit.*` ops from experimental to canonical.

---

## References

- T443: CLI System Audit epic
- T444: Research phase
- T445: Consensus phase (3 lead agents confirmed 231 ops, 11 domains)
- T446: This ADR (current task)
- ADR-030: Operation Model Rationalization (268→164); defines 5 challenge questions and 10-domain count
- ADR-035: Pi v2+v3 Harness; documents `pipeline.stage.guidance` usage
- ADR-036: CleoOS Database Topology; establishes conduit.db ownership under admin
- ADR-037: Conduit + Signaldock Separation; defines conduit.db purpose
- ADR-039: LAFS Envelope Unification; defines dispatch envelope contract
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — Authoritative operation contract
- `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` — Conduit as relay path classification
- `docs/concepts/CLEO-CANT.md` — "Conduit is the relay path. Dispatch is the router."
- `packages/cleo/src/dispatch/types.ts` — `CANONICAL_DOMAINS` definition
- `packages/cleo/src/dispatch/registry.ts` — Registry source of truth (231 ops)
- `.cleo/agent-outputs/CLI-SYSTEM-AUDIT-2026-04-10.md` — Audit findings
