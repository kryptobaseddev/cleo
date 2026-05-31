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
// Registry — populated by T10197 from the verified decision matrices
// ============================================================

/**
 * Canonical Boundary Registry for cleocode. Skeleton shipped in T10196; populated
 * with per-module entries by T10197 from the verified decision matrices
 * (`sg-boundary-crates-decision-matrix` + `sg-boundary-packages-decision-matrix`).
 * CI gates over this data ship in T10198 / T10199.
 *
 * Entry order: crates first (19 entries), then packages (20 entries). Within each
 * group entries are alphabetical by `module` for diff-friendliness.
 *
 * Entries are added/modified ONLY via ADR amendment + PR per the static-with-amendment
 * policy declared in ADR-078.
 *
 * @see ADR-078 — Boundary Registry as SSoT for Rust/TS layering
 */
export const BOUNDARY_REGISTRY: readonly BoundaryEntry[] = [
  // ============================================================
  // Crates (19 entries) — from sg-boundary-crates-decision-matrix
  // ============================================================

  {
    module: 'cant-core',
    intent: 'cpu-bound',
    rustCore: 'crates/cant-core',
    tsWrapper: 'packages/cant',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Cant parser/compiler (19,002 LOC) — CPU-bound hot path consumed by cant-runtime, cant-lsp, cant-napi, signaldock-protocol, signaldock-sdk, integration-tests, and via napi from packages/cant. Flip publish=true to expose as a Rust SDK for external consumers.',
  },
  {
    module: 'cant-lsp',
    intent: 'cpu-bound',
    rustCore: 'crates/cant-lsp',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 50,
      latency_p99_ms: 500,
      startup_max_ms: 200,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Cant Language Server Protocol binary (1,935 LOC) invoked by editors. Internal-only: publish=false since it ships as a binary, not a library consumed by other crates.',
  },
  {
    module: 'cant-napi',
    intent: 'ffi-surface',
    napiBinding: 'crates/cant-napi',
    tsWrapper: 'packages/cant',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'napi binding shim for cant-core + cant-runtime. Loaded via packages/cant/src/native-loader.ts and packages/core/src/system/dependencies.ts. Internal-only — shipped via per-platform packages/cant-napi-* npm packages, not crates.io. cant-router bindings removed (E8 T11432).',
  },
  {
    module: 'cant-router',
    intent: 'cpu-bound',
    rustCore: 'crates/cant-router',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Cant Router (984 LOC) — RETIRED from cant-napi dep-set (E8 T11432: zero live TS consumers). ' +
      'Preserved in the workspace for reference; not linked into the published napi binary. ' +
      'publish=false. Relocation/deletion tracked in T11432.',
  },
  {
    module: 'cant-runtime',
    intent: 'cpu-bound',
    rustCore: 'crates/cant-runtime',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Cant runtime / pipeline orchestration (1,221 LOC) consumed by cant-napi. Partial TS parallel impl exists; Rust is canonical. Flip publish=true to ship alongside cant-core.',
  },
  {
    module: 'cleo-llm-native',
    intent: 'migration-pending',
    rustCore: 'crates/cleo-llm-native',
    canonicalHome: 'archived',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Verified-dead code: 531 LOC Rust crate referenced ONLY by packages/core/src/llm/rust/__tests__/. Production transports (chat-completions/gemini/openai) import StreamingThinkScrubber from the TS think-scrubber.js path. CLEO_USE_RUST gate is never set in any workflow. Scheduled for deletion in T10205; see ADR-078 implementation tasks.',
  },
  {
    module: 'cleo-conduit-core',
    intent: 'data-manifest',
    rustCore: 'crates/cleo-conduit-core',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 10,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Conduit serde-types crate (681 LOC) — renamed from conduit-core to cleo-conduit-core (T10185, saga T10180) because conduit-core is squatted on crates.io. Stable contract surface consumed by cant-core, signaldock-protocol, signaldock-core, integration-tests, AND external /mnt/projects/signaldock-core + /mnt/projects/signaldock/backend via git deps. Mirrors @cleocode/contracts/conduit.ts. Forced KEEP+publish=true: deleting breaks production, and signaldock-protocol publish requires it.',
  },
  {
    module: 'cleo-supervisor',
    intent: 'scaffold-pending-consumer',
    rustCore: 'crates/cleo-supervisor',
    canonicalHome: 'cleocode',
    plannedConsumerEta: '2026-06-30',
    perfBudget: {
      startup_max_ms: 200,
      memory_max_mb: 15,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Process supervisor bin+lib crate (R1 / T11252, SG-RUNTIME-UNIFICATION T11243): pidfile + tokio::process child spawn/monitor + SIGTERM-grace/SIGCHLD reaping (Unix) / Job Object (Windows) + exponential restart-backoff (30s cap) + tracing-appender log rotation. publish=false; distributed via napi-style Pattern P2 (GitHub Release + checked-in sha256 manifest) + Pattern P1 linux-x64-gnu fallback bundled in @cleocode/core — zero binary OIDC (D14prime). Consumes the frozen supervisor-ipc v1.0 contract (packages/contracts/src/supervisor-ipc); first consumer is R2 @cleocode/runtime/daemon (T11253). Idle-RSS budget 15MB.',
  },
  {
    module: 'integration-tests',
    intent: 'cpu-bound',
    rustCore: 'crates/integration-tests',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Internal Rust test harness (241 LOC) over lafs-core/cleo-conduit-core/cant-core/cant-router/signaldock-core. publish=false intentional — test code never ships.',
  },
  {
    module: 'lafs-core',
    intent: 'cpu-bound',
    rustCore: 'crates/lafs-core',
    tsWrapper: 'packages/lafs',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'LAFS envelope serialization core (1,432 LOC) consumed by cleo-conduit-core, signaldock-protocol, lafs-napi, integration-tests. Mirrors @cleocode/lafs/src/envelope.ts. Flip publish=true to expose canonical envelope spec as a Rust library.',
  },
  {
    module: 'lafs-napi',
    intent: 'ffi-surface',
    napiBinding: 'crates/lafs-napi',
    tsWrapper: 'packages/lafs',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'napi binding shim (95 LOC) for lafs-core. Loaded via packages/lafs/src/native-loader.ts. Internal-only — shipped via packages/lafs-napi-* per-platform npm packages.',
  },
  {
    module: 'signaldock-core',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 10, latency_p99_ms: 100 },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-core deleted from cleocode.',
  },
  {
    module: 'signaldock-payments',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 50, latency_p99_ms: 1000 },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-payments deleted from cleocode.',
  },
  {
    module: 'signaldock-protocol',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 10 },
    safetyBudget: { panic_unwind: 'forbidden', root_escape: 'forbidden' },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-protocol deleted from cleocode.',
  },
  {
    module: 'signaldock-runtime',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock-runtime/' },
    perfBudget: { latency_p50_ms: 50, latency_p99_ms: 1000, startup_max_ms: 500 },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock-runtime/ via Saga T10180 (T10187). crates/signaldock-runtime deleted from cleocode.',
  },
  {
    module: 'signaldock-sdk',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 50, latency_p99_ms: 1000 },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-sdk deleted from cleocode.',
  },
  {
    module: 'signaldock-storage',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 10, latency_p99_ms: 100 },
    safetyBudget: { panic_unwind: 'forbidden', root_escape: 'forbidden' },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-storage deleted from cleocode.',
  },
  {
    module: 'signaldock-transport',
    intent: 'migrated-out',
    canonicalHome: { external: '/mnt/projects/signaldock/' },
    perfBudget: { latency_p50_ms: 50, latency_p99_ms: 1000 },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Migrated to /mnt/projects/signaldock/ via Saga T10180 (T10187). crates/signaldock-transport deleted from cleocode.',
  },
  {
    module: 'worktree-napi',
    intent: 'ffi-surface',
    napiBinding: 'crates/worktree-napi',
    tsWrapper: 'packages/worktree',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: ['adr-087-worktree-ffi-topology'],
    rationale:
      'napi binding shim (515 LOC) for worktrunk-core, used by packages/core spawn-pipeline tests and packages/core/src/scaffold/ensure-config.ts. The native .node binaries are bundled into @cleocode/worktree/native (Pattern P1) and fetched from the GitHub Release (Pattern P2); the per-platform packages/worktree-napi-* manifest packages were removed and are NOT published (D14prime / ADR-087, T11398). Internal-only.',
  },
  {
    module: 'worktrunk-core',
    intent: 'cpu-bound',
    rustCore: 'crates/worktrunk-core',
    tsWrapper: 'packages/worktree',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
      latency_p99_ms: 50,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: ['adr-077-worktreeinclude-canonical-location', 'adr-078-boundary-registry'],
    rationale:
      'Refactored SoC per ADR-078 amendment 2026-05-23. Worktree primitives core (1,352 LOC) vendored from /mnt/projects/worktrunk per D010, consumed by worktree-napi. Reference implementation of the boundary-registry pattern. Full SDK surface documented in crates/worktrunk-core/README.md (T10223). Internal-only today; publish=true is a future option if external worktree-tooling emerges.',
  },

  // ============================================================
  // Packages (20 entries) — from sg-boundary-packages-decision-matrix
  // ============================================================

  {
    module: 'adapters',
    intent: 'harness-adapter',
    tsWrapper: 'packages/adapters',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'allowed-with-justification',
      network_egress: 'allowed',
      fs_writes_outside_root: 'audited',
    },
    amendments: [],
    rationale:
      'Claude Code / Cursor / OpenCode harness adapters (10,661 LOC) consumed only by core. Provider-specific FS layouts + child_process spawning; TS-only fit.',
  },
  {
    module: 'agents',
    intent: 'data-manifest',
    tsWrapper: 'packages/agents',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 10,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Asset-only package (0 TS LOC) — ships .cant + templates consumed by 2 packages. No logic; pure data manifest.',
  },
  {
    module: 'animations',
    intent: 'frontend',
    tsWrapper: 'packages/animations',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 16,
      latency_p99_ms: 33,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'TTY render animations (1,351 LOC) consumed by cleo. 60fps frame budget; terminal output is irrelevant for Rust.',
  },
  {
    module: 'brain',
    intent: 'io-coordination',
    tsWrapper: 'packages/brain',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 1000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Multi-DB substrate adapter (1,628 LOC) consumed by studio + self. IO-bound over better-sqlite3 + drizzle; no Rust port warranted today. Hot path (embeddings) lives in core/src/memory/, not here.',
  },
  {
    module: 'caamp',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/caamp',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      fs_writes_outside_root: 'audited',
    },
    amendments: [],
    rationale:
      'CAAMP packaging + harness registry (28,439 LOC) consumed by 3 packages. FS layouts + provider quirks fit TS; no Rust hot path.',
  },
  {
    module: 'cant',
    intent: 'ffi-surface',
    tsWrapper: 'packages/cant',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 10,
      latency_p99_ms: 100,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Thin TS wrapper (4,960 LOC) over cant-core/cant-napi/cant-runtime Rust crates. 651 LOC is the native-loader; remaining glue is composer/bundle/migrate/markdown-parser/mental-model. Working hybrid — no deletion needed.',
  },
  {
    module: 'cleo',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/cleo',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
      startup_max_ms: 500,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      fs_writes_outside_root: 'audited',
    },
    amendments: [],
    rationale:
      'CLI dispatch binary (83,143 LOC, 0 consumers — top of stack). Decomposition tracked under SG-ARCH-SOLID T9833. TS-only orchestration glue; no Rust hot path.',
  },
  {
    module: 'cleo-os',
    intent: 'harness-adapter',
    tsWrapper: 'packages/cleo-os',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
      startup_max_ms: 500,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'allowed-with-justification',
      fs_writes_outside_root: 'audited',
    },
    amendments: [],
    rationale:
      'Pi launcher wrapper (3,598 LOC) — 0 consumers (binary). Wraps JS-only Pi harness; TS-only fit.',
  },
  {
    module: 'contracts',
    intent: 'data-manifest',
    tsWrapper: 'packages/contracts',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 10,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: ['adr-078-boundary-registry'],
    rationale:
      'Typed contracts SSoT (35,905 LOC, Zod schemas) consumed by 15 packages. Pure types; no logic; TS-only by definition (it defines the type surface). Hosts BOUNDARY_REGISTRY itself.',
  },
  {
    module: 'core',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/core',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      fs_writes_outside_root: 'audited',
    },
    amendments: [],
    rationale:
      'SDK runtime (295,846 LOC) consumed by 10 packages — currently a god-package. Decomposition tracked under SG-ARCH-SOLID T9834. Mixed workload; most paths are IO-coordination but no module is CPU-bound enough to mandate a Rust port today.',
  },
  {
    module: 'git-shim',
    intent: 'ffi-surface',
    tsWrapper: 'packages/git-shim',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 50,
      latency_p99_ms: 1000,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      fs_writes_outside_root: 'forbidden',
    },
    amendments: [],
    rationale:
      'PATH-binary git shim (1,452 LOC) — standalone, 0 in-repo consumers. Must fork+exec; bin must be Node for npm distribution. TS-only fit.',
  },
  {
    module: 'lafs',
    intent: 'io-coordination',
    tsWrapper: 'packages/lafs',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 50,
      latency_p99_ms: 1000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: [],
    rationale:
      'Envelope + A2A bridge (11,353 LOC) consumed by 6 packages. Rust core (lafs-core + lafs-napi) handles canonical envelope serialization; TS layer is A2A express bridge + envelope validation glue (2,600 LOC a2a/* uses JS-only @a2a-js/sdk).',
  },
  {
    module: 'runtime/gateway/mcp',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/runtime/src/gateway/mcp',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: [],
    rationale:
      'MCP transport adapter (R8 · T11259) — the standalone `packages/mcp-adapter` source was deleted and consolidated into `@cleocode/runtime/gateway/mcp` (R3-T4 · T11448). Routes every `tools/call` through the unified gateway (`source: "mcp"`) rather than calling `@cleocode/core` directly. Zero separate npm publish; the adapter ships as part of `@cleocode/runtime`.',
  },
  {
    module: 'nexus',
    intent: 'cpu-bound',
    tsWrapper: 'packages/nexus',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 50,
      latency_p99_ms: 500,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Code-intelligence (16,431 LOC) consumed by cleo + core. CPU-bound (tree-sitter AST + graphology), but tree-sitter is already native via npm. Pure-JS graphology hot loop is the only candidate; future SG-NEXUS-RUST-CORE saga (out-of-scope per ADR-078) may add a nexus-core Rust crate. Keep TS for now.',
  },
  {
    module: 'paths',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/paths',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: ['adr-067-project-root-resolution'],
    rationale:
      'XDG paths SSoT (588 LOC) consumed by 9 packages. Upgraded from data-manifest to orchestration-glue (T10295, T11026): the ID-aware resolver surface — resolveProjectByCwd + resolveCanonicalCleoDir — introduces projectId↔path lookup logic with cross-mount canonicalization and strict-mode enforcement. Still TS-only; no Rust port warranted.',
  },
  {
    module: 'utils',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/utils',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 5,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Pure zero-dependency helper leaf (formatBytes, ...) collapsed from duplicated inline copies. Zero cleocode deps; bundled into @cleocode/cleo, never published (E5 / T11392).',
  },
  {
    module: 'playbooks',
    intent: 'orchestration-glue',
    tsWrapper: 'packages/playbooks',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 2000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Playbook state machine (3,094 LOC) consumed by cleo + adapters. Pure DI; IO-coordination dominated. TS-only fit.',
  },
  {
    module: 'runtime',
    intent: 'io-coordination',
    tsWrapper: 'packages/runtime',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 100,
      latency_p99_ms: 1000,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: [],
    rationale:
      'Poller/SSE/heartbeat runtime (681 LOC) consumed by cleo. Node event loop + fetch are the natural fit; no Rust port warranted.',
  },
  {
    module: 'skills',
    intent: 'data-manifest',
    tsWrapper: 'packages/skills',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 10,
    },
    safetyBudget: {
      panic_unwind: 'forbidden',
      root_escape: 'forbidden',
    },
    amendments: [],
    rationale:
      'Asset-only package (0 TS LOC) — ships JSON skill registry + generated index.js consumed by core. No logic; pure data manifest.',
  },
  {
    module: 'studio',
    intent: 'frontend',
    tsWrapper: 'packages/studio',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 16,
      latency_p99_ms: 33,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      network_egress: 'allowed',
    },
    amendments: [],
    rationale:
      'SvelteKit frontend (16,636 LOC, d3/three/sigma) — 0 in-repo consumers; it is an application, not a consumed library. SvelteKit + browser code; TS always. REMOVED from the npm publish surface (T11399 / E1 · SG-PACKAGE-ARCH), reversing the 2026-05-05 Issue #102 / PR #103 addition: apps are deployed, not published.',
  },
  {
    module: 'worktree',
    intent: 'ffi-surface',
    tsWrapper: 'packages/worktree',
    canonicalHome: 'cleocode',
    perfBudget: {
      latency_p50_ms: 50,
      latency_p99_ms: 1000,
      startup_max_ms: 100,
    },
    safetyBudget: {
      panic_unwind: 'allowed-with-recovery',
      root_escape: 'forbidden',
      fs_writes_outside_root: 'audited',
    },
    amendments: ['adr-087-worktree-ffi-topology', 'adr-078-boundary-registry'],
    rationale:
      'Worktree SSoT primitive layer (1,972 LOC) — canonical create/destroy/list/prune/include/copy-on-write bound by @cleocode/paths. Post-PR-#487 the responsibilities are distinct from packages/core/src/worktree/ (SDK-level enrichment). Consumes worktrunk-core via the worktree-napi binding, whose native .node binaries are bundled into native/ (Pattern P1) / fetched from the GitHub Release (Pattern P2) — no separate per-platform npm package is published (D14prime / ADR-087, T11398).',
  },
] as const;

