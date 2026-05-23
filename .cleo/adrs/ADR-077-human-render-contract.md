# ADR: Universal Human Render Contract — Typed Envelope → Reusable Primitive → Fast String

- **Status**: Accepted (Implemented v2026.5.97+ via Epic T10114 B1–B12)
- **Date**: 2026-05-22 (proposed) · 2026-05-23 (accepted)
- **Epic**: T10114 (E11-HUMAN-RENDER-CONTRACT)
- **Saga**: T9855 (SG-TEMPLATE-CONFIG-SSOT)
- **Layers on**: T9927 (E9-CLI-OUTPUT-CONTRACT — emission discipline)
- **Sibling to**: T9919 (E8-LAFS-LLM-OPTIMIZATION — envelope shape)
- **Authors**: cleo-prime, audited by 3 parallel research agents (2026-05-22)
- **Closeout**: T10137 (B12 — ADR finalize + ct-cleo skill + INJECTION patterns)

## Context

CLEO's CLI emits LAFS JSON envelopes by default (machine format) and renders
them for humans via a `--human` flag (or default in interactive TTY mode).
T9927 (E9-CLI-OUTPUT-CONTRACT) covers the EMISSION side at ~95%: stdout
discipline, `--field <jsonpointer>`, `--output {envelope|id|table|count|silent}`,
`--summary`, `--quiet`, and minimal-by-default mutate envelopes.

T9927 does NOT cover the HUMAN side. Five gaps remain:

1. **No typed RenderableEnvelope discriminator**. Today, 66 specialized
   render functions in `packages/cleo/src/cli/renderers/` accept
   `Record<string, unknown>` and infer the data shape from keys at runtime.
   No discriminated union exists in contracts.
2. **No reusable Tree/Table/List/Badge primitives**. Every command rolls its
   own table padding, tree box-drawing, status emoji. `format-helpers.ts:dataTable()`
   exists as proof of consolidation, but only 3 of 20+ list-renderers use it.
3. **No typed icon enum**. Emoji symbols (🌲 ✅ 🚧 🪦 🚪 ⏳ 🔁 ⚠ 🗄) used in the
   canonical saga-tree style are hardcoded ad-hoc across 12+ files. No
   single source of truth, no NO_COLOR fallback.
4. **Boundary violation**. All 5,541 LOC of renderer code lives in
   `packages/cleo/src/cli/renderers/` (system.ts 1302 LOC, nexus.ts 1055 LOC,
   tasks.ts 371 LOC, format-helpers.ts 342 LOC). Per AGENTS.md
   Package-Boundary Check, this is domain logic — should be in
   `packages/core/`.
5. **`packages/animations/` underutilized**. Ships braille spinners,
   progress bars, sparks, and the `AnimateContext` LAFS-aware render gate.
   Consumed today only via `packages/cleo/src/cli/animation-bridge.ts` for
   spinners. No static UI primitives for trees/tables/lists.

**Surprise finding**: render performance is fine (90–102ms measured for
`cleo saga list`). The 5–20s waits the user perceives come from underlying
aggregating operations (saga rollup, deps validate, briefing), NOT from
rendering. This Epic is about maintainability + consistency, not speed.

## Decision

Layered architecture: **typed contracts → animations primitives → core entry
point → cleo thin shell**. All rendering logic lives in `packages/core/`. All
visual primitives live in `packages/animations/` (extended for static UI).
`packages/cleo/` becomes a thin CLI dispatcher.

### 1. `packages/contracts/src/render/` — typed renderable shapes

| File | Type |
|------|------|
| `tree.ts` | `TreeResponse<T>`, `FlatTreeNode<T>`, `RenderTreeOptions` |
| `table.ts` | `TableResponse<T>`, `TableSchema<T>` |
| `list.ts` | `ListResponse<T>`, `GroupedListResponse<T>` |
| `envelope.ts` | `RenderableEnvelope<T>` — discriminated union by `kind` |
| `icon.ts` | `StatusIcon`, `KindIcon`, `BadgeIcon`, `RelationIcon` enums |

`RenderableEnvelope<T>` is the contract every renderer accepts. The
`kind` discriminator narrows at runtime via the type guards
(`isTreeEnvelope`, `isTableEnvelope`, …) shipped alongside.

Canonical `kind` values: `'tree' | 'table' | 'list' | 'grouped-list' | 'section' | 'single' | 'generic'`.

### 2. `packages/contracts/src/render/icon.ts` — typed icon enums

```ts
export enum StatusIcon  { PENDING='⏳', ACTIVE='🚧', DONE='✅', BLOCKED='🚪',
                          ARCHIVED='🗄', CANCELLED='✗' }
export enum KindIcon    { SAGA='🌲', EPIC='📋', TASK='•', SUBTASK='◦',
                          RESEARCH='📖', BUG='🐛', RELEASE='🚀' }
export enum BadgeIcon   { EMPTY='🪦', ORPHAN='👻', NESTED='🔁',
                          CAUTION='⚠', NEW='★' }
export enum RelationIcon{ GROUPS='⊂', PARENT='⤴', DEPENDS='⇨', BLOCKS='⊘' }
```

