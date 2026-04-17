# T916 — Orchestrate Spawn Prompt Rebuild

**Epic**: T882 (filed here — the original prompt used T916–T922 as placeholder IDs; actual IDs filed were T882–T888)
**Children**: T883 · T884 · T885 · T886 · T887 · T888
**Ship version**: v2026.4.85
**Session**: ses_20260417192937_649170
**Author**: cleo-prime
**Status**: complete

---

## Executive summary

`cleo orchestrate spawn <taskId>` now returns a fully-resolved, self-contained
prompt that is 100% copy-pastable into any LLM runtime (Claude, GPT-4, Gemini,
open-source). The previous output was a 20-line skeleton that forced
orchestrators to hand-roll prompts because critical context was missing.

- **Before**: ~600-char skeleton (task metadata + 5-line boilerplate).
- **After**: 5.8k (tier 0) · 13.2k (tier 1) · 29.4k (tier 2) — all resolved,
  all required sections present.

The fix is systemic — no `--legacy` flag, no backward-compat shim. `prepareSpawn`
delegates to a single canonical builder; the two parallel spawn systems are now
clearly separated by responsibility.

---

## Before / after prompt examples

### Before (v2026.4.84 and earlier)

```
## Task: T883
**Title**: Consolidate prepareSpawn + prepareSpawnContext into one canonical builder
**Description**: Current state: …
**Protocol**: implementation
**Epic**: T882
**Date**: 2026-04-17
### Instructions
1. Start task: `cleo start T883`
2. Execute the implementation protocol
3. Write output file
4. Append manifest entry to MANIFEST.jsonl
5. Complete: `cleo complete T883`
### Acceptance Criteria
- AC1: …
```

**Problems**:
1. No file-path references — subagent had to guess at absolute paths.
2. No session linkage — subagent mutations fell outside the orchestrator session.
3. No evidence-gate commands — subagent closed tasks without ADR-051 evidence.
4. No stage-specific guidance — implementation vs research vs release all got the same 5-line boilerplate.
5. No return-format contract — subagent chose its own reply format, breaking the orchestrator's manifest-driven handoff.
6. No CLEO-INJECTION embed — subagent had to re-resolve `@~/.cleo/templates/CLEO-INJECTION.md`, which fails on many harnesses.

### After (v2026.4.85, tier 1 DEFAULT)

