# ADR-099: Envelope-First Doctrine

**Date**: 2026-05-28
**Status**: Proposed
**Related Tasks**: T11104, T10343 (SG-ENVELOPE-FIRST), T10400 (SG-CLEO-SDK-API), T10344 (EP-DOCTRINE-FORMALIZATION), T10346 (EP-ENVELOPE-CONTRACT-HARDENING)
**Related ADRs**: ADR-039 (LAFS envelope shape), ADR-078 (Boundary Registry), ADR-086 (CLI Output Contract)
**Related Decisions**: D018 (SDK-API + envelope-first split: KEEP AS PROPOSED)
**Keywords**: envelope-first, lafs, boundary, workload-intent, rust-ts-layering, architecture
**Topics**: envelope, boundary-registry, doctrine, language-choice
**Summary**: Ratifies the LAFS envelope as the canonical CLEO boundary, establishes that language choice (TS vs Rust) is implementation detail not architecture, simplifies WorkloadIntent from 10 values to 3 triggers, and defers Cockpit TUI language decision to measurement data.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## §1 Context

### 1.1 The pre-doctrine state

Before this ADR, CLEO's architecture had no formally ratified boundary contract. Two forces pulled in tension:

1. **ADR-039** (LAFS Envelope Unification, 2026-04-08) unified three legacy CLI envelope shapes into a single canonical `CliEnvelope<T>` with `success`, `data`, `error`, and `meta` fields. This became the _de facto_ response shape for all `cleo` CLI commands.

2. **ADR-078** (Boundary Registry as SSoT for Rust/TS Layering) introduced a two-axis intent system — qualitative `WorkloadIntent` (10 values) plus quantitative `PerfBudget` / `SafetyBudget` — that prescribed language choice per module based on workload shape.

These two contracts overlapped but were never formally reconciled. ADR-039 governed _output shapes_ (how the system emits data). ADR-078 governed _module layering_ (what language a module should use). Neither declared which was the architecture and which was the implementation detail.

### 1.2 The tension

ADR-078's `WorkloadIntent` enum encoded an opinion that workload shape _causes_ language choice: `cpu-bound` → Rust, `io-coordination` → TS, `ffi-surface` → Rust + napi. While directionally correct, this coupling created three problems:

1. **Over-specification.** The 10-value enum (`cpu-bound`, `io-coordination`, `ffi-surface`, `orchestration-glue`, `data-manifest`, `harness-adapter`, `frontend`, `scaffold-pending-consumer`, `migration-pending`, `migrated-out`) blurred the line between _what a module does_ and _how it should be implemented_. Lifecycle states (`migration-pending`, `migrated-out`, `scaffold-pending-consumer`) were mixed into a workload taxonomy.

2. **Language-as-architecture cognitive trap.** The two-axis model (workload intent → language choice) made it natural to think of Rust-vs-TS as an architectural decision. But the actual architectural boundary — the thing every surface must conform to — is the LAFS envelope. A Rust crate and a TypeScript package that produce the same LAFS envelope are architecturally interchangeable.

3. **Cockpit TUI predetermination.** The Cockpit TUI (T10402 SG-COCKPIT-HARNESS) was pre-assumed to be Rust via ratatui. The envelope-first doctrine explicitly defers this decision: measure subprocess overhead first (T11115), then choose.

### 1.3 The D018 decision

BRAIN decision D018 (ratified 2026-05-24) captured the resolution:

> **SDK-API + envelope-first split: KEEP AS PROPOSED** — T10343 doctrine, T10400 implementation.

The doctrine (this ADR) defines _what the boundary is_. The implementation (SG-CLEO-SDK-API, T10400) builds the SDK, OpenAPI 3.2 spec, `@cleocode/cleo-sdk` client lib, and `lint-envelope-compliance.mjs` CI gate that enforce it.

---

## §2 Decision

### §2.1 The LAFS envelope IS the canonical CLEO boundary

The LAFS envelope (ADR-039) is hereby ratified as the **single canonical boundary contract** for all CLEO surfaces. Every surface — CLI, SDK, daemon IPC, Cockpit TUI, A2A agent mesh — MUST emit and consume LAFS envelopes as its response contract.

This supersedes all other response contracts. The CLIDispatchResponse shape (`{success, data, error, meta}`) is LAFS. The Nexus response is LAFS. The SDK API is LAFS. The Cockpit IPC is LAFS. There is one shape.

**Invariants (from ADR-039):**

- `success` is always present
- `meta` is always present (success and failure)
- `data` is present when `success === true`
- `error` is present when `success === false`

**Emission invariants (from ADR-086):**

- `stdout` carries exactly ONE LAFS envelope per `cleo` invocation
- All sub-step logs route through Pino → stderr
- Every read+mutate operation supports `--field <jsonpointer>` for scalar extraction
- Mutate ops return minimal envelopes by default (count + IDs)

