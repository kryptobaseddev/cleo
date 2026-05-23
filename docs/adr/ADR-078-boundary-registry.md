---
slug: adr-boundary-registry
title: ADR — Boundary Registry as SSoT for Rust/TS layering across cleocode
saga: T10176
date: 2026-05-23
status: accepted
stage: implementation
acceptedAt: 2026-05-23
acceptedBy: T10200
amendedAt: 2026-05-23
amendedBy: T10223
---

# ADR — Boundary Registry as SSoT for Rust/TS layering

**Status**: Accepted (amended 2026-05-23 by T10223 — SoC refactor recording)
**Saga**: T10176 SG-BOUNDARY-REGISTRY
**Decision lineage**: D010 (vendor worktrunk → crates/worktrunk-core); Council verdict run-dir `20260522T230811Z-22ea1898`; owner clarification 2026-05-22 (intent-driven, dynamic, central SSoT, static-with-amendment)

## Context

Saga T9977 SG-WORKTRUNK-OWN delivered the spawn-timeout fix to users (v2026.5.101) by vendoring ~1553 LOC of Rust from `/mnt/projects/worktrunk/` and rewiring `packages/worktree/` to consume it. The saga's body of work exposed an architectural ambiguity: **which code should be Rust, which should be TypeScript, and where does each module live**.

Three distinct approaches surfaced in the work:

1. **"Carve-out" framing** (initial): describe a uniform Rust-core+napi+TS-thin mandate, then enumerate exceptions per crate. Rejected by owner: lazy, hides the actual decision, and produces "exceptions" that drift over time.
2. **Per-domain criterion**: language chosen by consumer-set + workload shape per First Principles atomic-truth analysis. Better, but lives in policy text that drifts from code.
3. **Boundary as DATA** (locked): every module declares its intent in a central versioned const consumed at build-time by CI gates. Static-with-amendment: changes require ADR + PR. This ADR formalizes that approach.

The Boundary Registry is the SSoT for Rust/TS layering decisions across cleocode. CI validates the registry against filesystem reality; bench/security gates enforce declared budgets; the dual-implementation detector closes the failure mode T9977 demonstrated (saga shipping a Rust impl alongside an un-deleted TS implementation).

## Decision

Adopt the **Boundary Registry** at `packages/contracts/src/boundary.ts` as the canonical SSoT for per-module Rust/TS layering decisions across cleocode.

### Registry shape

```ts
// packages/contracts/src/boundary.ts (conceptual; final shape pinned in T10176 implementation)

export type WorkloadIntent =
  | 'cpu-bound'              // Rust hot path required
  | 'io-coordination'        // TS preferred (event-loop-friendly)
  | 'ffi-surface'            // Rust + napi binding (multi-runtime consumers)
  | 'orchestration-glue'     // TS-only (CLI dispatch, agent harness, lifecycle hooks)
  | 'data-manifest'          // TS-only (zero-dep config, registry data)
  | 'harness-adapter'        // TS-only (provider-specific glue)
  | 'frontend'               // SvelteKit + browser
  | 'scaffold-pending-consumer' // Rust exists, no consumer YET; planned-consumer-ETA required
  | 'migration-pending'      // Currently here, declared destination
  | 'migrated-out';          // Reference-only entry pointing to new home

export interface PerfBudget {
  latency_p50_ms?: number;
  latency_p99_ms?: number;
  throughput_min?: { unit: string; value: number };
  memory_max_mb?: number;
  startup_max_ms?: number;
}

export interface SafetyBudget {
  panic_unwind?: 'forbidden' | 'allowed-with-recovery';
  root_escape?: 'forbidden' | 'allowed-with-justification';
  network_egress?: 'allowed' | 'sandbox-required';
  fs_writes_outside_root?: 'forbidden' | 'audited';
}

export interface BoundaryEntry {
  module: string;                 // e.g. 'worktree', 'cant', 'lafs'
  intent: WorkloadIntent;
  rustCore?: string;              // path to crates/<X>-core (if applicable)
  napiBinding?: string;           // path to crates/<X>-napi (if applicable)
  tsWrapper?: string;             // path to packages/<X> (if applicable)
  canonicalHome:                  // where this module lives
    | 'cleocode'
    | 'signaldock-monorepo'
    | 'signaldock-runtime-repo'
    | 'archived'
    | { external: string };       // URL to external canonical repo
  perfBudget: PerfBudget;
  safetyBudget: SafetyBudget;
  amendments: string[];           // ADR slugs that touched this entry
  rationale: string;              // 1-3 sentences explaining the per-module decision
  plannedConsumerEta?: string;    // ISO date (required when intent='scaffold-pending-consumer')
}

export const BOUNDARY_REGISTRY: readonly BoundaryEntry[] = [
  // ... per-module entries
] as const;
```

