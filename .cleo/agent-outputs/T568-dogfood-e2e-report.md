# T568 Dogfood E2E Verification Report

**Date**: 2026-04-14  
**Task**: T568 — Full end-to-end agent spawning, identity, CONDUIT messaging verification  
**Status**: Partial — 4 PASS, 2 FAIL, 1 PARTIAL

---

## Test 1: Identity Injection Paths — PASS

**1a. Project-level identity file**
- Path: `/mnt/projects/cleocode/.cleo/CLEOOS-IDENTITY.md`
- Exists: YES (2389 bytes, executable)
- Systems: 6 confirmed — TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT

**1b. Global XDG identity file**
- Path: `~/.local/share/cleo/CLEOOS-IDENTITY.md`
- Exists: YES (2389 bytes, same content)
- Systems: 6 confirmed — identical to project-level file

**1c. `cant-context.ts` reads both paths**
- `readIdentityFile()` at line 324 of `packages/adapters/src/cant-context.ts`
- Search order: `<projectDir>/.cleo/CLEOOS-IDENTITY.md` → `$XDG_DATA_HOME/cleo/CLEOOS-IDENTITY.md`
- Code confirmed at lines 315–351

**1d. `cleo-cant-bridge.ts` reads identity from disk**
- Path: `packages/cleo-os/extensions/cleo-cant-bridge.ts`
- Lines 862–916: reads `CLEOOS-IDENTITY.md` in `before_agent_start` hook
- Search order matches `cant-context.ts` — project first, global fallback
- Identity injected as block into agent system prompt

**Verdict: PASS** — Both paths exist with correct 6-system content. Both code paths confirmed reading from disk.

---

## Test 2: CANT Compilation — PASS

**2a. `.cleo/cant/` contents**
- `team.cant` present
- `agents/` directory: `cleo-orchestrator.cant`, `code-worker.cant`, `dev-lead.cant`, `docs-worker.cant`

**2b. `bundle.ts` exports `compileBundle`**
- `packages/cant/src/bundle.ts` line 465: `export async function compileBundle(filePaths: string[]): Promise<CompiledBundle>`
- Export confirmed; TSDoc present; `CompiledBundle`, `AgentEntry`, `TeamEntry`, `BundleDiagnostic` interfaces all exported

**2c. Global starter bundle**
- `~/.local/share/cleo/cant/starter/`: `team.cant` + `agents/` with same 4 agent files as project-level
- `~/.local/share/cleo/cant/model-routing.cant` also present

**Verdict: PASS** — CANT files deployed at both project and global levels; `compileBundle` is a real export.

---

## Test 3: CONDUIT Send/Peek/Status — FAIL

All three CONDUIT commands fail with a missing module error:

```
Cannot find module '.../packages/cleo/node_modules/@cleocode/core/dist/conduit.js'
codeName: E_CONDUIT
```

**Root cause**: The `@cleocode/core` package exports `conduit/index.js` (a directory), but the CLI import resolves to `conduit.js` (a flat file). The package's `exports` map uses `./*` wildcard (`./dist/*.js`), which resolves `conduit` to `dist/conduit.js`, not `dist/conduit/index.js`. The actual file is `dist/conduit/index.js`.

- `cleo orchestrate conduit-send --to test-agent --message "dogfood test from T568"` → FAIL (E_CONDUIT)
- `cleo orchestrate conduit-peek` → FAIL (E_CONDUIT)
- `cleo orchestrate conduit-status` → FAIL (E_CONDUIT)

**Verdict: FAIL** — CONDUIT is completely non-functional. All three operations crash with the same missing module error. This is a build/packaging bug: the conduit directory export is not accessible via the published dist path.

---

## Test 4: Orchestrate Spawn — PARTIAL

**4a. Command surface exists**
`cleo orchestrate spawn` is a real command. The subcommand list also includes `conduit-send`, `conduit-peek`, `conduit-status`, `fanout`, `classify`, `handoff`, `spawn-execute`.

**4b. Spawn on T568** — blocked by validation (not a spawn bug):
```json
{"code":"V_MISSING_DESC","message":"Task description is missing","severity":"error"}
```
T568 has no description field populated, which is a pre-condition for spawn.

**4c. Spawn on T564** — blocked by validation (task already completed):
```json
{"code":"V_ALREADY_DONE","message":"Task is already completed","severity":"error"}
```

**4d. buildPrompt correctness**: Could not test a successful spawn invocation due to missing descriptions, but `orchestrate spawn --help` shows the machinery is present. Validation gates work correctly.

**Verdict: PARTIAL** — Spawn CLI and validation gates work. Cannot confirm identity chain through a live spawn without a task that has a description. Spawn on tasks with descriptions will be needed to fully verify prompt injection.

---

## Test 5: Agent Registry — PASS

```
cleo agent list → 2 agents registered:
  - cleo-prime-dev (CLEO Prime Dev, active, transport: http)
  - cleo-prime (CLEO Prime Orchestrator, active, transport: http)

cleo agent status → both active, both attached to project
```

Available agent subcommands include: `send`, `spawn`, `work`, `poll`, `watch`, `assign`, `wake` — full messaging lifecycle present.

**Verdict: PASS** — Registry functional, 2 agents present with correct metadata.

---

## Test 6: Skill Loading — PASS

`cleo skills list` returns 21 skills. Critical skills confirmed present:

| Skill | Found |
|-------|-------|
| `ct-orchestrator` | YES |
| `ct-cleo` | YES |
| `ct-task-executor` | YES |
| `ct-ivt-looper` | YES |
| `ct-epic-architect` | YES |
| `ct-validator` | YES |
| `ct-research-agent` | YES |

All skills have valid metadata with `description`, `name`, and `compatibility` fields. `ct-orchestrator` description references "multi-agent workflow", "spawn subagents", and "ORC-001 through ORC-009 constraints". Architecture references in skill descriptions are consistent with the 6-system model.

**Verdict: PASS** — 21 skills loaded, all critical skills present.

---

## Summary

| Test | Result | Notes |
|------|--------|-------|
| T1: Identity injection paths | PASS | Both files exist, both code paths verified |
| T2: CANT compilation | PASS | 4 agent .cant files deployed, compileBundle exported |
| T3: CONDUIT messaging | FAIL | Missing module: `dist/conduit.js` vs `dist/conduit/index.js` |
| T4: Orchestrate spawn | PARTIAL | CLI works, validation gates work, no live spawn tested |
| T5: Agent registry | PASS | 2 agents registered, messaging subcommands present |
| T6: Skill loading | PASS | 21 skills, all critical skills confirmed |

## Critical Issue

**CONDUIT is broken** (E_CONDUIT). The packaging issue (`conduit.js` vs `conduit/index.js`) blocks all agent-to-agent messaging. This is the same root cause documented in memory-bridge.md: "BROKEN: Conduit (0 messages)". The bug is in how `@cleocode/core`'s conduit directory module is referenced from the CLI's built dist.

Fix path: the import in the CLI source should reference `@cleocode/core/conduit/index.js` or the `@cleocode/core` package.json should add a dedicated `"./conduit"` export entry pointing to `./dist/conduit/index.js`.