**Compliance enforcement (T10346):**

- Every `cleo` verb MUST be audited for LAFS envelope compliance (T11110)
- A per-verb envelope-compliance CI gate enforces regression prevention (T11111)
- Non-compliant verbs MUST be fixed (T11112)

### §2.2 Language choice is implementation detail, not architecture

The architecture IS the envelope. Language choice within a surface is an implementation detail — a performance optimization, not an architectural decision.

A Rust crate and a TypeScript package that produce the same LAFS envelope are **architecturally interchangeable**. The consumer of the envelope does not and MUST NOT care what language produced it.

This principle resolves the tension between ADR-039 and ADR-078:

| Was (ADR-078 pre-doctrine) | Is (ADR-087 post-doctrine) |
|---|---|
| Workload shape → prescribes language | Workload shape → prescribes _constraints_ (perf/safety budgets); language is the implementation's answer to those constraints |
| 10-value `WorkloadIntent` enum | 3-trigger model (see §2.3) |
| Language choice as architecture | Language choice as implementation detail |
| "This module is `cpu-bound`, therefore Rust" | "This module must meet `<5ms p50` latency; Rust is the most direct way to satisfy that" |

### §2.3 Three-trigger model replaces 10-value WorkloadIntent

The 10-value `WorkloadIntent` enum is superseded by a **three-trigger model**:

| Trigger | Meaning | When it fires |
|---|---|---|
| `ts-only` | TypeScript implementation; Rust not needed | Module can meet its `PerfBudget` in TypeScript; no external Rust consumers exist; no napi boundary required |
| `rust-published` | Rust core published to crates.io | Module has external Rust consumers (lib crate); crates.io publication is the distribution channel |
| `rust-hotpath` | Rust for hot-path optimization | Module has a `PerfBudget` that TypeScript cannot meet (e.g., `<5ms p50`), OR needs a napi binding surface for internal TS consumers |

The trigger is determined by:

1. **External Rust consumers exist** → `rust-published`
2. **`PerfBudget` cannot be met in TypeScript** → `rust-hotpath`
3. **Otherwise** → `ts-only`

The 10-value `WorkloadIntent` enum is **deprecated**. Boundary registry entries migrate from `intent: WorkloadIntent` to `trigger: EnvelopeTrigger` in a mechanical migration (T11106). The two-axis model of ADR-078 is **preserved** — the `PerfBudget` and `SafetyBudget` axes remain as constraints that inform the trigger selection. What changes is that the constraint axes no longer claim to _be_ the language choice; they are inputs to it.

**Migration mapping:**

| Old `WorkloadIntent` value | New `EnvelopeTrigger` | Rationale |
|---|---|---|
| `cpu-bound` | `rust-hotpath` | Hot-path optimization; perf budget dictates Rust |
| `io-coordination` | `ts-only` | Event-loop orchestration meets budgets in TS |
| `ffi-surface` | `rust-hotpath` | napi binding = hotpath surface |
| `orchestration-glue` | `ts-only` | CLI dispatch, lifecycle hooks |
| `data-manifest` | `ts-only` | Zero-dep config/registry data |
| `harness-adapter` | `ts-only` | Provider-specific glue code |
| `frontend` | `ts-only` | Browser code, always TS |
| `scaffold-pending-consumer` | (removed) | Lifecycle state, not workload intent |
| `migration-pending` | (removed) | Lifecycle state, not workload intent |
| `migrated-out` | (removed) | Reference-only pointer; tracked via `canonicalHome` |

### §2.4 Boundary registry and CI gates remain intact

The `BOUNDARY_REGISTRY` array in `packages/contracts/src/boundary.ts` is preserved. CI gates (`lint-boundary-registry`, `lint-dual-implementation`) continue to validate the registry against filesystem reality. The registry's `amendments` + `rationale` fields are preserved as the self-documenting provenance trail.

What changes:
- `BoundaryEntry.intent` field renamed to `BoundaryEntry.trigger`
- Type changes from `WorkloadIntent` (string union, 10 values) to `EnvelopeTrigger` (string union, 3 values)
- Lifecycle-state values (`scaffold-pending-consumer`, `migration-pending`, `migrated-out`) are removed from the intent/trigger axis
- `plannedConsumerEta` remains as a standalone field (decoupled from the trigger enum)
- Lifecycle state is tracked via `BoundaryEntry.status` (new field, default `'active'`)

### §2.5 Cockpit TUI decision deferred to measurement

The Cockpit TUI (T10402 SG-COCKPIT-HARNESS) language choice (Rust/ratatui vs alternatives) is **explicitly deferred** pending measurement data from T11115 (subprocess overhead measurement for envelope-driven Cockpit).