### Two-axis intent system

Every module's intent is expressed along **two axes**:

1. **Workload shape** — what the code DOES. CPU-bound work goes to Rust. I/O coordination stays TS. FFI surfaces (multi-runtime consumers) get Rust+napi. Orchestration glue (CLI dispatch, lifecycle hooks, agent harness) stays TS. Data/manifest stays TS. Frontend stays Svelte.

2. **Performance/safety budget** — quantitative thresholds. A TS module with a measured p50 > its budget is auto-flagged as a Rust-port candidate by CI. A Rust module whose safety budget forbids `panic_unwind` is enforced by `cargo clippy -D clippy::panic`.

The intent decision is **derived from these two axes**, not from aesthetics or convention.

### Static-with-amendment

The registry is **static** — declared per-module at module creation; changes require an ADR amendment + PR. This prevents drift and gives every decision a paper trail.

Three CI gates enforce the contract:

1. **`scripts/lint-boundary-registry.mjs`** — validates registry-vs-filesystem (no orphan modules; no modules whose actual implementation contradicts the declared `intent`).
2. **`scripts/lint-dual-implementation.mjs`** — fails when a `crates/<X>-core` exists AND a TS implementation of the same primitive exists in `packages/<X>/` or `packages/core/`. Closes the Contrarian's partial-application failure mode that T9977 demonstrated (saga shipping Rust + leaving 1343 LOC of original TS).
3. **Perf-budget bench gate** — runs criterion benches; fails the build when a module misses its declared `perfBudget`.

### Canonical homes recorded explicitly

Every module declares `canonicalHome`. For modules that don't live in cleocode (signaldock-* migrating to `/mnt/projects/signaldock/`, signaldock-runtime at standalone repo), the registry entry exists in cleocode contracts ONLY as a reference pointer (`canonicalHome: { external: 'github.com/...' }`). This eliminates ambiguity about "where does this code live".

## Consequences

### Positive

- **Zero ambiguity per module.** Every code unit answers: belongs here? optimal language? overlap? canonical home? — and the answer is in code, not policy.
- **Drift becomes impossible.** CI gates catch any module that implements a primitive contradicting its declared intent.
- **Polyglot SDK upside captured.** Every `crates/<X>-core` with `publishable: true` becomes a Rust library other ecosystems can consume — for the same engineering cost as the internal-cleanup version of this work.
- **Closes T9977's partial-application failure mode.** Contrarian's finding: "saga ships napi + leaves TS in tree" — the dual-impl detector makes this impossible going forward.
- **Onboarding clarity.** A new contributor reading `boundary.ts` learns the entire layering contract in one file.

### Negative / accepted trade-offs

- **Amendment cost.** Adding a new module or shifting its intent requires an ADR + PR amendment. Acceptable given the architectural significance.
- **Registry maintenance burden.** Each new crate or package must add an entry. Mitigated by CI gate that rejects PRs introducing modules without registry entries.
- **Bench-budget enforcement requires bench infrastructure.** New criterion benches per `<X>-core` crate; ~30 LOC each per Expansionist's prior analysis. Acceptable scope.

### Out-of-scope (deferred follow-up sagas)

