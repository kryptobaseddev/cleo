# LEAD BETA — Contracts + LAFS Envelope + Scope-Map SSoT + DB Topology

**Owns:** contract + data shape. **Does NOT own:** structural split (ALPHA), rename
strategy (GAMMA), help text (DELTA).

**Thesis:** agents trip on Nexus because the wire format is **silent about scope**. A
registry-walk (`nexus list`) and a graph-read (`nexus context`) return identical envelope
shapes — no machine-readable hint that one mutates global state and the other reads a
per-project graph. The fix is contract-side: make scope a first-class field on every
operation descriptor and on every response meta.

---

## 1. NexusOperation contract

New module `packages/contracts/src/operations/nexus-scope.ts`, alongside the existing
`NexusOps` map (`nexus.ts:1550-1623`). No breaking change.

```ts
/** The five actually-distinct scopes. */
export type NexusScope =
  | 'project'      // cwd-default, per-project graph in nexus.db
  | 'living-brain' // project graph + brain.db + tasks.db cross-substrate
  | 'cross'        // walks global registry, no single-graph read
  | 'hybrid'       // operates on TWO projects (transfer/link)
  | 'global';      // mutates global infrastructure (init/register/permission)

/** How a caller binds the scope at call-time. */
export type ScopeBinding =
  | { readonly kind: 'cwd' }
  | { readonly kind: 'projectId'; readonly required: boolean }
  | { readonly kind: 'two-projects' }
  | { readonly kind: 'registry' }
  | { readonly kind: 'none' };

export type NexusEffect = 'read' | 'write' | 'admin';

/** Touched stores — drives lock contention + cache invalidation. */
export type NexusStore =
  | 'nexus-graph' | 'nexus-registry' | 'brain' | 'tasks' | 'fs';

/** The canonical descriptor every nexus op MUST carry. */
export interface NexusOperationDescriptor {
  readonly id: keyof import('./nexus.js').NexusOps;
  readonly scope: NexusScope;
  readonly binding: ScopeBinding;
  readonly effect: NexusEffect;
  readonly stores: readonly NexusStore[];
  readonly summary: string;             // consumed by help renderer (DELTA)
  readonly stability: 'stable' | 'experimental' | 'deprecated';
  /** When false, a stale index produces a `meta.warnings[]` entry. */
  readonly indexSensitive: boolean;
}

// Per-scope narrowing aliases (`ProjectScopedOp`, `CrossScopedOp`, etc.)
// derived via `NexusOperationDescriptor & { scope: <K> }` — one per NexusScope member.
```

Dispatch engine looks up `id → descriptor` to (a) decorate the envelope, (b) pick the
right DB connection, (c) feed help text to DELTA.

---

## 2. LAFS envelope `meta` extension — `MetaWithScope`

`LAFSMeta` (`@cleocode/lafs/src/types.ts:127`) is upstream and domain-neutral. Extend
via the `LAFSMetaWithBudget` pattern — namespaced under `_nexus` so tasks/brain/conduit
can add sibling blocks later without collision.

```ts
/** Index freshness fingerprint stamped on every index-sensitive response. */
export interface IndexFreshness {
  readonly lastIndexedAt: string | null;
  readonly headShaAtIndex: string | null;
  readonly currentHeadSha: string | null;
  /** True iff lastIndexedAt non-null AND currentHeadSha === headShaAtIndex. */
  readonly isFresh: boolean;
  /** Index can be fresh-by-SHA but stale-by-tree. */
  readonly workingTreeDirty: boolean;
}

/** Resolved scope context — ALWAYS present on a nexus envelope. */
export interface NexusScopeMeta {
  readonly scope: NexusScope;
  /** base64url(path).slice(0,32); null only when scope is `global`. */
  readonly projectId: string | null;
  /** From .cleo/project-info.json:name; null when global. */
  readonly projectName: string | null;
  readonly projectPath: string | null;
  readonly registryPath: string;                       // always populated
  readonly counterpartProjectId: string | null;        // hybrid only
  /** Populated only when descriptor.indexSensitive is true. */
  readonly indexFreshness: IndexFreshness | null;
  readonly bindingSource:
    'arg-project-id' | 'arg-path' | 'cwd' | 'registry' | 'none';
}

import type { LAFSMeta } from '@cleocode/lafs';
export interface MetaWithScope extends LAFSMeta {
  readonly _nexus: NexusScopeMeta;
}
```

**Namespaced `_nexus`, not flat:** agents introspect `meta._nexus?.scope` the way they
already introspect `meta._tokenEstimate`. LAFS spec stays domain-neutral; extension
lives in CLEO contracts, not the protocol package.

---

## 3. `scope-map.ts` SSoT — file shape and consumers

**Location:** `packages/contracts/src/operations/nexus-scope-map.ts`.

