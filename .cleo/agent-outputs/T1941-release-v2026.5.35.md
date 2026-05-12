# T1941 Release Output: v2026.5.35 (T1929 Phase 1 Bundled Release)

**Task**: T1941
**Date**: 2026-05-06
**Status**: partial (release shipped; E2E spawn V_AGENT_NOT_FOUND in published CLI — pre-existing architectural gap, not T1929 regression)

---

## Release Summary

T1929 Phase 1 (Agent System Canonicalization v2) shipped as **v2026.5.35** after 5 incremental hotfixes to address CI gate failures discovered during the release pipeline.

### Published Version

- **Final version**: `2026.5.35`
- **npm**: `@cleocode/cleo@2026.5.35` published and verified
- **Global install**: `cleo --version` returns `2026.5.35` ✓

### Hotfix Chain (no-tag-reuse policy)

| Tag | Failure | Fix |
|-----|---------|-----|
| v2026.5.30 | `pnpm install --frozen-lockfile` — lockfile missing `@cleocode/animations` workspace link | Added entry to lockfile |
| v2026.5.31 | biome CI — unsorted exports in `packages/core/src/index.ts` | Sorted exports (committed working tree fix) |
| v2026.5.32 | CHANGELOG CI — `## [v2026.5.32]` not found (CI expects no `v` prefix) | Removed `v` prefix from all new entries |
| v2026.5.33 | typecheck CI — TS2307 Cannot find `@cleocode/animations` | Added animations to `tsconfig.json` project references |
| v2026.5.34 | Canon Drift + Build Verify — ERR_MODULE_NOT_FOUND `@cleocode/animations` at runtime | Added animations to `build.mjs` workspacePlugin inline map |
| **v2026.5.35** | **Release: SUCCESS** | Final release |

### CI Status (v2026.5.35)

| Gate | Result |
|------|--------|
| Lockfile Check | SUCCESS |
| Release workflow | SUCCESS — all packages published to npm |
| CI (unit tests) | FAILURE — pre-existing Category B failures (adapters mock mismatches, cleo cmd output mismatches) |

The CI unit test failures are pre-existing (filed as T9035, T9036 per T9033 classification). The Release workflow is the authoritative gate for publishing.

---

## Bundled Scope (23 Task IDs)

T1929, T1930, T1931, T1932, T1934, T1935, T1936, T1937, T1938, T1939, T1940, T1845, T1855, T1912, T1916, T1928, T9011, T9012, T9013, T9014, T9017, T9031, T9033

---

## Commits (release chain)

| SHA | Message |
|-----|---------|
| 17b41055d | chore(release/T1929-wave-1): bump to v2026.5.30 |
| 4b1cc50d8 | chore(release/T1929-wave-1): bump to v2026.5.31 — hotfix lockfile |
| 764751337 | fix(release/T1941): sort core/index.ts exports |
| c0f7def57 | chore(release/T1929-wave-1): bump to v2026.5.32 — biome sort fix |
| 4a94e35ae | chore(release/T1929-wave-1): bump to v2026.5.33 — CHANGELOG format |
| 86e607da6 | chore(release/T1929-wave-1): bump to v2026.5.34 — add animations tsconfig refs |
| 89314d102 | chore(release/T1929-wave-1): bump to v2026.5.35 — inline animations in bundle |

---

## Gate Results (pre-tag v2026.5.35)

| Gate | Exit | Notes |
|------|------|-------|
| `pnpm biome ci .` | 0 | 2158 files checked |
| `pnpm run typecheck` | 0 | Clean |
| `pnpm run build` | 0 | All packages built |
| `pnpm run test` | 1 | 18-19 pre-existing Cat B failures only |

---

## E2E Spawn Verification

`cleo orchestrate spawn T1820 --json | jq -r '.success'` returns `false`.

**Root cause**: `V_AGENT_NOT_FOUND` + `V_UNMET_DEP` (T1819 archived, T1941 still pending).

The `V_AGENT_NOT_FOUND` in the published CLI stems from a pre-existing architectural gap:
`resolveDefaultUniversalBasePath()` in `agent-resolver.ts` uses `fileURL`-relative paths
(workspace-relative) that resolve correctly in the workspace but not in the global npm install
where `@cleocode/agents` is not installed alongside `@cleocode/cleo`.

This is NOT a T1929 regression — T1940 regression tests all pass (they run in the workspace).
Filed as follow-up: the published CLI needs `@cleocode/agents` as a peer/runtime dep, or the
universal tier resolver needs to check the XDG global path (~/.local/share/cleo/agents/).

**Recommended follow-up**: File separate task to wire `~/.local/share/cleo/agents/cleo-subagent.cant`
as a universal tier candidate when `@cleocode/agents` isn't resolvable from the bundle path.

---

## Post-Release Actions

- T1877 superseded: `.cleo/audit/superseded-tasks.jsonl` updated ✓
- T1879 superseded: `.cleo/audit/superseded-tasks.jsonl` updated ✓
- T1929 epic: NOT closed (E2E spawn still fails in published CLI — partial release)
- Memory observation: to be appended after cleo complete

---

## Artifacts

- `/mnt/projects/cleocode/CHANGELOG.md` (sections 2026.5.30–2026.5.35)
- `/mnt/projects/cleocode/tsconfig.json` (animations reference added)
- `/mnt/projects/cleocode/packages/cleo/tsconfig.json` (animations reference added)
- `/mnt/projects/cleocode/build.mjs` (animations inline bundle map)
- `/mnt/projects/cleocode/.cleo/audit/superseded-tasks.jsonl` (T1877, T1879)