A standalone `ascii(icon)` helper returns the NO_COLOR-safe fallback for any
icon value.

#### Implementation note — `BadgeIcon.ORPHAN` deviation (T10137)

The proposed draft of this ADR specified `BadgeIcon.ORPHAN = '🚪'`, identical
to `StatusIcon.BLOCKED = '🚪'`. TypeScript string enums share a single runtime
string for any two members assigned the same literal — both members collapse
to the same value, breaking the exhaustive switch in `ascii()` because the
compiler cannot distinguish `BadgeIcon.ORPHAN` from `StatusIcon.BLOCKED` at
runtime.

T10127 (B2) resolved this by switching `BadgeIcon.ORPHAN` to `'👻'`
(abandoned/lonely semantics — a task with no parent and no Saga reachability).
The change preserves the “unreachable” visual without colliding with the
blocked-on-dependency icon. This ADR amendment ratifies the deviation; no
further change is planned.

### 3. `packages/animations/src/render/` — extension with static primitives

| File | Function | Consumes |
|------|----------|----------|
| `tree.ts` | `renderTree(treeResp, opts)` | `TreeResponse<T>` from B1.1 |
| `table.ts` | `renderTable(tableResp, opts)` | `TableResponse<T>` from B1.2 |
| `section.ts` | `renderSection({icon, header, items})` | `BadgeIcon` from B2 |
| `legend.ts` | `renderLegend({items})` + `renderSummary({counts})` | icons + counts |
| `badge.ts` | `renderBadge(icon)` + `renderStatusBadge(status)` | enums from B2 |

All pure-string output. All gated through `AnimateContext` — when format=json,
primitives return `''`. No state, no I/O.

### 4. `packages/core/src/render/` — entry point + registry

```ts
export function renderEnvelopeForHuman<T>(
  envelope: CleoResponse<T>,
  command: string,
  opts?: RenderOptions,
): string;
```

Single public API. Internally:
- Parses LAFS envelope (success vs error).
- Reads `envelope.data.kind` discriminator (or falls back to command lookup).
- Routes to the matching renderer in the registry.
- Returns pure string for stdout.

#### Registry shape

The registry is a process-global `Map<\`${command}:${kind}\`, Renderer>`
keyed by the typed `RegistryKey` template literal type
(`packages/core/src/render/types.ts`). Two functions exposed from
`packages/core/src/render/registry.ts`:

```ts
export function registerRenderer<T>(
  command: string,
  kind: RenderableEnvelope<T>['kind'],
  renderer: Renderer<T>,
): void;

export function lookupRenderer<T>(
  command: string,
  kind: RenderableEnvelope<T>['kind'],
): Renderer<T> | undefined;
```

#### Side-effect registration pattern

Family modules (`session/`, `orchestration/`, `nexus/{graph,contracts,audit}/`,
`tasks/`, `system/`) register their renderers at module-load time via
top-level `registerRenderer(...)` calls. The `packages/core/src/render/`
barrel re-exports each family's `index.ts` with a side-effect import so
loading `@cleocode/core` populates every slot:

```ts
// packages/core/src/render/index.ts (excerpt)
export * from './nexus/index.js';   // side-effect: nexus registrations
export * from './render-envelope.js';
export * from './registry.js';
```

Each family barrel (`nexus/index.ts`, `nexus/graph/index.ts`, …) follows
the same side-effect re-export pattern. The first import of any path
inside `@cleocode/core/render` is sufficient — no explicit init step is
required by callers.

All 5,541 LOC migrated from `packages/cleo/src/cli/renderers/` into
`packages/core/src/render/` organised by family:
- `session/` (briefing, blockers, next, current, doctor, …)
- `orchestration/` (tree, waves, plan, …)
- `brain/` (memory, maintenance, …)
- `nexus/{graph,contracts,audit}/` (~30 renderers)
- `tasks/` (show, list, find, …)
- `system/` (version, schema, generic)
- `helpers/` (kvBlock, dataTable, truncated)

### 5. `packages/cleo/src/cli/` — thin shell

`packages/cleo/src/cli/renderers/index.ts` shrinks to ~20 LOC:

```ts
export function cliOutput(data: unknown, opts: CliOutputOptions): void {
  const ctx = getFormatContext();
  if (ctx.format === 'json') {
    console.log(formatSuccess(data, ...));
  } else {
    const env = wrapAsRenderableEnvelope(data, opts.command);
    const text = renderEnvelopeForHuman(env, opts.command, ctx);
    if (text) process.stdout.write(text + '\n');
  }
}
```