```ts
import type { NexusOperationDescriptor, NexusScope } from './nexus-scope.js';
import type { NexusOps } from './nexus.js';

/** Single source of truth. Every NexusOps key MUST appear exactly once. */
export const NEXUS_SCOPE_MAP = {
  // project — cwd-default, ~22 ops (status, analyze, context, impact, query, ...)
  'status':        { scope: 'project', binding: { kind: 'cwd' }, effect: 'read',
                     stores: ['nexus-graph'], indexSensitive: false,
                     summary: 'Index health for the current project',
                     stability: 'stable' },
  'context':       { scope: 'project', binding: { kind: 'cwd' }, effect: 'read',
                     stores: ['nexus-graph'], indexSensitive: true,
                     summary: '360° symbol view: callers, callees, processes',
                     stability: 'stable' },
  // living-brain — 5 ops (full-context, task-footprint, why, ...)
  'full-context':  { scope: 'living-brain', binding: { kind: 'cwd' }, effect: 'read',
                     stores: ['nexus-graph', 'brain', 'tasks'], indexSensitive: true,
                     summary: 'Cross-substrate symbol context',
                     stability: 'stable' },
  // cross — registry-walking, 13 ops (projects.list, discover, deps, graph, ...)
  'projects.list': { scope: 'cross', binding: { kind: 'registry' }, effect: 'read',
                     stores: ['nexus-registry'], indexSensitive: false,
                     summary: 'List every project registered in the global nexus',
                     stability: 'stable' },
  // hybrid — 3 ops (transfer, transfer.preview, link-tasks)
  'transfer':      { scope: 'hybrid', binding: { kind: 'two-projects' }, effect: 'write',
                     stores: ['nexus-registry', 'tasks', 'brain'], indexSensitive: false,
                     summary: 'Move tasks between two registered projects',
                     stability: 'stable' },
  // global — 8 ops (init, register, unregister, permission, share, export, ...)
  'init':          { scope: 'global', binding: { kind: 'none' }, effect: 'admin',
                     stores: ['nexus-registry'], indexSensitive: false,
                     summary: 'Initialize the global nexus registry',
                     stability: 'stable' },
  // ... remaining ~40 ops elided for line budget; full table: one row per NexusOps key
} as const satisfies {
  readonly [K in keyof NexusOps]: Omit<NexusOperationDescriptor, 'id'>;
};

export function getNexusDescriptor<K extends keyof NexusOps>(
  id: K,
): NexusOperationDescriptor & { id: K } {
  return { id, ...NEXUS_SCOPE_MAP[id] } as NexusOperationDescriptor & { id: K };
}

export function listOpsByScope(scope: NexusScope): readonly (keyof NexusOps)[] {
  return (Object.keys(NEXUS_SCOPE_MAP) as (keyof NexusOps)[])
    .filter((k) => NEXUS_SCOPE_MAP[k].scope === scope);
}

/** Adding a NexusOps key without scope = TypeScript error. */
export type _ExhaustivenessCheck =
  typeof NEXUS_SCOPE_MAP extends Record<keyof NexusOps, unknown> ? true : never;
```

**Consumers — single source, four readers, no duplication:**

| Consumer                                          | Reads                              | Outcome                                       |
| ------------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| `cleo/src/dispatch/nexus-decorator.ts`            | `getNexusDescriptor(id)` per call  | Stamps `meta._nexus` on every response        |
| `cleo/src/help/nexus-help-renderer.ts` (DELTA)    | `listOpsByScope(scope)`            | Groups CLI help by scope                      |
| `cleo/src/dispatch/engines/nexus-engine`          | `descriptor.stores`                | Picks DB connection + acquires the right lock |
| `contracts/__tests__/nexus-scope.test`            | `_ExhaustivenessCheck`             | Compile-time gate on missing mappings         |

---

## 4. DB topology — **split, with caveat**

**Split** `nexus.db` → `nexus-registry.db` (global) + `nexus-graph/<projectId>.db` (one
file per project). Today: one global file `~/.local/share/cleo/nexus.db`, every table
partitioned by `projectId` column. Registry has 80,969 polluted rows (T1835); graph per
active project is 50-200 MB. Vacuum on registry locks the whole file; graph rebuild for
A blocks `nexus list` for everyone.

```
~/.local/share/cleo/
├── nexus-registry.db    # nexus_projects, project_permissions, cross_project_links, orphans
└── nexus-graph/<projectId>.db  # nexus_nodes/relations/communities/processes/hot_paths/fts
```

### Migration (idempotent + reversible)

Single transactional migration `core/src/nexus/migrations/M-split-graph.ts`:
(1) open old `nexus.db` read-only; (2) materialize registry tables → `nexus-registry.db`
via `ATTACH` + `INSERT INTO`; (3) for each `DISTINCT project_id` in `nexus_nodes`, create
`nexus-graph/<projectId>.db`, copy per-project rows, drop the `project_id` column (now
implicit by file location); (4) rename old → `nexus.db.legacy.<timestamp>` (restore is
`mv`); (5) stamp `~/.local/share/cleo/nexus-version.json` with `{ topology, migratedAt }`.
Re-running on already-split state is a no-op; `--rollback` re-merges from legacy.

### Locking

