# T5554 — tools Domain Review

**Task**: T5554
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

The tools domain currently exposes 32 operations across three sub-domains (issue.*, skill.*, provider.*). After applying LAFS and MVI pressure, the domain can reach 19 operations by merging duplicate verbs (install/enable, uninstall/disable), collapsing the four-op skill.catalog.* surface into one parameterized call, removing the stub-only skill.configure, folding issue.* into a plugin boundary, and dropping issue.generate.config. This achieves the ≤22 ceiling with room to spare.

## Prior Analysis Summary (T5511)

T5511 identified three consolidation vectors:
1. **Merge skill.catalog.* (4 ops → 1)** — `skill.catalog.protocols`, `.profiles`, `.resources`, `.info` all hit the same catalog object; a `type` param collapses them.
2. **Precedence ops (2 ops)** — `skill.precedence.show` and `skill.precedence.resolve` are tier-1 and niche; question was whether to merge or drop.
3. **Issue domain boundary (7 ops)** — whether `issue.*` is a separate domain or plugin territory.

T5511 target was 32→26. This review pushes further to 19 by also tackling install/enable and uninstall/disable aliases.

---

## Operation Inventory (32 ops)

### Query (21)

| Operation | Tier | Sub-domain |
|---|---|---|
| issue.diagnostics | 0 | issue |
| issue.templates | 2 | issue |
| issue.validate.labels | 2 | issue |
| skill.list | 0 | skill |
| skill.show | 0 | skill |
| skill.find | 0 | skill |
| skill.dispatch | 0 | skill |
| skill.verify | 0 | skill |
| skill.dependencies | 0 | skill |
| skill.spawn.providers | 1 | skill |
| skill.catalog.protocols | 2 | skill.catalog |
| skill.catalog.profiles | 2 | skill.catalog |
| skill.catalog.resources | 2 | skill.catalog |
| skill.catalog.info | 2 | skill.catalog |
| skill.precedence.show | 1 | skill.precedence |
| skill.precedence.resolve | 1 | skill.precedence |
| provider.list | 0 | provider |
| provider.detect | 0 | provider |
| provider.inject.status | 0 | provider |
| provider.supports | 1 | provider |
| provider.hooks | 1 | provider |

### Mutate (11)

| Operation | Tier | Sub-domain |
|---|---|---|
| issue.add.bug | 0 | issue |
| issue.add.feature | 0 | issue |
| issue.add.help | 0 | issue |
| issue.generate.config | 2 | issue |
| skill.install | 0 | skill |
| skill.uninstall | 0 | skill |
| skill.enable | 0 | skill |
| skill.disable | 0 | skill |
| skill.configure | 0 | skill |
| skill.refresh | 0 | skill |
| provider.inject | 0 | provider |

---

## Decision Matrix

| Operation | Decision | Reason |
|---|---|---|
| **issue.diagnostics** | KEEP (tier 0) | Agents need system diagnostics for troubleshooting; zero params, cheap |
| **issue.templates** | MOVE TO PLUGIN | GitHub-specific; not every CLEO project uses GH issue templates; currently tier 2 |
| **issue.validate.labels** | MOVE TO PLUGIN | GitHub label validation; tier 2; plugin concern |
| **issue.add.bug** | MOVE TO PLUGIN | GitHub issue creation is external integration; not core CLEO |
| **issue.add.feature** | MOVE TO PLUGIN | Same as above |
| **issue.add.help** | MOVE TO PLUGIN | Same as above |
| **issue.generate.config** | REMOVE | Tier 2 stub; generates GitHub issue config YAML; plugin concern; no agent workflow needs it at runtime |
| **skill.list** | KEEP (tier 0) | Core skill discovery; commonly used by orchestrators |
| **skill.show** | KEEP (tier 0) | Single-skill detail; essential |
| **skill.find** | KEEP (tier 0) | Discovery by query; essential |
| **skill.dispatch** | KEEP (tier 0) | Dispatch routing lookup; needed by orchestrators pre-spawn |
| **skill.verify** | KEEP (tier 0) | Pre-spawn gate check; essential for safe skill loading |
| **skill.dependencies** | KEEP (tier 0) | Dependency resolution for install planning; essential |
| **skill.spawn.providers** | KEEP (tier 1) | Used during orchestration spawn to filter capable providers; targeted enough to stay |
| **skill.catalog.protocols** | PARAMETERIZE → skill.catalog | 4 ops all read from the same catalog object; merge to `skill.catalog { type: protocols\|profiles\|resources\|info }` |
| **skill.catalog.profiles** | PARAMETERIZE → skill.catalog | See above |
| **skill.catalog.resources** | PARAMETERIZE → skill.catalog | See above |
| **skill.catalog.info** | PARAMETERIZE → skill.catalog | See above — info summary becomes default when type omitted |
| **skill.precedence.show** | MERGE → skill.precedence | Merge show+resolve into one op with `action: show\|resolve` param; both are tier-1 specialist ops |
| **skill.precedence.resolve** | MERGE → skill.precedence | See above |
| **skill.install** | KEEP (tier 0) | Primary install verb; keep canonical |
| **skill.uninstall** | KEEP (tier 0) | Primary uninstall verb; keep canonical |
| **skill.enable** | REMOVE (alias) | Code falls through to install handler; is a pure alias; misleading name implies toggle vs. fresh install |
| **skill.disable** | REMOVE (alias) | Code falls through to uninstall handler; same concern |
| **skill.configure** | REMOVE (stub) | Implementation returns `{ configured: true, message: "Configuration is managed by CAAMP..." }` — it is a stub with no real behavior |
| **skill.refresh** | KEEP (tier 0) | Bulk update of tracked skills; real behavior, distinct from install |
| **provider.list** | KEEP (tier 0) | Core provider discovery |
| **provider.detect** | KEEP (tier 0) | Active provider detection; distinct from list |
| **provider.inject.status** | KEEP (tier 0) | Pre-inject status check; guards provider.inject |
| **provider.supports** | KEEP (tier 1) | Capability checking; used before spawn decisions |
| **provider.hooks** | KEEP (tier 1) | Hook event routing; needed by admin/tooling integrations |
| **provider.inject** | KEEP (tier 0) | Core CAAMP injection; essential for provider wiring |