### 6. New generic `cleo tree --root <id> --depth <n> --kinds <list>` command

Derives entirely from `TreeResponse<T>` (B1.1). Produces the canonical
🌲 saga→epic→task→subtask tree style from any root ID. Replaces several
hand-rolled tree views in `cleo orchestrate waves`, `cleo deps tree`, etc.

The simpler `cleo tree <id>` invocation walks parent + groups edges to full
depth — useful for agents that want a one-shot hierarchy snapshot.

### 7. Performance contract

`renderEnvelopeForHuman`:
- ≤ 100ms for 1,000 rows
- ≤ 500ms for 10,000 rows
- ≤ 200ms for 100-node tree at depth 3

Asserted by `packages/core/src/render/__tests__/perf.test.ts` on every CI
build. Pure functions — no DB access in render path (enforced by lint
rule banning DB imports under `packages/core/src/render/`).

### 8. CI lint gates

- `scripts/lint-stdout-discipline.mjs` — fails on any `process.stdout.write`
  outside `packages/core/src/render/`, `packages/animations/`,
  `packages/cleo/src/cli/animation-bridge.ts`, or
  `packages/cleo/src/cli/renderers/index.ts` (the thin dispatcher).
- Skill-drift coverage for `ct-cleo` updated with new render contract patterns.

## Consequences

### Positive

- **Boundary fix**: 5,541 LOC migrated from `packages/cleo/` to
  `packages/core/`. CLI becomes a thin dispatcher.
- **DRY**: Tree/Table/Section primitives consolidate hand-rolled code.
- **Typed**: `RenderableEnvelope<T>` discriminator eliminates `Record<string,
  unknown>` inference. Snapshot tests catch shape drift.
- **Visual consistency**: icon enums + B3 primitives produce the same
  beautiful tree style from `cleo saga rollup`, `cleo orchestrate waves`,
  `cleo deps tree`, `cleo tree --root T9855`, and any future caller.
- **Reusable beyond CLI**: CleoOS UI, future Studio, agent dispatch — all
  consume `renderEnvelopeForHuman()` for the same look.

### Negative

- **Migration surface**: 5,541 LOC moved across 4 files; snapshot tests must
  pass unchanged. Mitigated by family-batched subtasks (B6.1/.2/.3,
  B7.1/.2/.3) so each PR is bounded.
- **`packages/animations/` scope expansion**: package name implies motion,
  now also hosts static UI. Mitigated by keeping submodules clearly
  separated (`animations/src/braille.ts` for spinners vs
  `animations/src/render/` for static primitives). Rename to
  `@cleocode/ui` deferred to a separate decision if scope grows further.

### Neutral

- **Performance not improved**: render path was already 90–102ms. B11 locks
  the budget in so future regressions are caught.

## Implementation Tasks (Epic T10114)

| Task | Status | Title |
|------|--------|-------|
| T10126 | done | B1: typed render contracts |
| T10138 | done | B1.1: TreeResponse + FlatTreeNode |
| T10139 | done | B1.2: TableResponse + TableSchema |
| T10140 | done | B1.3: ListResponse + GroupedListResponse |
| T10141 | done | B1.4: RenderableEnvelope discriminated union |
| T10127 | done | B2: icon enums (ORPHAN deviation — see §2 implementation note) |
| T10128 | done | B3: animations static primitives |
| T10142 | done | B3.1: Tree primitive |
| T10143 | done | B3.2: Table primitive |
| T10144 | done | B3.3: Section primitive |
| T10145 | done | B3.4: Badge + StatusIcon renderer |
| T10146 | done | B3.5: Legend + summary footer |
| T10129 | done | B4: migrate format-helpers to core |
| T10130 | done | B5: renderEnvelopeForHuman() entry + registry |
| T10131 | done | B6: decompose system.ts |
| T10147 / T10148 / T10149 | done | B6.1 / B6.2 / B6.3 family migrations |
| T10132 | done | B7: decompose nexus.ts |
| T10150 / T10151 / T10152 | done | B7.1 / B7.2 / B7.3 family migrations |
| T10133 | done | B8: decompose tasks.ts |
| T10134 | done | B9: generic `cleo tree` command |
| T10135 | done | B10: CI lint gate |
| T10136 | done | B11: performance contract test |
| T10137 | done | B12: ADR + skill update (this doc) |

## References

- [T9927 E9-CLI-OUTPUT-CONTRACT](https://example) — sibling EMISSION contract
- [T9919 E8-LAFS-LLM-OPTIMIZATION](https://example) — sibling SHAPE contract
- [AGENTS.md Package-Boundary Check](../../AGENTS.md) — boundary rule
- [packages/animations/README.md](../../packages/animations/README.md) — current state
- [/tmp/sg-fragility-and-render-proposal.md](file:///tmp/sg-fragility-and-render-proposal.md) — synthesized audit report
