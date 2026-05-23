/**
 * Boundary Registry — SSoT for per-module Rust/TS layering decisions across cleocode.
 *
 * Every module (crate, package, harness adapter, archived target) declares a
 * {@link BoundaryEntry} in {@link BOUNDARY_REGISTRY}. CI gates (lint-boundary-registry,
 * lint-dual-implementation, perf-budget bench gate) validate the registry against
 * filesystem reality and enforce declared budgets at build time.
 *
 * Intent is expressed along two axes: workload shape ({@link WorkloadIntent}) and
 * quantitative {@link PerfBudget} / {@link SafetyBudget} thresholds. The pair derives
 * the language choice mechanically — it is not an aesthetic call.
 *
 * The registry is **static-with-amendment**: declared at module creation; subsequent
 * changes require an ADR amendment + PR. This data file is populated by T10197;
 * gates land in T10198 / T10199.
 *
 * @see ADR-078 — Boundary Registry as SSoT for Rust/TS layering
 * @see D010 — vendor worktrunk → crates/worktrunk-core (reference impl)
 * @see Saga T10176 (SG-BOUNDARY-REGISTRY)
 */

// ============================================================
// Workload intent — the qualitative axis
// ============================================================

/**
 * Workload shape declaration for a module. Derived from what the code DOES,
 * not from what convention says it should look like.
 *
 * - `cpu-bound` — Hot path; Rust required (parsing, graph ops, vector math, FFI hot loops).
 * - `io-coordination` — Event-loop-friendly orchestration; TS preferred (async I/O glue, fetch/DB orchestration).
 * - `ffi-surface` — Multi-runtime consumers; Rust core + napi binding (publishable as a Rust lib).
 * - `orchestration-glue` — TS-only (CLI dispatch, agent harness, lifecycle hooks).
 * - `data-manifest` — TS-only zero-dep config or registry data (no logic).
 * - `harness-adapter` — TS-only provider-specific glue (claude-code, gemini, openai bridges).
 * - `frontend` — SvelteKit / browser code; TS always.
 * - `scaffold-pending-consumer` — Rust impl exists but has no consumer yet; {@link BoundaryEntry.plannedConsumerEta} REQUIRED.
 * - `migration-pending` — Currently lives here; destination declared in {@link BoundaryEntry.canonicalHome}.
 * - `migrated-out` — Reference-only entry pointing to the new external canonical home.
 *
 * @see ADR-078 §"Two-axis intent system"
 */
export type WorkloadIntent =
  | 'cpu-bound'
  | 'io-coordination'
  | 'ffi-surface'
  | 'orchestration-glue'
  | 'data-manifest'
  | 'harness-adapter'
  | 'frontend'
  | 'scaffold-pending-consumer'
  | 'migration-pending'
  | 'migrated-out';

// ============================================================
// Performance budget — the quantitative latency / footprint axis
// ============================================================

/**
 * Throughput threshold expressed as a unit + value pair (e.g. `{ unit: 'ops/s', value: 5000 }`).
 *
 * @see PerfBudget.throughput_min
 */
export interface ThroughputThreshold {
  /** Throughput unit string (e.g. `'ops/s'`, `'bytes/s'`, `'rows/s'`). */
  unit: string;
  /** Minimum acceptable value in `unit`. CI fails if a measured bench is below this. */
  value: number;
}

/**
 * Declared performance ceiling for a module. CI perf-budget gate fails the build when a
 * criterion bench measures p50/p99/throughput/memory/startup outside these thresholds.
 * Each field is optional — modules declare only what they care about.
 *
 * A TS module exceeding its `latency_p50_ms` is auto-flagged as a Rust-port candidate.
 *
 * @see ADR-078 §"Two-axis intent system"
 */
export interface PerfBudget {
  /** Hard ceiling on median (p50) operation latency in milliseconds. */
  latency_p50_ms?: number;
  /** Hard ceiling on tail (p99) operation latency in milliseconds. */
  latency_p99_ms?: number;
  /** Minimum sustained throughput the module must meet. */
  throughput_min?: ThroughputThreshold;
  /** Hard ceiling on resident memory in megabytes. */
  memory_max_mb?: number;
  /** Hard ceiling on cold startup time in milliseconds. */
  startup_max_ms?: number;
}

// ============================================================
// Safety budget — the qualitative behavioral / sandbox axis
// ============================================================