Principle: the envelope-first doctrine does not prescribe language. If a Rust ratatui binary and a TypeScript Ink/React TUI both produce the same LAFS envelopes over the IPC channel, they are architecturally interchangeable. The decision MUST be made on measurement data, not on doctrine.

---

## §3 Consequences

### §3.1 Positive

- **One boundary to learn.** Every surface — CLI, SDK, daemon, TUI, A2A — shares the same LAFS envelope contract. Agents and tools parse one shape.
- **Language decisions are reversible.** A module that starts as `ts-only` can be ported to Rust when measurement data shows the `PerfBudget` is in danger. The envelope contract doesn't change.
- **Simpler taxonomy.** Three triggers vs ten intents. Lifecycle state is tracked separately.
- **Measurement-driven Cockpit.** Deferring the Cockpit TUI language choice to actual subprocess overhead data avoids premature optimization.
- **ADR-078 preserved.** The two-axis constraint model (perf + safety budgets) is kept. The doctrine clarifies that constraints inform triggers, not prescribe language.

### §3.2 Negative

- **Migration cost.** 39 boundary registry entries must be mechanically migrated (T11106). CI gates must be updated for the new enum shape (T11107, T11108).
- **Breaking change for boundary consumers.** Any code that matches on `BoundaryEntry.intent` values must be updated to the new `trigger` field.
- **Loss of specificity in intent taxonomy.** The 10-value enum gave fine-grained information about _what_ a module does. The 3-trigger model only captures the Rust-vs-TS axis. Some downstream tooling that used the detailed intent values (e.g., dependency graph analysis) will need alternative data sources.

### §3.3 Neutral

- **ADR-078's two-axis model is demoted from prescriptive to informational.** The `PerfBudget` and `SafetyBudget` axes inform trigger selection but do not dictate it. This is a clarification, not a removal.

---

## §4 Implementation tasks

The doctrine is ratified by this ADR. Implementation is split across two epics:

### T10344 (EP-DOCTRINE-FORMALIZATION)

| Task | Description |
|---|---|
| T11104 | This ADR — write and ratify |
| T11105 | Simplify `WorkloadIntent` enum: 10→3 triggers + status field |
| T11106 | Mechanically migrate all 39 boundary registry entries |
| T11107 | Update `lint-boundary-registry` CI gate for new enum + status |
| T11108 | Update `lint-dual-implementation` CI gate for new enum; zero regressions |

### T10346 (EP-ENVELOPE-CONTRACT-HARDENING)

| Task | Description |
|---|---|
| T11109 | Unify CLI meta shape with LAFS schema `_meta` shape |
| T11110 | Audit all `cleo` verbs for LAFS envelope compliance; build compliance matrix |
| T11111 | Build per-verb envelope compliance CI gate |
| T11112 | Fix non-compliant `cleo` verbs to return LAFS envelope |
| T11113 | Publish human-readable envelope contract documentation |
| T11114 | Fix CLI input parsing bug class (repeated-flag overwrite + embedded-pipe split) |
| T11115 | Measure subprocess overhead for envelope-driven Cockpit |
| T11116 | Cross-saga AC amendments for envelope-first doctrine |
| T11117 | Record Cockpit TUI architecture decision (envelope-driven) |
| T11118 | Final integration: verify all ACs; advance T10343 to done |

---

## §5 References

- **ADR-039** — LAFS Envelope Unification (CLI Canonical Shape). Defines `CliEnvelope<T>` with `success`, `data`, `error`, `meta`.
- **ADR-078** — Boundary Registry as SSoT for Rust/TS Layering. Defines `WorkloadIntent` (10 values), `PerfBudget`, `SafetyBudget`, `BoundaryEntry`.
- **ADR-086** — CLI Output Contract (E9 of Saga T9855). Codifies stdout=envelope-only discipline, `--field`/`--output`/`--summary`/`--quiet` projection flags, minimal-by-default mutate envelopes.
- **D018** — BRAIN decision: SDK-API + envelope-first split KEEP AS PROPOSED. T10343 doctrine, T10400 implementation.
- **T10343** — SG-ENVELOPE-FIRST: canonical CLEO boundary is the LAFS envelope.
- **T10400** — SG-CLEO-SDK-API: True Envelope SSoT + RESTful SDK API surface.
- `packages/lafs/src/envelope.ts` — canonical `CliEnvelope`, `CliMeta`, `CliEnvelopeError` types.
- `packages/contracts/src/boundary.ts` — `WorkloadIntent` type and `BOUNDARY_REGISTRY` (39 entries).
- `docs/plan/cleo-canonical-north-star.md` — canonical North Star document referencing envelope-first doctrine.
- `docs/research/sg-envelope-first-doctrine-2026-05-23` — original doctrine charter (via `cleo docs fetch`).
