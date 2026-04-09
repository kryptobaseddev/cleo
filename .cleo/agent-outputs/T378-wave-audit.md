# T378 Wave AUDIT — ULTRAPLAN Waves 0, 1, 2, 4, 5 Shipped State

**Audited**: 2026-04-09T19:10:21Z
**Umbrella epic**: T377 (CleoOS Agentic Execution Layer)
**Audit epic**: T378
**Subtasks covered**: T385 (W0), T386 (W1), T387 (W2), T388 (W4), T389 (W5)

---

## Summary

| Wave | Title | Status | Gaps |
|------|-------|--------|------|
| W0 | CANT Grammar Additions | SHIPPED | 3 minor |
| W1 | Render Pipeline | PARTIAL | 4 critical |
| W2 | Bridge MVP | PARTIAL | 5 significant |
| W4 | Lifecycle + Protocol Lift | PARTIAL | 5 critical |
| W5 | JIT Agent Composer | PARTIAL | 5 critical |

**1 shipped, 4 partial, 0 not-started, 22 total gaps**

No empirical gate (ULTRAPLAN §17) is currently runnable for W1, W2, W4, or W5.

---

## Wave 0 — CANT Grammar Additions (T385) — SHIPPED

**Key evidence**:
- `crates/cant-core/src/dsl/ast.rs:28-72` — all 6 new `DocumentKind` variants present
- `crates/cant-core/src/dsl/team.rs` — `parse_team_block()` fully implemented
- `crates/cant-core/src/dsl/tool.rs` — `parse_tool_block()` fully implemented
- `crates/cant-core/src/dsl/agent.rs:78-171` — `context_sources:` and `mental_model:` sub-blocks parsed
- `crates/cant-core/src/validate/hierarchy.rs:8-351` — all 8 lint rules (TEAM-001/002/003, TIER-001/002, JIT-001, MM-001/002) implemented with tests

**Minor gaps**:
- `context_sources` / `mental_model` parsed as flat property lists, not richly-typed structs
- `role` and `tier` not first-class typed fields on `AgentDef`
- `permissions.files: write[glob]` extension not verified

**Gate**: `cargo test -p cant-core` is runnable and covers all 8 lint rules.

---

## Wave 1 — Render Pipeline (T386) — PARTIAL

**Key evidence**:
- `crates/cant-core/src/render/mod.rs:76` — `render_document()` dispatches Protocol kind
- `crates/cant-core/tests/render_round_trip.rs` — byte-identical round-trip test exists
- `crates/cant-core/tests/fixtures/render-round-trip/` — 2 fixtures present

**Critical gaps**:
- **No `cant render --kind=protocol --to=md` CLI verb** — only parse/validate/list/execute/migrate exist
- Only 1 protocol fixture; ULTRAPLAN gate requires all **12** protocol files to round-trip
- `render_team`, `render_tool`, `render_lifecycle`, `render_model_routing`, `render_mental_model` are **all stubs** returning empty strings
- No CI step verifying rendered output against committed files

**Gate runnable**: NO — CLI verb missing, 11/12 fixtures missing.

---

## Wave 2 — Bridge MVP (T387) — PARTIAL

**Key evidence**:
- `packages/cleo/templates/cleoos-hub/pi-extensions/cleo-cant-bridge.ts` — 180 LOC bridge with `compileBundle()`, `before_agent_start` hook, append-only injection (L6 compliant)
- `packages/cleo-os/bin/postinstall.js:84-87` — deploys bridge to XDG extensions
- `packages/cleo-os/src/cli.ts:30` — cli.ts loads bridge at runtime

**Significant gaps**:
- **Bridge .ts source is in wrong package**: lives at `packages/cleo/templates/cleoos-hub/pi-extensions/` not `packages/cleo-os/extensions/` as ULTRAPLAN Layer 3 specifies
- `packages/cleo-os/extensions/` contains **only** `cleo-chatroom.ts`; no bridge source there
- The postinstall copies `cleo-cant-bridge.js` (compiled) from `cleo-os/extensions/` but that file does not exist as .ts source — build chain for this is unclear
- No empirical test: 5 hand-authored prompts confirming CleoOS persona + AGENTS.md both present

**Gate runnable**: NO — wrong source location, no hand-authored prompt fixtures.

---

## Wave 4 — Lifecycle + Protocol Lift (T388) — PARTIAL

**Key evidence**:
- `packages/core/src/validation/protocols/cant/` — all **12** protocol `.cant` files present
- `packages/core/src/validation/protocols/protocols-markdown/` — all 12 corresponding `.md` files present
- `packages/core/src/lifecycle/cant/lifecycle-rcasd.cant` — lifecycle CANT file exists (`kind: lifecycle`)
- `crates/cant-core/tests/protocol_lift.rs` — 12 individual parse tests + aggregate existence test pass

**Critical gaps**:
- `stages.ts` does **not** import from `lifecycle-rcasd.cant` — the .cant file is a comment-style description, not a machine-readable SSoT
- No codegen script: `lifecycle-rcasd.cant` does not generate `stages.ts` constants
- No CI diff gate: `.github/workflows/ci.yml` has no step referencing `cant render` or protocol diff
- `render_protocol()` is a stub — 12 protocol .cant files cannot render byte-identical to their .md counterparts

**Gate runnable**: NO — render pipeline stub blocks the diff gate; no codegen for stages.ts.

---

## Wave 5 — JIT Agent Composer (T389) — PARTIAL

**Key evidence**:
- `packages/cant/src/composer.ts:1-311` — full `composeSpawnPayload()` with tier caps, escalation, context_sources, mental model injection
- `packages/cant/src/composer.ts:18-23` — `TIER_CAPS` matches ULTRAPLAN §9.4 exactly
- `packages/cant/tests/composer.test.ts` — 393 lines of tests for escalation, budget, injection

**Critical gaps**:
- **Not wired into any spawn path** — `composeSpawnPayload` is not imported by `orchestrate-engine.ts`, `prepareSpawn`, or any dispatch path
- `ContextProvider` is an interface with no concrete implementation against `brain.db`; `packages/core/src/brain/` does not exist
- Empirical gate (2nd spawn injects ≥1 pattern from 1st) has no test — mock providers only
- `packages/cleo-os/extensions/` (the bridge) does not call `composeSpawnPayload`
- Mental model storage (`brain.db:agents/<name>/model`) has no backing implementation

**Gate runnable**: NO — composer is an island library; no real BRAIN round-trip exists.

---

## Recommended Action Order

1. **W2** — Move bridge .ts source into `packages/cleo-os/extensions/`; fix build chain; W3 launcher depends on correct location
2. **W1** — Add `cant render` CLI verb; add 11 remaining protocol round-trip fixtures; unblock W4 diff gate
3. **W4** — Wire render pipeline; add CI diff gate; create codegen script `lifecycle-rcasd.cant → stages.ts`
4. **W5** — Wire `composeSpawnPayload` into `orchestrate-engine.ts prepareSpawn`; implement concrete `ContextProvider` against `brain.db`; add empirical 2nd-spawn test
5. **W0** — Typed `role`/`tier` fields on `AgentDef`; verify `permissions.files write[glob]` extension

---

*Read-only audit. No source files modified. All paths relative to `/mnt/projects/cleocode/`.*