- **lafs-core buildup**: today lafs-core is a 1527 LOC stub while lafs TS pkg is 11537 LOC (0.13:1 ratio). The "LAFS should be Rust" intent is recorded but the actual port is a separate SG-LAFS-RUST-CORE saga.
- **nexus-rust-core**: nexus is plausibly Rust-CPU-bound (graphology + tree-sitter), recorded as `intent: 'cpu-bound-candidate'` with planned-consumer-eta TBD. Port is a separate SG-NEXUS-RUST-CORE saga.
- **brain-rust-core**: brain's vector embedding hot-path is plausibly Rust. Same pattern: register intent, port via separate saga.

These deferrals are **not carve-outs** — they're explicit "intent recorded, implementation pending" states tracked in the registry.

## Alternatives considered

- **ADR-only policy** (no registry): rejected. Policy drifts; code is the only enforceable SSoT.
- **Per-module frontmatter** (intent in Cargo.toml / package.json comments): rejected. Decentralized; no central view; harder to query.
- **Runtime-detected intent** (heuristic CI): rejected. Implicit; surprising drift; doesn't capture WHY a decision was made.

## Amendment process

To change a module's boundary entry:

1. File an ADR amendment referencing this ADR.
2. Update the registry entry with the new shape.
3. Update CI baseline(s) if needed.
4. The amending PR must include the ADR amendment file.

Tier-0 invariants that **cannot** be amended without a new ADR:
- Two-axis intent system (workload shape + budgets).
- Static-with-amendment policy.
- Dual-implementation detector cannot be disabled.

## Implementation tasks

Tracked under T10176 SG-BOUNDARY-REGISTRY saga acceptance criteria.

## Related decisions

- D010 (vendor worktrunk → crates/worktrunk-core) — first reference impl
- Council verdict run-dir `20260522T230811Z-22ea1898` — pattern stress-tested by 5 advisors
- ADR-077 worktreeinclude canonical location — first per-module decision under this pattern (file location)
- Parallel saga T10180 SG-SIGNALDOCK-EXTRACT — uses registry to declare signaldock-* as `migrated-out`

---

## Amendments

### 2026-05-23 — SoC refactor: `worktrunk-core` SDK extraction (Epic T10218 / E3-PREREQ)

**Subject**: Separation-of-concerns refactor of vendored worktrunk into a
pure SDK shape suitable for napi consumers, closing the first concrete
reference implementation of the boundary-registry pattern declared in this ADR.

**Decision summary**: the initial literal-vendor strategy that shipped under
T9977 SG-WORKTRUNK-OWN had pulled in `command_approval`, `commit`, `hooks`,
`hook_plan`, `repository_ext`, `template_vars`, `context`, `styling`,
`shell_exec`, and `output` modules alongside the actual worktree primitives.
Two early-T10219/T10201 attempts at a literal vendor of `worktrunk`'s
`Repository` god-object halted: the type carries 45+ methods spanning git
plumbing, worktree management, config integration, shell exec, and
high-level workflows — far beyond what the SDK consumers (`worktree-napi`,
`packages/worktree/`, the spawn pipeline) actually call.

The hybrid strategy adopted instead, and recorded here as the canonical
shape for any future Rust-core extraction:

1. **Data-DTO vendor** for pure-data types (`BranchDeletionMode`,
   `RefSnapshot` / `RefEntry` / `RefKind`, a field-only `UserConfigDto`,
   `CopyIgnoredConfig`, `RemovalPlan`, `BranchRef`, `RefType`). No
   `Repository` dependency — these are byte-equivalent data shapes the
   donor used.
2. **`Repo` trait + `ProcessRepo` default impl** as the substitute for
   the `Repository` god-object. The trait enumerates the audited
   surface; default-method bodies return `Err(unimplemented_in_sdk(...))`
   so individual impls only materialize the methods their consumer
   actually calls. `ProcessRepo` ships the `std::process::Command`-backed
   default impl that the napi consumer needs today.
3. **Step-level primitives as plan-then-execute pure functions** —
   `step::{prune, promote, squash, copy_ignored, relocate}` each ship a
   planner returning a plan struct, plus an executor that runs against
   `&dyn Repo`. CLI callers can call the planner alone for dry-run.