/**
 * Declared safety posture for a module. Each axis is enforced by a corresponding lint
 * or static-analysis gate (e.g. `cargo clippy -D clippy::panic` for `panic_unwind: 'forbidden'`).
 *
 * A Rust module whose `panic_unwind` is `'forbidden'` MUST NOT compile with any reachable
 * `panic!()` / `unwrap()` / `expect()` outside test code.
 *
 * @see ADR-078 §"Two-axis intent system"
 */
export interface SafetyBudget {
  /**
   * Whether the module may panic.
   * - `'forbidden'` — no reachable panic in production code paths (enforced via clippy).
   * - `'allowed-with-recovery'` — panics permitted IFF the caller installs a recovery boundary.
   */
  panic_unwind?: 'forbidden' | 'allowed-with-recovery';
  /**
   * Whether the module may escape its declared filesystem root.
   * - `'forbidden'` — operations confined to the declared root (path-jail enforced).
   * - `'allowed-with-justification'` — root escapes permitted with documented rationale + audit log.
   */
  root_escape?: 'forbidden' | 'allowed-with-justification';
  /**
   * Whether the module may originate outbound network traffic.
   * - `'allowed'` — egress permitted.
   * - `'sandbox-required'` — must run under a network-blocking sandbox in production.
   */
  network_egress?: 'allowed' | 'sandbox-required';
  /**
   * Whether the module may write outside its declared root.
   * - `'forbidden'` — writes outside root are a hard error.
   * - `'audited'` — writes permitted but must be appended to the audit log.
   */
  fs_writes_outside_root?: 'forbidden' | 'audited';
}

// ============================================================
// Canonical home — where the module actually lives
// ============================================================

/**
 * Declared canonical home for a module. Modules that don't live in cleocode (e.g.
 * signaldock-* modules migrating to `/mnt/projects/signaldock/`, or signaldock-runtime
 * at a standalone repo) appear in this registry ONLY as a reference pointer via the
 * `{ external: string }` variant.
 *
 * @see ADR-078 §"Canonical homes recorded explicitly"
 */
export type CanonicalHome =
  | 'cleocode'
  | 'signaldock-monorepo'
  | 'signaldock-runtime-repo'
  | 'archived'
  | { external: string };

// ============================================================
// Boundary entry — one row per module
// ============================================================

/**
 * One row in {@link BOUNDARY_REGISTRY}. Declares per-module Rust/TS layering intent,
 * canonical home, and perf/safety budgets. CI gates derived from these rows reject
 * orphan modules, modules whose implementation contradicts the declared `intent`,
 * and dual implementations (Rust + TS shipping the same primitive).
 *
 * `plannedConsumerEta` is REQUIRED when `intent === 'scaffold-pending-consumer'`.
 *
 * @see ADR-078 §"Registry shape"
 */
export interface BoundaryEntry {
  /** Stable module identifier (e.g. `'worktree'`, `'cant'`, `'lafs'`). One word, kebab-case. */
  module: string;
  /** Declared workload intent — see {@link WorkloadIntent}. */
  intent: WorkloadIntent;
  /** Path to `crates/<X>-core` (if a Rust core exists). Relative to repo root. */
  rustCore?: string;
  /** Path to `crates/<X>-napi` (if a napi binding exists). Relative to repo root. */
  napiBinding?: string;
  /** Path to `packages/<X>` (if a TS wrapper / package exists). Relative to repo root. */
  tsWrapper?: string;
  /** Where the module canonically lives — see {@link CanonicalHome}. */
  canonicalHome: CanonicalHome;
  /** Declared performance ceiling — see {@link PerfBudget}. */
  perfBudget: PerfBudget;
  /** Declared safety posture — see {@link SafetyBudget}. */
  safetyBudget: SafetyBudget;
  /** ADR slugs that have touched this entry (e.g. `['adr-077-worktreeinclude', 'adr-078-boundary-registry']`). */
  amendments: string[];
  /** 1-3 sentence rationale for the per-module decision. Required even for migrated-out entries. */
  rationale: string;
  /** ISO date (YYYY-MM-DD). REQUIRED when `intent === 'scaffold-pending-consumer'`; ignored otherwise. */
  plannedConsumerEta?: string;
}

// ============================================================
// Registry skeleton — populated by T10197
// ============================================================

/**
 * Canonical Boundary Registry for cleocode. Empty skeleton in T10196; populated
 * with per-module entries by T10197; CI gates over this data ship in T10198 / T10199.
 *
 * Entries are added/modified ONLY via ADR amendment + PR per the static-with-amendment
 * policy declared in ADR-078.
 *
 * @see ADR-078 — Boundary Registry as SSoT for Rust/TS layering
 */
export const BOUNDARY_REGISTRY: readonly BoundaryEntry[] = [] as const;