// ============================================================
// TOOLS-vs-SKILLS boundary (E3 · T11409 · SG-PACKAGE-ARCH)
// ============================================================

/**
 * The canonical home-and-consumption boundary for the CORE-SDK tool layer.
 *
 * Atomic **tool primitives** (the smallest stateless side-effect units — see
 * `@cleocode/contracts/tools/atomic` + `core/src/tools/*`) and their contracts
 * have exactly the two homes in {@link AtomicToolBoundary.primitiveHomes}.
 * **Composite skills** (multi-step capabilities that COMPOSE primitives) live
 * in {@link AtomicToolBoundary.skillsHome}. The harness/provider packages in
 * {@link AtomicToolBoundary.consumersNoRedefine} CONSUME the primitives via
 * import and MUST NOT redefine them.
 *
 * Enforced (baseline mode) by `scripts/lint-tools-vs-skills-boundary.mjs`.
 *
 * @see ADR-078 — Boundary Registry
 * @task T11409
 */
export interface AtomicToolBoundary {
  /** The only packages that may DEFINE atomic-tool primitives + contracts. */
  readonly primitiveHomes: readonly string[];
  /** Composite, multi-step capabilities (compose primitives) live here. */
  readonly skillsHome: string;
  /** Consume primitives via import — MUST NOT redefine them. */
  readonly consumersNoRedefine: readonly string[];
}

/** {@inheritDoc AtomicToolBoundary} */
export const ATOMIC_TOOL_BOUNDARY: AtomicToolBoundary = {
  primitiveHomes: ['packages/core/src/tools', 'packages/contracts/src/tools'],
  skillsHome: 'packages/skills',
  consumersNoRedefine: ['packages/runtime', 'packages/caamp', 'packages/cleo-os'],
};
