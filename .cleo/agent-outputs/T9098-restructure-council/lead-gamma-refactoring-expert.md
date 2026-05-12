# LEAD GAMMA — Migration & Deprecation Strategy

**Specialty:** rename/migration order, deprecation aliasing, ct-cleo↔CLEO-INJECTION.md consolidation.
**Constraint anchor:** 13 active T9098 children at `pipelineStage=implementation` with locked acceptance — therefore aliasing-by-default, AC-rewrite never.
**Assumed Lead Alpha split:** `cleo nexus` → three scopes — `cleo graph` (project code-graph; today's `context|impact|query|hot-nodes|clusters|flows`), `cleo registry` (cross-project registry; today's `status|list|show|resolve|deps`), `cleo brain` (living-brain, already partly under that name). I do not endorse the names — Alpha owns naming. I design migration as if those three buckets exist.

---

## 1. Migration Waves

I tie waves to the existing CalVer `cleo release ship` flow. One wave = one minor (`v2026.6.X` series), bottom-of-stack first. No agent-visible CLI rename happens before contracts and SDK are split; no doc rename happens before CLI is stable. **Each wave is independently revertable** because shims keep the old surface alive.

### Wave 1 — Foundations, zero agent-visible change (target: `v2026.6.0` → `v2026.6.4`)

Ship the substrate. No alias yet — old commands still hit old code paths. Goal: make the *next* wave a small diff.