---

## Projected Operation Count

| Category | Before | After | Delta |
|---|---|---|---|
| issue.* (moved to plugin) | 7 | 1 | -6 |
| skill.catalog.* (merged) | 4 | 1 | -3 |
| skill.precedence.* (merged) | 2 | 1 | -1 |
| skill.enable / skill.disable (removed aliases) | 2 | 0 | -2 |
| skill.configure (removed stub) | 1 | 0 | -1 |
| All other ops | 16 | 16 | 0 |
| **Total** | **32** | **19** | **-13** |

Target was ≤22. Projected: **19 ops**.

---

## Plugin Extraction Candidates

The entire `issue.*` sub-domain (minus `issue.diagnostics`) should move to a `ct-github-issues` plugin:

- `issue.templates` — reads `.github/ISSUE_TEMPLATE/`
- `issue.validate.labels` — validates against GitHub label set
- `issue.add.bug`, `issue.add.feature`, `issue.add.help` — creates GitHub issues via template
- `issue.generate.config` — generates `.github/ISSUE_TEMPLATE/config.yml`

**Rationale**: These operations couple CLEO to GitHub. Projects using GitLab, Linear, Jira, or no external tracker get dead surface area. The existing `src/core/issue/` module and `src/dispatch/engines/template-parser.ts` can move into the plugin. `issue.diagnostics` stays because it reflects CLEO internal state (install integrity, config validity), not GitHub state.

---

## skill.* Consolidation

### skill.catalog.* → skill.catalog (4 ops → 1)

Current 4 ops all delegate to the same `catalog` object from `@cleocode/caamp`. The only difference is which `catalog.*` method is called based on the op suffix.

Proposed single operation:
```
query tools skill.catalog { type: "protocols" | "profiles" | "resources" | "info" }
```

When `type` is omitted, default to `info` (summary). This is a pure parameterization — no behavior change, implementation reduction only.

### skill.precedence.* → skill.precedence (2 ops → 1)

Both ops are tier-1. They serve the same concern (precedence-aware skill routing). Merge:
```
query tools skill.precedence { action: "show" | "resolve", providerId?: string, scope?: "global" | "project" }
```

`action: "show"` returns the full precedence map; `action: "resolve"` requires `providerId`.

### skill.enable / skill.disable (remove)

The implementation in `tools.ts` uses a fall-through `case 'install': case 'enable':` — they are identical code paths. `skill.enable` is a confusing alias that implies idempotent toggling but actually performs a fresh install. Removing the aliases enforces the canonical `install`/`uninstall` verbs per VERB-STANDARDS.md.

### skill.configure (remove)

The implementation is a confirmed stub returning `{ configured: true, message: "Configuration is managed by CAAMP providers and lock file" }`. It has no side effects and no meaningful output. Until a real configuration concern emerges, this op should not exist in the registry.

---

## issue.* Analysis

| Op | Core vs. Plugin | Evidence |
|---|---|---|
| issue.diagnostics | Core | Tests CLEO install integrity (paths, schema, config) — not GitHub-specific |
| issue.templates | Plugin | Reads `.github/ISSUE_TEMPLATE/` — GitHub coupling |
| issue.validate.labels | Plugin | Validates against GitHub repo label set |
| issue.add.bug/feature/help | Plugin | Creates GitHub issues; external side effects |
| issue.generate.config | Plugin + Remove | Generates GitHub-specific YAML; tier 2; no agent runtime need |

The `issue.diagnostics` operation deserves scrutiny: it calls `collectDiagnostics()` from `src/core/issue/diagnostics.ts`. If diagnostics include CLEO-internal checks (not GitHub-specific), it stays. If it is primarily checking GitHub template validity, it should move to the plugin too. The function name and location suggest it covers CLEO installation health, warranting a keep decision for now.

---

## Admin Domain Candidates

None of the tools ops are strong candidates for migration to admin. The provider.* operations are tightly coupled to CAAMP and belong alongside skill.* operations. `issue.diagnostics` could be absorbed into `admin dash` or `check.*` but keeping it under tools preserves the sub-domain grouping.

---

## Implementation Notes

1. **skill.catalog parameterization**: Registry entry changes from 4 ops to 1. `querySkillCatalog` dispatcher method becomes an internal switch called from a single `skill.catalog` case. No behavior change.

2. **skill.precedence merge**: Single registry entry; `action` param dispatches to existing `getSkillsMapWithPrecedence` or `resolveSkillPathsForProvider`.

3. **Plugin boundary**: Create `packages/ct-skills/skills/ct-github-issues/` or equivalent. The `src/core/issue/` module and `template-parser.ts` engine move there. The `ToolsHandler.queryIssue` and `mutateIssue` methods shrink to the single `diagnostics` case.

4. **Alias removal**: Remove `skill.enable` and `skill.disable` from `getSupportedOperations()` and the registry. CLI command `cleo skill enable` should map to `skill.install`.

5. **Stub removal**: Remove `skill.configure` from registry and handler switch.

---

## References

- Related tasks: T5517 (epic), T5511 (prior analysis), T5555, T5556, T5557 (subtasks), T5609 (dependents)
- Source files: `src/dispatch/domains/tools.ts`, `src/dispatch/registry.ts`
- Standards: `docs/specs/VERB-STANDARDS.md`, `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