Pre-split: `nexus list` blocks graph writes; `analyze` for A blocks `list` everywhere.
Post-split: `list` reads only `nexus-registry.db`; `analyze` locks only
`nexus-graph/A.db`. Hybrid ops are the only multi-lock holders — they MUST acquire in
canonical order `registry → graph(min(idA,idB)) → graph(max)` to prevent deadlock. The
descriptor's `stores` field tells the engine which locks to acquire.

### Performance + caveat

`nexus list` latency drops ~10× (no multi-GB scan); `analyze` no longer WAL-contends
with sibling reads; `context` is I/O-local (SQLite mmap is per-file). **Caveat:**
cross-project queries (`impact-full --cross`) open one DB handle per visited project —
at ~3 ms per file, projects with > 100 registered see open-handle cost dominate.
Mitigation: LRU pool of `Database` handles in `core/src/nexus/store.ts`, soft cap 32.
Acceptable — the 80k-row pollution dominates today.

---

## 5. Confidence three-state migration

`confidence: number` in `[0, 1]` lives on relations (`gexf-export.ts:185`), living-brain
(`living-brain.ts:625`), api-extractors (`http-extractor.ts:110`). No discriminator —
`0.95` could mean AST-extracted or heuristic-inferred. Target — discriminated union:

```ts
export type ConfidenceProvenance =
  | { readonly kind: 'extracted';
      readonly source: 'ast' | 'lsp' | 'docstring' | 'manifest';
      readonly score: 1.0; }                  // by definition
  | { readonly kind: 'inferred';
      readonly heuristic: string;             // e.g. 'name-similarity', 'co-occurrence'
      readonly score: number;                 // (0, 1) exclusive
      readonly observations: number; }        // sample size feeding the heuristic
  | { readonly kind: 'ambiguous';
      readonly reason: 'multiple-candidates' | 'shadow-binding' | 'parse-failure';
      readonly candidates: ReadonlyArray<{ readonly id: string; readonly score: number }>;
      readonly score: number; };              // best candidate's score

export interface ConfidenceField {
  readonly provenance: ConfidenceProvenance;
  /** @deprecated since v2026.6 — use `provenance.score`. Removed in v2026.9. */
  readonly confidence: number;
}
```

**Gradient deprecation.** Phase 0 (now → v2026.6): both fields populated; `provenance`
derived from store kind. Phase 1 (v2026.6 → v2026.9): reading `confidence` adds a
`Warning` to `meta.warnings` per LAFS spec. Phase 2 (v2026.9+): `confidence` removed;
consumers reading it get `undefined`.

**Storage:** add `provenance_kind TEXT NOT NULL`, `provenance_source TEXT`,
`provenance_score REAL NOT NULL` to `nexus_relations`. Backfill: rows with
`confidence = 1.0` → `kind='extracted', source='ast', score=1.0`; else →
`kind='inferred', heuristic='legacy', score=confidence`. One scan per graph DB,
bounded by §4's split.

---

## 6. Why this beats the obvious alternatives

- **vs. ALPHA's "split into N command trees":** structural-only without scope metadata
  still leaves shapeless envelopes. My contract makes agent introspection work
  regardless of whether ALPHA splits. Pair, do not compete.
- **vs. GAMMA's "rename + alias + deprecation":** renames fix surface; a renamed
  `nexus list-projects` still leaks no `projectId` in response. Renames and wire-format
  compose orthogonally.
- **vs. DELTA's "agent-discoverable help":** DELTA needs scope metadata to group help.
  My `NEXUS_SCOPE_MAP` is the SSoT DELTA reads. I **enable** DELTA — without my map,
  DELTA hardcodes scope strings in renderers.
- **vs. "just add a `--scope` flag":** flags are caller-side, runtime-checked, and lost
  to `--json` consumers reading only the envelope. A descriptor is contract-side,
  compile-time-checked, self-documenting via TSDoc, and `meta._nexus` survives `--json`.
- **vs. "leave `nexus.db` monolithic, add views":** views do not solve lock contention.
  80k registry rows are a write-amplification problem, not a query problem. Splitting
  is the only fix that lets `analyze` and `list` run concurrently.

---

## 7. One concrete failure mode of my own proposal

`MetaWithScope._nexus.indexFreshness.workingTreeDirty` requires a `git status` shell-out
per index-sensitive response. Even cached, on a 10k-file repo `git status` takes 200-800
ms. If `nexus context` is called 30× per agent turn (a realistic ct-task-executor
pattern), cumulative latency dominates the graph read itself. Rejected mitigations:
*skip the check* (defeats the guarantee); *cache for 30s* (race — agent edits, calls
`context`, gets stale "clean"; worse than no answer). **Ship-ready mitigation, flagged
as debt:** populate `workingTreeDirty` only when `descriptor.indexSensitive === true`
AND the call is a top-level CLI invocation; sub-calls inherit parent freshness via
`meta.requestId` lineage — caps shell-out to once per agent turn. The inheritance scheme
requires a request-lineage mechanism not currently in dispatch; that becomes a sibling
task to `packages/cleo/src/dispatch/` if this proposal lands.

---

**END LEAD BETA.**