4. **CLI-binary-only modules deliberately NOT vendored**:
   `worktrunk::priority` (re-nices the host process — unsafe for SDK
   consumers) and `worktrunk::signal_forwarder` (installs POSIX pgroup
   signal handlers — unsafe to re-install from a library). Both stay in
   the upstream `worktrunk` CLI binary. Documented in
   `crates/worktrunk-core/src/lib.rs` and the `README.md`.

100% functional parity verified by the T10222 parity test suite (61 tests
spanning 9 primitives). Cumulative ~1352 LOC vendored into
`crates/worktrunk-core` versus the original ~1553 LOC literal-vendor — the
delta is exactly the CLI-binary-only modules dropped by this refactor.

**SDK API contract**: see
[`crates/worktrunk-core/README.md`](../../crates/worktrunk-core/README.md)
for the complete per-module catalogue. The README is the canonical SDK
contract; future Rust-core extractions under this ADR's pattern should
ship an equivalent README.

**Implementation PR chain**:

- **T10219 (PR #507)** — substrate: `Repo` trait + `ProcessRepo` impl +
  pure-data DTOs (`BranchDeletionMode`, `RefSnapshot` / `RefEntry` /
  `RefKind`, `CopyIgnoredConfig`, `UserConfigDto`).
- **T10220 (PR #517)** — step-level primitives: `step::{shared,
  copy_ignored, promote, squash, prune, relocate}` +
  `worktrunk_core::paths::compute_project_hash` (SSoT-compatible with
  `@cleocode/paths`).
- **T10221 (PR #518)** — lifecycle primitives: `cache::*`,
  `remove_dir::remove_dir_with_progress`, `sync::Semaphore`, `diff::*`.
- **T10222 (PR #525)** — 61-test parity suite across 9 primitives;
  confirms byte-equivalent behavior against the upstream donor.
- **T10223 (this amendment)** — public API surface doc
  (`crates/worktrunk-core/README.md`) + ADR-078 amendment recording the
  SoC decision + boundary registry entry verification.

**CLI separation**: `priority.rs` + `signal_forwarder.rs` remain in the
`worktrunk` CLI binary. The `crates/worktrunk-core/src/lib.rs` crate-level
documentation enumerates this separation explicitly (lines 50–78) so any
future contributor reading the crate root immediately learns what IS NOT in
scope for the SDK.

**Boundary registry entry (post-refactor)**: the `worktrunk-core` entry in
`packages/contracts/src/boundary.ts` is verified to reflect this refactor:

- `intent: 'cpu-bound'` — confirmed; the rayon-driven parallel copy,
  ignore-crate matcher, and `git worktree` plumbing are CPU- and FS-bound
  hot paths. The 5/50ms p50/p99 budgets are the napi-consumer envelope.
- `safetyBudget.panic_unwind: 'forbidden'` — enforced by the crate's
  `#![forbid(unsafe_code)]` at the top of `lib.rs` plus the standard
  clippy gates.
- `safetyBudget.root_escape: 'forbidden'` — enforced by
  `copy::ensure_path_within_root` rejecting `..` escapes and the
  `git_wt::*` primitives delegating to `git worktree` which enforces its
  own root semantics.
- `amendments: ['adr-077-worktreeinclude', 'adr-078-boundary-registry']` —
  updated to include this amendment slug.
- `rationale` — refreshed to: "Refactored SoC per ADR-078 amendment
  2026-05-23. Worktree primitives core (1,352 LOC) vendored from
  /mnt/projects/worktrunk per D010, consumed by worktree-napi. Reference
  implementation of the boundary-registry pattern. Full SDK surface in
  `crates/worktrunk-core/README.md`. Internal-only today; `publish=true`
  is a future option if external worktree-tooling emerges."

This amendment closes Epic T10218 (E3-PREREQ-SDK-REFACTOR), which in turn
unblocks the dependent epics T10203 (E1 — registry impl + CI gates) and
T10204 (E2 — parity tests + bench gates) under Saga T10176.