```
# CLEO Subagent Spawn — T883

> **Task**: T883 · **Protocol**: implementation · **Tier**: 1 · **Generated**: 2026-04-17T19:52:00Z

You are a CLEO subagent. This prompt is fully self-contained. You do not need
to re-resolve any protocol content — everything required to execute, verify,
and close this task is embedded below.

Return ONLY the one-line completion message specified in the
**Return Format Contract** section. Do NOT summarize work in the response body.

## Task Identity
- ID: `T883`
- Title: Consolidate prepareSpawn + prepareSpawnContext into one canonical builder
- Description: …
- Type: task · Size: medium · Priority: high · Status: pending
- Parent Epic: `T882`
- Pipeline Stage: research
- Labels: …
- Depends On: T882

### Acceptance Criteria
- AC1: single exported buildSpawnPrompt() function …
- AC2: prepareSpawn in index.ts delegates to it
- …

## File Paths (absolute — do not guess)
| Purpose | Absolute Path |
|---------|---------------|
| Agent output directory | `/mnt/projects/cleocode/.cleo/agent-outputs` |
| Manifest (JSONL) | `/mnt/projects/cleocode/.cleo/agent-outputs/MANIFEST.jsonl` |
| RCASD workspace (T883) | `/mnt/projects/cleocode/.cleo/rcasd/T883` |
| Test-run captures | `/mnt/projects/cleocode/.cleo/test-runs` |

## Session Linkage
- Orchestrator Session: `ses_20260417192937_649170`
- Log every mutation (task start/complete, memory observe, verify) against THIS session …

## Stage-Specific Guidance — Implementation (IVTR)
**Objective**: Write code that satisfies every acceptance criterion.
Deliverables:
- Source changes under `packages/<pkg>/src/`
- Tests under `packages/<pkg>/src/**/__tests__/*.test.ts` (vitest)
- TSDoc comments on every exported function/class/type
…
Quality Bar:
- NEVER `any` or `unknown` shortcuts …
- Import types from `@cleocode/contracts` …

## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)
Every gate write MUST carry programmatic evidence. …
### Step 1 — capture evidence per gate
```bash
cleo verify T883 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"
cleo verify T883 --gate testsPassed --evidence "tool:pnpm-test"
cleo verify T883 --gate qaPassed --evidence "tool:biome;tool:tsc"
…
```
### Step 2 — then complete
```bash
cleo memory observe "<concise learning>" --title "<title>"
cleo complete T883
```

## Quality Gates (run before every `cleo complete`)
```bash
pnpm biome ci .        # full repo, strict — same as CI
pnpm run build         # full dep graph build
pnpm run test          # zero new failures vs main
git diff --stat HEAD   # verify the diff matches the story
```

## Return Format Contract (MANDATORY)
On completion, return EXACTLY ONE of these strings and nothing else:
```
Implementation complete. See MANIFEST.jsonl for summary.
Implementation partial. See MANIFEST.jsonl for details.
Implementation blocked. See MANIFEST.jsonl for blocker details.
```

## CLEO Protocol (embedded — tier 1)
<details><summary>Click to expand full protocol</summary>

# CLEO Protocol

Version: 2.6.0 | CLI-only dispatch | `cleo <command> [args]`

## Session Start (cheapest-first)
1. `cleo session status`
2. `cleo dash`
…[full CLEO-INJECTION.md embedded verbatim]…

</details>
```

Tier 2 additionally appends `ct-cleo` + `ct-orchestrator` skill excerpts (6k
chars each, truncated at a newline boundary) and the SUBAGENT-PROTOCOL-BLOCK
from the ct-orchestrator skill references.

---

## Consolidation diff — which of the two systems stayed

Both modules stayed, but their roles are now unambiguous:

| Module | Role | Changed? |
|--------|------|----------|
| `packages/core/src/orchestration/spawn-prompt.ts` | **Canonical spawn prompt builder** — assembles the self-contained prompt. | New file |
| `packages/core/src/orchestration/index.ts` · `prepareSpawn` | Adapter that loads the task, auto-dispatches protocol, and calls `buildSpawnPrompt`. | Delegates to new module; inlined `buildSpawnPrompt` + `findUnresolvedTokens` removed. |
| `packages/core/src/skills/dispatch.ts` · `prepareSpawnContext` | **Skill-auto-dispatch helper** — selects WHICH skill fits a task (labels/catalog/keyword). Not a prompt builder. | Documented; kept as-is. |
| `packages/core/src/skills/dispatch.ts` · `prepareSpawnMulti` | Multi-skill progressive disclosure composer (used by Pi orchestrator Tier-0). | Kept as-is. |

Deleted:
- Inlined `buildSpawnPrompt(task, protocol): string` helper from `index.ts` (was 29 lines of skeleton).
- Inlined `findUnresolvedTokens(prompt): string[]` helper from `index.ts`.

Delegated:
- `prepareSpawn(taskId, cwd?, accessor?, options?)` — new options bag takes `tier` + `sessionId`.
- `orchestrateSpawn(taskId, protocolType?, projectRoot?, tier?)` threads `getActiveSession()` + `tier` through to the builder.
- `orchestrateSpawnExecute(...)` does the same for adapter-registry executions.

---

## Tier matrix (what each tier includes)

| Section | Tier 0 | Tier 1 (default) | Tier 2 |
|---------|:------:|:----------------:|:------:|
| Header | ✓ | ✓ | ✓ |
| Task Identity (id, title, description, epic, labels, deps, acceptance) | ✓ | ✓ | ✓ |
| File Paths (absolute output dir, manifest, rcasd, test-runs) | ✓ | ✓ | ✓ |
| Session Linkage (orchestrator session id) | ✓ | ✓ | ✓ |
| Stage-Specific Guidance (per RCASD-IVTR+C phase) | ✓ | ✓ | ✓ |
| Evidence-Based Gate Ritual (ADR-051 / T832) | ✓ | ✓ | ✓ |
| Quality Gates (biome ci · build · test) | ✓ | ✓ | ✓ |
| Return Format Contract (three exact reply strings) | ✓ | ✓ | ✓ |
| CLEO Protocol pointer (1-liner → `~/.cleo/templates/CLEO-INJECTION.md`) | ✓ | — | — |
| CLEO-INJECTION.md embed (full protocol verbatim) | — | ✓ | ✓ |
| ct-cleo skill excerpt (6k chars) | — | — | ✓ |
| ct-orchestrator skill excerpt (6k chars) | — | — | ✓ |
| SUBAGENT-PROTOCOL-BLOCK | — | — | ✓ |
| Anti-Patterns reference | — | — | ✓ |
| **Typical length** | **5.8k chars** | **13.2k chars** | **29.4k chars** |

CLI: `cleo orchestrate spawn T### --tier {0|1|2}`. Undefined = tier 1.

---

## Protocol phase matrix

Ten RCASD-IVTR+C phases get distinct stage-specific guidance blocks:

| Phase | Guidance focus |
|-------|----------------|
| `research` | Gather info + cite sources + write to `.cleo/rcasd/T###/research/` |
| `consensus` | Vote (APPROVE/REJECT/ABSTAIN) + risk register + alternatives |
| `architecture_decision` | Write ADR at `.cleo/adrs/ADR-NNN-<slug>.md` |
| `specification` | RFC-2119 spec at `.cleo/rcasd/T###/specification/` |
| `decomposition` | Atomic child tasks + pipe-separated acceptance + deps wired |
| `implementation` | Code + tests + TSDoc; explicit no-any/no-unknown rule |
| `validation` | Verify vs spec + ADR + contracts; surface blocks |
| `testing` | vitest JSON captured; `tool:pnpm-test` evidence atom |
| `release` | CalVer bump + CHANGELOG + tag + CI-GREEN-before-publish |
| `contribution` | Follow-ups tracked via `needs_followup` + cross-agent credit |

All phases use the same outer prompt structure; only the "Stage-Specific
Guidance" section varies. Unknown protocols fall back to `implementation`
guidance.

---

## `cleo-subagent/AGENT.md` diff

| Change | Before | After |
|--------|--------|-------|
| Version | `1.3.0` | `2.0.0` (breaking) |
| Header note | none | "spawn prompts are fully self-contained … MUST NOT re-resolve" |
| New section | — | "Spawn Prompt Contract (T882 · v2.0.0)" — documents the 8 required sections + MUST/MUST-NOT rules |
| Escalation section | "cleo admin help … skills injected by orchestrator" | "prompt already contains protocol content … only escalate when prompt explicitly defers" |
| Anti-patterns table | 8 rows | 10 rows — added "re-resolving task/protocol context" + "fabricating absolute paths" |

No breaking change to the immutable-constraints table (BASE-001 … BASE-008) —
the protocol contract subagents MUST honor is unchanged; only the assumption
that subagents re-resolve content is rewritten.

---

## Test coverage

New test file: `packages/core/src/orchestration/__tests__/spawn-prompt.test.ts` (52 tests).

| Group | Tests |
|-------|-------|
| Core contract (tier defaults + header + section markers) | 6 |
| Protocol phase matrix (10 phases × 3 tiers) | 30 |
| Stage-specific guidance content | 6 |
| Return format contract per phase | 2 |
| Session linkage | 2 |
| File path resolution | 1 |
| `resolvePromptTokens` | 3 |
| Token resolution end-to-end | 2 |

Existing test files updated:

| File | Change |
|------|--------|
| `packages/core/src/__tests__/injection-mvi-tiers.test.ts` | v2.5.0 → v2.6.0 assertions; line cap 200 → 250 (added Spawn Prompt Contents section); **2 new tests** verifying the new section lists all 7 required spawn sections. Total: 19 → 21 tests. |
| `packages/core/src/orchestration/__tests__/orchestration.test.ts` | Unchanged. Passes — `prompt.toContain('T003')` still holds with longer prompt. |
| `packages/core/src/orchestration/__tests__/autonomous-spec.test.ts` | Unchanged. Passes — token resolution still reports zero unresolved tokens; prompt length still under 40k chars. |

Full-repo test run: **8664 passed · 10 skipped · 32 todo · 0 failed · 0 regressions.**

---

## Files changed

```
 CHANGELOG.md                                                                |  75 +++++
 package.json                                                                 |   2 +-
 packages/adapters/package.json                                               |   2 +-
 packages/agents/cleo-subagent/AGENT.md                                       |  71 ++++-
 packages/agents/package.json                                                 |   2 +-
 packages/caamp/package.json                                                  |   2 +-
 packages/cant/package.json                                                   |   2 +-
 packages/cleo-os/package.json                                                |   2 +-
 packages/cleo/package.json                                                   |   2 +-
 packages/cleo/src/dispatch/engines/orchestrate-engine.ts                     |  42 ++-
 packages/contracts/package.json                                              |   2 +-
 packages/core/package.json                                                   |   2 +-
 packages/core/src/__tests__/injection-mvi-tiers.test.ts                      |  42 ++-
 packages/core/src/orchestration/__tests__/spawn-prompt.test.ts               | 273 ++++++++++++++++++   (NEW)
 packages/core/src/orchestration/index.ts                                     |  90 ++-----
 packages/core/src/orchestration/spawn-prompt.ts                              | 618 +++++++++++++++++++++++++++++++++++++++++   (NEW)
 packages/core/templates/CLEO-INJECTION.md                                    |  31 ++-
 packages/lafs/package.json                                                   |   2 +-
 packages/nexus/package.json                                                  |   2 +-
 packages/runtime/package.json                                                |   2 +-
 packages/skills/package.json                                                 |   2 +-
 packages/studio/package.json                                                 |   2 +-
```

---

## Quality gates (this session)

```
pnpm biome ci .         → Checked 1447 files. No fixes. (1 pre-existing symlink warning)
pnpm run build          → all packages green, `cleo` + `cleoos` binaries built
pnpm run test           → 8664 passed | 10 skipped | 32 todo (0 failed)
```

End-to-end smoke test (`cleo orchestrate spawn T883 --tier {0|1|2}`) verified
via `node packages/cleo/dist/cli/index.js`:

```
Tier 0 length: 5810 chars   — pointer to CLEO-INJECTION.md (no embed)
Tier 1 length: 13226 chars  — full CLEO-INJECTION.md embedded
Tier 2 length: 29428 chars  — tier 1 + ct-cleo + ct-orchestrator + SUBAGENT-PROTOCOL-BLOCK + anti-patterns
```

All required section markers present in every tier; session id threaded;
zero unresolved tokens in any combination.

---

## Rationale / design notes

1. **Two-pass token resolution.** Authored sections (where `{{TOKEN}}` placeholders
   the builder wants resolved) render first and token-substitute. Embedded
   content (CLEO-INJECTION.md + skill excerpts) appends verbatim so that
   documentation-style `{{TOKEN}}` examples in those files do not trigger false
   `unresolved-tokens` validation errors.

2. **Per-module path resolver.** The spawn-prompt module lives at
   `packages/core/src/orchestration/spawn-prompt.ts` (depth 2), so the
   `getPackageRoot()` helper in `scaffold.ts` (designed for depth 1) would
   mis-resolve when compiled. Worse, when `@cleocode/cleo` bundles this
   module into `packages/cleo/dist/cli/index.js`, `import.meta.url` points
   at the bundle directory. The new `locateCleoInjectionTemplate()` walks up
   looking for `templates/CLEO-INJECTION.md` AND for
   `node_modules/@cleocode/core/templates/CLEO-INJECTION.md`, covering source,
   compiled, and bundled layouts. Degrades gracefully to `null` when the
   file cannot be found (warning appears in the embed block).

3. **Memoization cache.** `CACHE` holds template + skill content after first
   read so tier 2 prompts don't re-hit the filesystem per call. Exported
   `resetSpawnPromptCache()` for tests.

4. **Session threading is best-effort.** `orchestrateSpawn` catches errors
   from `getActiveSession()` — a missing or corrupt session DB does not block
   spawn generation; instead the prompt surfaces a clear "no active session"
   notice telling the subagent to start one.

5. **Tier 0 vs Tier 1 size.** Tier 0 omits the CLEO-INJECTION embed and uses
   a 3-line pointer instead, shaving ~7k chars. Useful for cheap
   single-shot workers (e.g. a grep-and-report job) where the full protocol
   is overkill.

---

## Return

Lead+impl+ship complete. See MANIFEST.jsonl for summary.