- Add new contract files alongside the old: `packages/contracts/src/operations/graph.ts`, `registry.ts`, `living-brain.ts`. Each re-exports the relevant subset from the existing `nexus.ts` with new operation strings (`graph.context`, `registry.status`, etc.). The old `nexus.ts` stays untouched and authoritative — duplication is intentional and lasts ≤2 waves.
- Add a `scope-map` SSoT (Beta's deliverable) — a single JSON/TS table mapping `nexus.<verb>` → `<scope>.<verb>`. Every later layer reads from this; no string literals in dispatch.
- Split `packages/core/src/nexus/` *internally* into three folders (`graph/`, `registry/`, `living-brain/`) with barrel re-exports preserving existing import paths. **No `packages/nexus/` rename yet.** Renaming a published package is the single most expensive operation in this whole plan; we defer until Wave 3.
- Add deprecation telemetry: every dispatch that hits a `nexus.*` op writes a one-line entry to `.cleo/audit/nexus-deprecation.jsonl` (op, caller, timestamp). This produces *evidence* for which aliases are still hot before we remove them.

**Pre-flight:** `pnpm biome ci .` · `pnpm run typecheck` · `pnpm run build` · `pnpm run test` · `cleo --version` post-install matches tag · grep audit log shows zero new `nexus.*` op-names leaking from new code.

### Wave 2 — CLI shims + alias surface (target: `v2026.6.5` → `v2026.6.9`)

Now agents see the new commands but old ones still work.

- Register new CLI verbs (`cleo graph context`, `cleo registry status`, etc.) as **first-class** commands routing to the new contract ops.
- Register old verbs (`cleo nexus context`, …) as **alias commands** that (a) emit `meta.deprecated = { since: "v2026.6.5", removeIn: "v2026.8.0", replacement: "graph.context" }` in their envelope, (b) print a single-line stderr deprecation notice gated by `CLEO_SUPPRESS_DEPRECATIONS=1`, (c) increment the audit counter from Wave 1.
- Update CLAUDE.md / AGENTS.md (project-local files only, not the global injection yet) to use the new verbs in examples. **CLEO-INJECTION.md is touched in Wave 4 — see §3.**
- Hooks shipped under `.claude/skills/gitnexus/` referencing `gitnexus_*` MCP tools are *not* affected — they call a different binary and live behind the `gitnexus://` MCP resource scheme. No collision risk.

**Pre-flight:** all of Wave 1, plus a snapshot test that pipes every old `cleo nexus *` command and confirms it still exits 0 with `meta.deprecated` set; install globally and run a smoke pass against `cleo graph context` and `cleo registry status`.

### Wave 3 — Package/DB rename (target: `v2026.7.0` — minor bump, not patch)

The expensive structural move. Single wave because partial moves create import graveyards.

- Rename `packages/nexus/` → `packages/registry/` (the cross-project surface — registry.db, project list, deps). Move the project-graph helpers that today live in `packages/core/src/nexus/` into a new `packages/graph/` package (or keep under `packages/core/src/graph/` if Alpha argues for SDK locality — both are fine to me).
- `nexus.db` filename stays. Renaming a SQLite file in a global location (`~/.local/share/cleo/`) breaks every existing install. Instead: open `nexus.db` and treat its tables as "registry tables" + "graph tables" — table names are internal, file name is forever. Document this in ADR-0XX as an irreversible-decision atom.
- Workspace-internal package imports update mechanically; `pnpm -r exec tsc -b` is the gate.
- Bump operation envelope version (additive only — `nexus.*` and `graph.*`/`registry.*` ops both valid; envelope schema version bumps to signal new ops are stable).

**Pre-flight:** Wave 2 + cross-package import audit (`pnpm exec depcruise` or grep) showing zero remaining `from "@cleocode/nexus"` outside the alias shim · global install + `cleo registry status` against an existing nexus.db succeeds without migration · `gitnexus_detect_changes` shows changes confined to expected packages.

### Wave 4 — Doc consolidation + ct-cleo collapse (target: `v2026.7.1` → `v2026.7.3`)

CLEO-INJECTION.md becomes the canonical agent doc; ct-cleo becomes a thin pointer. See §3.

### Wave 5 — Removal (target: `v2026.8.0`)

Drop `nexus.*` ops from contracts; drop `cleo nexus` CLI verbs; remove `packages/nexus` workspace stub. **Gated on telemetry** — if the audit log from Wave 1 still shows >0 calls/week from automation we don't control, push removal to `v2026.9.0`. No exceptions.

---

## 2. Aliasing Matrix

Lifetime measured in **release minors**, not calendar time. "Removal" = hard error with `E_DEPRECATED_REMOVED` envelope.

| Old surface | New surface | Alias type | Introduced | Removal target | Notes |
|---|---|---|---|---|---|
| `cleo nexus context <sym>` | `cleo graph context <sym>` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | hottest verb; telemetry-gated |
| `cleo nexus impact <sym>` | `cleo graph impact <sym>` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus query <q>` | `cleo graph query <q>` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus hot-nodes` | `cleo graph hot-nodes` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus clusters` | `cleo graph clusters` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus flows` | `cleo graph flows` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus detect-changes` | `cleo graph detect-changes` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus rename` | `cleo graph rename` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus status` | `cleo registry status` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus list` | `cleo registry list` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus show <p>` | `cleo registry show <p>` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus resolve` | `cleo registry resolve` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus deps` | `cleo registry deps` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus discover` | `cleo registry discover` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus search` | `cleo registry search` | CLI alias + envelope warn | v2026.6.5 | v2026.8.0 | |
| `cleo nexus living-brain *` | `cleo brain *` | CLI alias **only** (no envelope warn — `cleo brain` already exists) | v2026.6.5 | v2026.7.0 | shorter life because brand-collision; collapse fast |
| `nexus.<verb>` envelope op | `<scope>.<verb>` op | Dual-emit: envelope `meta.operation` includes both old + new for one wave | v2026.6.0 | v2026.7.0 | enables external consumers (LAFS validators) to migrate without flag day |
| `import { X } from "@cleocode/nexus"` | `from "@cleocode/registry"` or `/graph` | TS re-export shim package | v2026.7.0 | v2026.9.0 | longest lifetime — workspace consumers I don't control |
| `nexus.db` filename | unchanged | n/a — never renamed | — | never | irreversible decision recorded in ADR |

**Rule of thumb I am following:** one wave of dual-emit, two waves of alias, hard-removal in third minor. Anything longer-lived than that is a smell — the doc is wrong, or the rename was wrong.

---

## 3. ct-cleo / CLEO-INJECTION.md Consolidation

The current state is the worst possible: ct-cleo SKILL.md (490 lines) is **larger** than CLEO-INJECTION.md (310 lines) and they don't even reference each other. Drift is guaranteed.

### Proposal: chunk-loadable injection + thin-pointer skill

**Step 1 — Make CLEO-INJECTION.md self-chunking (Wave 4 / `v2026.7.1`).**
Add stable HTML-comment anchors around every section so callers can request *just one section*:

```
<!-- CLEO-INJECTION:section=session-start -->
## Session Start (cheapest-first)
…
<!-- /CLEO-INJECTION:section=session-start -->
```

Sections to anchor (already structurally present in the doc): `session-start`, `work-loop`, `triggers`, `task-discovery`, `session-commands`, `memory`, `orchestration`, `playbooks`, `documents`, `error-handling`, `pre-complete-gate`, `spawn-tiers`, `rules`, `memory-jit`. Owner directive ("ct-cleo should load from the injection") is satisfied by giving ct-cleo a *chunk loader*, not by inlining the whole file.

**Step 2 — Add `cleo briefing inject --section <name>` (Wave 4).**
Single-source: a CLI command that emits a section by anchor name from the canonical file. ct-cleo's SKILL.md becomes:

```
---
name: ct-cleo
description: CLEO task management protocol …
---

# ct-cleo

This skill is a thin pointer. The canonical CLEO protocol is CLEO-INJECTION.md.

## Just-enough orientation

For any of the topics below, run `cleo briefing inject --section <name>`:

| Topic | Section name | When to load |
|---|---|---|
| Starting a session | `session-start` | First action of every session |
| Work loop | `work-loop` | When picking next task |
| … | … | … |

## Skill-specific extensions

[Anything ct-cleo says that CLEO-INJECTION.md does not — TODAY THIS LIST IS EMPTY.]
```

If "skill-specific extensions" stays empty after audit (my prediction: it does), ct-cleo's SKILL.md collapses from 490 lines → ~50 lines. Drift surface deleted.

**Step 3 — Audit-and-merge pass (Wave 4, blocking gate).**
Before flipping ct-cleo to thin-pointer, diff ct-cleo SKILL.md against CLEO-INJECTION.md. Any content that exists in ct-cleo but not in CLEO-INJECTION must either (a) be merged back into CLEO-INJECTION as a new section, or (b) be deleted as stale. **No content survives in ct-cleo that isn't in the injection.** This is the only step that requires human judgment; everything else is mechanical.

**Step 4 — CI gate (Wave 4 + permanent).**
Add `pnpm run check:ct-cleo-thin` — a script that asserts ct-cleo SKILL.md contains no protocol content beyond the pointer table + skill-specific extensions section. Wired into the same gate as `cleo check canon`. Any future drift fails CI.

**Why a chunk-loader instead of a full inline?** Token efficiency. Loading the full 310-line injection into every subagent prompt is the *current* token waste — Lead Delta is solving the consumer side. Chunk-loading lets ct-cleo (and tier-2 spawn prompts) request `session-start + work-loop + pre-complete-gate` and skip orchestration/playbooks if the agent isn't an orchestrator.

---

## 4. Top 5 Unaliasable Breaking Changes (need owner authorization)

Aliases solve almost everything. These five do not.

| # | Change | Why it cannot be aliased | Mitigation |
|---|---|---|---|
| 1 | **`packages/nexus/` directory rename to `packages/registry/`** | Workspace package names are referenced by absolute path in `pnpm-lock.yaml`, by `tsconfig.json` `references`, by every CI workflow file, and by published `@cleocode/nexus` consumers (CAAMP, ct-skills, hooks). A symlink works on Linux but not on Windows CI runners. | Wave 3 is the rename; ship a TS re-export shim package `@cleocode/nexus` that just `export * from "@cleocode/registry"` for two minors. |
| 2 | **Envelope `meta.operation` removal of `nexus.*` op names** | External LAFS validators may pin to specific op-name strings; removing `nexus.context` is a wire-protocol break. | Dual-emit for one wave (Wave 1+2 envelope shows BOTH old and new), then hard-remove in Wave 5. Owner must authorize the wire break. |
| 3 | **`cleo nexus living-brain` → `cleo brain` collapse** | `cleo brain` already exists as a separate domain. The two namespaces overlapped historically. Merging them changes which DB serves the request — cannot be a pure alias because the destination handler differs. | Manual reconciliation in Wave 2; the alias is a *redirect with semantic delta*, not a passthrough. Owner must confirm the semantic merge is desired. |
| 4 | **`nexus.db` semantic split (registry tables vs graph tables in same file)** | If Alpha argues for *file-level* split, that's a one-way migration of a global SQLite DB at `~/.local/share/cleo/nexus.db` — cannot be aliased; old installs need a one-shot migrator. I recommend AGAINST file split. | Keep one file; treat split as logical/table-level only. If owner overrules me, ship a `cleo registry migrate` one-shot, gate Wave 3 on its evidence. |
| 5 | **Removal of `cleo nexus` CLI verb in Wave 5** | Hooks, scripts, and agent-prompts pinned to old SHA may still call it. No alias is forever. | Telemetry from Wave 1 (`.cleo/audit/nexus-deprecation.jsonl`) is the gate. If call rate >0 in trailing 7 days at Wave 5 cut-time, defer one minor. Owner authorizes the final removal commit by tagging the release. |

Items 1, 2, 5 require explicit owner sign-off because they emit **wire-format / on-disk-format / public-CLI** breaks that no script can repair. Items 3, 4 are design choices Alpha may overrule.

---

## 5. Pre-flight Checks (every wave)

Run **in order**. Any failure aborts the wave.

| Check | Command | Wave gate |
|---|---|---|
| Format / lint | `pnpm biome ci .` | all waves |
| Strict typecheck | `pnpm run typecheck` (NOT just `pnpm run build` — see global memory: typecheck IS the CI gate) | all waves |
| Build | `pnpm run build` | all waves |
| Tests, ZERO new failures | `pnpm run test` | all waves |
| Workspace import audit | `grep -rn "from \"@cleocode/nexus\"" packages/` should match expected count for the wave | W3, W5 |
| Old-CLI snapshot | scripted run of every `cleo nexus <verb>` showing exit 0 + `meta.deprecated` populated | W2, W3, W4 |
| New-CLI smoke | global install, then `cleo graph context X && cleo registry status && cleo brain digest --brief` | W2, W3 |
| Telemetry-burn-down | `wc -l .cleo/audit/nexus-deprecation.jsonl` trending toward zero across waves | W4, W5 |
| Doc canon | `cleo check canon` (existing T636 gate) + new `pnpm run check:ct-cleo-thin` | W4, W5 |
| Index freshness | `npx gitnexus analyze` post-rename, then `gitnexus_detect_changes` confirms expected scope only | W3 |
| Release evidence | `cleo verify <release-task> --gate testsPassed --evidence "tool:test"` etc. (ADR-051 ritual) | every release task |
| Install verify | `cleo --version` after `npm i -g @cleocode/cleo` matches the just-pushed tag | every release |
| CI green hold | `gh run list` shows last main run green before tagging next wave | every release |

---

## 6. Why this beats the obvious alternatives

**vs. "big-bang rename + codemod" (the seductive alternative).**
A single PR that renames everything is reviewable in isolation but blows up every external consumer simultaneously: hooks, ct-skills, CAAMP injection, agent prompts saved in `.cleo/agent-outputs/`, and any pinned-SHA install. Telemetry-gated phased aliasing **costs more wall-time but zero downtime for the agent fleet**, which is the actual scarce resource.

**vs. "alias forever" (the conservative alternative).**
Permanent aliases are technical debt that compounds with every doc generation pass. The Wave 5 hard-removal, gated on telemetry, is what makes this an actual *refactor* and not a *renaming*.

**vs. "do CLEO-INJECTION.md first, then code" (peer Delta might prefer).**
Doc-first is wrong here because the doc is the *output* of structural decisions Lead Alpha is making. If we update CLEO-INJECTION.md before contracts split, we either ship docs that disagree with code (worse than today) or freeze Alpha's options. Wave 4 doc-flip *after* Wave 3 package-rename is the correct order.

**vs. "split `nexus.db` into two files" (the clean-architecture purist alternative).**
File-level DB split looks tidy on a whiteboard and is a 6-month migration in practice — global state at `~/.local/share/cleo/nexus.db` exists on every install, and the migrator must handle WAL sidecars, locked DBs, and partial-failure recovery. **Logical split, single file, ADR-recorded as irreversible** — this is the engineering call.

**vs. "keep ct-cleo and CLEO-INJECTION as parallel docs but cross-link them" (the diplomatic alternative).**
This is what created today's drift. A pointer that only humans enforce will drift; a CI gate (`check:ct-cleo-thin`) is the only durable solution. Diplomatic options that don't have a machine-checkable invariant are how we got here.

---

## 7. One concrete failure mode of THIS proposal

**The deprecation telemetry log creates a cleo-shaped honeypot.**

Wave 1 ships `.cleo/audit/nexus-deprecation.jsonl`. Every `cleo nexus *` invocation appends a row. On a busy orchestrator session this is fine — but when an agent fan-out spawns 30 worker subagents each running `cleo nexus context X` ten times, that's 300 audit writes to the same JSONL inside 60 seconds, on top of an already-active SQLite WAL. We have prior evidence of WAL-sidecar contention on `.cleo/tasks.db` (see global memory entry: "Runtime Data Safety ADR-013 §9"). A second high-frequency append-only file in the same directory increases that contention.

**Mitigation if it bites:** sample at 1-in-N, or move the log to `~/.local/state/cleo/nexus-deprecation/<date>.jsonl` outside the project tree so it can't interact with project DB locks. **Detection:** Wave 2 should include a stress test that fan-spawns 30 dummy `cleo nexus context` workers and measures p99 latency — if >2x baseline, sample-down before Wave 3.

If this failure mode materializes, the right move is to keep the alias strategy and downgrade the telemetry, not to abandon the deprecation gate. The telemetry is instrumentation, not load-bearing — Wave 5 removal can fall back to "owner authorizes hard removal at calendar date" if the log is unreliable.

---

**Summary one-liner:** five waves across `v2026.6.0 → v2026.8.0`, contracts before SDK before CLI before docs before removal, alias matrix capped at 2-minor lifetime with telemetry gate, ct-cleo collapses to a chunk-loader pointer guarded by a `check:ct-cleo-thin` CI invariant, five named breaking changes flagged for explicit owner authorization, one self-acknowledged failure mode in the audit-log honeypot.
