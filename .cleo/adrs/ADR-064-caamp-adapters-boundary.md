# ADR-064: CAAMP↔Adapters Ownership Boundary

- **Status**: Accepted
- **Date**: 2026-05-06
- **Task**: T1921 (T1910 epic — CAAMP consolidation wave B)
- **Cross-references**: T1882 (paths SSoT), T1910 (consolidation epic), T1916 (B1: API + registry), T1919 (B2: 9 adapter consolidations)

## Context

Before the T1910 consolidation, each of the 9 provider adapters under
`packages/adapters/src/providers/` independently managed instruction-file
injection. Every adapter folder:

- Defined its own `INSTRUCTION_REFERENCES` constant (~150 LOC duplicated
  across 9 files).
- Bypassed CAAMP's `inject()` API in favour of direct `writeFileSync` calls
  against known instruction-file paths.
- Hard-coded `instructFile` strings (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`)
  rather than reading them from the CAAMP registry.
- Reimplemented path resolution instead of consuming `@cleocode/paths`
  (T1882 SSoT).

CAAMP's `providers/registry.json` already held the canonical
`instructFile`, `instructionReferences`, `mcpConfigKey`, and
`capabilities` for every provider — but nothing in the codebase was
consuming that data. The registry was the right source of truth; the
adapters were not using it.

T1916 (B1) centralised the registry API and added
`getProviderInstructionReferences()`. T1919 (B2) consolidated all 9
adapters to call CAAMP's `inject()` / `ensureProviderInstructionFile()`
instead of reimplementing locally. Those two tasks prove the correct
shape of the boundary. This ADR codifies that shape as a durable
architectural constraint.

## Decision

Three packages own the concerns listed below. No other package
reimplements any of these concerns.

### Ownership Matrix

| Concern | Owner | Notes |
|---------|-------|-------|
| XDG / platform path resolution | `@cleocode/paths` | Universal SSoT (T1882). Every package that needs `configDir`, `dataDir`, or `cacheDir` imports from here. None may reimplement. |
| Provider registry (instructFile, instructionReferences, mcpConfigKey, capabilities) | `@cleocode/caamp` | `providers/registry.json` is the single source of truth. Per-provider data centralised here; adapters and CLI alike query CAAMP, never maintain their own copies. |
| Instruction-file injection engine (markers, idempotent inject, consolidate-and-replace) | `@cleocode/caamp` | `inject()`, `ensureProviderInstructionFile()`, `getProviderInstructionReferences()`. Generic, provider-agnostic API consumed by all callers. No caller may reimplement the marker / idempotency logic. |
| Provider-specific runtime (spawn, statusline, hooks, plugins, context-monitoring) | `@cleocode/adapters` | Each provider folder under `src/providers/` is a thin runtime adapter. It calls CAAMP for any registry or injection work. It never reimplements registry data or injection logic. |
| Bootstrap injection content (what to inject into `~/.agents/AGENTS.md`) | `@cleocode/cleo` config | `globalInjectionRefs` field in CLEO project config (T1920). Configurable by the project owner; default value is derived from CAAMP registry-based references at install time. |

### Invariants

1. **No `INSTRUCTION_REFERENCES` constant in adapter folders.** Any const
   holding instruction-file reference arrays belongs in
   `packages/caamp/providers/registry.json`, not in an adapter.

2. **No direct `writeFileSync` to known instruction-file targets from
   adapters.** All writes to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
   future instruction files MUST go through `@cleocode/caamp`'s
   `inject()` or `ensureProviderInstructionFile()`.

3. **No path-resolution reimplementation.** Any call that constructs a
   platform config path MUST import the resolver from `@cleocode/paths`.

4. **Registry queries are read-only from callers.** Callers read from
   CAAMP. Only CAAMP mutates `registry.json` (via its own CLI or
   internal migrations).

### Adding a new provider

1. Add an entry to `packages/caamp/providers/registry.json` (name,
   instructFile, instructionReferences, mcpConfigKey, capabilities).
2. Create a thin adapter folder under
   `packages/adapters/src/providers/<provider>/` implementing the
   `ProviderAdapter` interface.
3. The adapter calls `getProviderInstructionReferences(name)` and
   `inject(...)` from CAAMP. It does not copy the reference list.
4. No instruction-file logic beyond calling the CAAMP API.

## Drift Detection

`cleo doctor` SHOULD add a check that flags any adapter folder that:

- Defines a constant whose name contains `INSTRUCTION_REFERENCES`
  (case-insensitive).
- Calls `writeFileSync` (or `fs.writeFileSync`) where the destination
  path string literal matches a known instruction-file name
  (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `CODEX.md`).

These patterns are footguns introduced by the pre-T1910 regime.
Detecting them early prevents accretion of the duplicated logic that
T1919 removed.

## Consequences

### Positive

- **Adapter folders shrink.** The ~150 LOC of duplicated reference arrays
  and injection logic is gone; adapter files contain only runtime
  provider concerns.
- **CAAMP is the integration hub.** Adding a new provider requires only
  a registry entry and a thin runtime adapter — no instruction-file
  logic.
- **Paths drift is detectable.** Because `@cleocode/paths` is the sole
  resolver, any divergence shows up as an import of a different path
  library, not as invisible magic strings.
- **Registry is testable in isolation.** CAAMP unit tests cover
  injection once; adapters no longer need injection tests.

### Negative / Trade-offs

- **Adapter packages gain a runtime dependency on `@cleocode/caamp`.**
  This is correct: adapters are consumers of CAAMP, not peers. The
  dependency direction is intentional.
- **`registry.json` becomes load-bearing.** A malformed entry silently
  breaks injection for that provider. Existing CAAMP validation tests
  cover this; extend them whenever a new field type is introduced.

### Migration

T1916 and T1919 executed the migration. No further mechanical changes
are required. Future work:

- Wire `cleo doctor` drift-detection check (out of scope for T1921).
- Consider adding a JSON Schema for `registry.json` to catch typos at
  edit time (out of scope for T1921).

## References

- T1882 — `@cleocode/paths` as XDG/platform path SSoT
- T1910 — CAAMP consolidation epic
- T1916 — B1: centralised registry API + `getProviderInstructionReferences()`
- T1919 — B2: 9 adapter consolidations (eliminating `INSTRUCTION_REFERENCES` copies)
- ADR-039 — LAFS envelope format (CAAMP instruction injection follows LAFS)
- ADR-051 — Evidence-based gate ritual
- ADR-055 — Agents architecture and meta-agents
