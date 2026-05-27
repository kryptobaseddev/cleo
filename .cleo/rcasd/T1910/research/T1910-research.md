---
epic: T1910
stage: research
task: T1910
related:
  - type: task
    id: T1910
created: 2026-05-06
updated: 2026-05-06
---
# Research (T1910)

## Method

3 parallel orchestrator-spawned `Explore` agents audited (a) `@cleocode/paths` consumers vs drift, (b) CAAMP↔adapters duplication, (c) existing task-tree alignment. Findings synthesized below.

## (a) Paths SSoT — `@cleocode/paths` post-T1882

Package owns: `getCleoHome`, `getCleoPlatformPaths`, `getCleoSystemInfo`, `getCleoTemplatesTildePath`, `isAbsolutePath`, worktree primitives, factory `createPlatformPathsResolver(appName, homeEnvVar)`.

Migrated consumers: core (partial), worktree, brain, caamp platform-paths façade, adapters/shared, sessions.

**~14 drift sites still hardcoding XDG logic:**

| File | Line | Pattern | Should call |
|------|-----:|---------|-------------|
| `adapters/providers/gemini-cli/install.ts` | 16 | `'@~/.cleo/templates/CLEO-INJECTION.md'` | `getCleoTemplatesTildePath()` |
| `adapters/providers/kimi/install.ts` | 16 | same | same |
| `adapters/providers/openai-sdk/install.ts` | 16 | same | same |
| `caamp/core/paths/standard.ts` | 396-409 | duplicates XDG fallback `getCleoHomeForTemplate()` | `getCleoHome()` |
| `caamp/core/harness/scope.ts` | 128 | hardcoded `~/.local/share/cleo` | `getCleoHome()` |
| `core/paths.ts` | 1192 | orphan `getAgentsHome()` | `createPlatformPathsResolver('agents','AGENTS_HOME')` |
| `cleo/cli/commands/daemon.ts` | 189,271,315,454 | `homedir()+'.cleo'` | `getCleoHome()` |
| `cleo/cli/commands/gc.ts` | 64,115 | same | same |
| `cleo/dispatch/domains/playbook.ts` | 199 | hardcoded XDG playbooks | `join(getCleoHome(),'playbooks')` |
| `core/nexus/transfer.ts` | 75 | XDG fallback duplicate | `getCleoHome()` |
| `core/gc/runner.ts` | 283 | `homedir()+'.cleo'` | `getCleoHome()` |
| `cleo-os/extensions/cleo-cant-bridge.ts` | 875 | XDG duplicate | `getCleoHome()` |
| `git-shim/src/audit-log.ts` | 75 | XDG duplicate | `getCleoHome()` |
| `git-shim/src/worktree-path.ts` | 30 | XDG duplicate | `getCleoHome()` |

## (b) CAAMP↔adapters duplication

CAAMP `providers/registry.json` has 44 providers with `instructFile`, mcp config keys. **9 adapter folders never reference it** — they hardcode `instructFile` per-provider.

CAAMP exposes `inject()`, `injectAll()`, `ensureProviderInstructionFile()` with marker consolidation. **9 adapter installers bypass the API** and `readFileSync → filter → writeFileSync` directly (~150 LOC duplication).

9 adapters define `INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md']` locally — same content, redefined 9×.

## (c) Task tree alignment

- **T1882** (paths SSoT epic): DONE.
- **T916, T917**: cancelled pre-T1882 as "low-value-floater". Post-T1882 valid → resurrected as A1, A2 of T1910.
- **T1638, T1661**: pending; touch CLEO-INJECTION.md *content* — orthogonal to T1910 *path/refs* axis. Coordinate to avoid edit collisions.
- **T1737** (CleoOS v3): downstream broader harness rework. T1910 hardens current state; T1737 may absorb outputs later.
- **T1768** (SDK Tools): adjacent to T1921 boundary ADR.

## Decisions locked (architecture)

1. **CAAMP owns** generic injection API + provider registry (single source of truth for `instructFile`, `instructionReferences`, `mcpConfigKey`, capabilities) + marker-based injection engine.
2. **Adapters own** provider-specific runtime concerns (spawn, statusline, hooks, plugins, context monitoring) — CONSUME CAAMP, never reimplement.
3. **CLEO core** consumes CAAMP API; supplies dynamic reference lists (registry default + explicit override via `references[]`).
4. **`@cleocode/paths`** owns all platform/XDG resolution — every package consumes it.

Codified as ADR via T1921 (B3) so future drift is detectable.

## Implementation readiness

Each child has concrete file paths, code patterns to match, verifiable acceptance criteria. Wave 0 (T1911-T1914) is dependency-free and ready for parallel dispatch.

## Verdict

**Implementation-ready.** Advance research → consensus → architecture_decision → specification → decomposition (already complete via task filing) → implementation.
