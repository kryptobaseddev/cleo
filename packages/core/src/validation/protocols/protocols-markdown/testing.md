---
id: TEST
title: Testing Protocol (Project-Agnostic IVT Loop)
version: 2.0.0
status: active
type: base
audience: [llm-agent, orchestrator]
tags: [testing, ivt-loop, autonomous, framework-agnostic, compliance]
skillRef: ct-ivt-looper
lastUpdated: 2026-04-07
enforcement: strict
---

# Testing Protocol — Project-Agnostic IVT Loop

**Provenance**: @task T260 (replaces T3155 BATS-locked v1)
**Version**: 2.0.0
**Type**: Base Protocol
**Stage**: IVTR — T (Testing, the closure of the IVT loop)
**Skill**: `ct-ivt-looper`

This protocol defines the **autonomous compliance layer** that runs before any release or pull request. It is intentionally **project-agnostic** — it works in any git worktree regardless of language, framework, or directory layout. The previous v1 of this protocol was hardcoded to BATS (Bash testing) and is fully superseded.

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Loop Closure | "ivt loop", "implement and verify", "ship this task" | Autonomous compliance run |
| Test Execution | "run tests", "verify", "test this" | Test running across any framework |
| Coverage | "coverage", "test coverage", "missing tests" | Coverage gap analysis |
| Spec Compliance | "satisfy spec", "verify against spec", "match the requirements" | Spec-driven verification |
| Release Gate | "before release", "pre-PR validation", "ship verified" | Last gate before release stage |

**Explicit Override**: `--protocol testing` flag on task creation.

**Lifecycle Position**: After Validation (V), before Release (R). The Testing stage is the **closure of the Implement → Validate → Test loop**, not a one-shot operation.

---

## Core Principle

> **The loop converges on the spec, not on "tests pass". Passing tests that don't cover the spec are a failure.**

The Testing stage is autonomous: it iterates Implement → Validate → Test until the implementation satisfies every MUST requirement of the specification. It is **not** a single "run the test suite" operation. Convergence is measured against the spec, not against test count.

---

## Project-Agnostic Mandate

This protocol MUST work in any project. It MUST NOT assume:

- A specific language (TypeScript, Python, Rust, Go, Ruby, PHP, Bash, …)
- A specific test framework (vitest, jest, pytest, cargo test, …)
- A specific directory layout (`tests/`, `__tests__/`, `spec/`, `_test.go`, …)
- A specific test command (`pnpm test`, `pytest`, `cargo test`, `go test ./...`, …)

The implementation skill (`ct-ivt-looper`) MUST detect the framework dynamically from project signals before invoking any test command.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| TEST-001 | MUST identify the project's test framework via dynamic detection (config files, lockfile, devDependencies, language toolchain). The framework MUST NOT be hardcoded. |
| TEST-002 | MUST run the IVT loop with an explicit iteration counter and a hard `MAX_ITERATIONS` cap (default 5). |
| TEST-003 | MUST trace each MUST requirement from the upstream specification to at least one passing test. |
| TEST-004 | MUST achieve 100% pass rate before exiting with `ivtLoopConverged: true`. Any failing test blocks convergence. |
| TEST-005 | MUST exit the loop only when the spec is satisfied (every MUST has a passing test) or `MAX_ITERATIONS` is reached. |
| TEST-006 | MUST write a test summary to the manifest entry's `key_findings` array — at minimum framework, total run, passed, failed, coverage, iterations. |
| TEST-007 | MUST set `agent_type: "testing"` in the manifest entry. |
| TEST-008 | MUST run on a feature branch — never on `main`/`master`. The skill MUST stop and request a feature branch if the worktree is on the trunk. |
| TEST-009 | MUST escalate non-convergence to HITL via exit code 65 with a manifest entry containing `ivtLoopConverged: false` and `ivtLoopIterations: <n>`. |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| TEST-010 | SHOULD test edge cases and error paths, not just happy paths. |
| TEST-011 | SHOULD include setup/teardown fixtures appropriate to the detected framework. |
| TEST-012 | SHOULD use descriptive test names tied to spec requirement codes (e.g., "ADR-003: rejects accepted status without HITL review"). |
| TEST-013 | SHOULD report a coverage percentage when the framework supports it; warn (non-blocking) if below `coverageThreshold`. |
| TEST-014 | SHOULD prefer `.cleo/project-context.json#testing.command` when present — that file is CLEO's per-project canonical test command. |

### MAY

| Requirement | Description |
|-------------|-------------|
| TEST-020 | MAY add golden tests for output verification. |
| TEST-021 | MAY add performance benchmarks. |
| TEST-022 | MAY add stress / concurrency tests. |
| TEST-023 | MAY parallelize the IVT loop across independent specs when the agent has worktree isolation. |

---

## The IVT Loop

```
┌──────────────────────────────────────────────────────────────────┐
│  Implement → Validate → Test                                     │
│                                                                  │
│  1. Load spec (MUST requirements)                                │
│  2. Apply implementation changes                                 │
│  3. Run validation (lint + typecheck + spec-match)               │
│  4. Detect framework, run tests                                  │
│  5. Convergence check:                                           │
│     - All spec MUSTs have passing tests?                         │
│     - Validation clean? Tests 100% pass?                         │
│     - YES → record convergence, exit loop                        │
│     - NO  → analyse failures, increment counter                  │
│  6. If counter >= MAX_ITERATIONS → escalate HITL, exit code 65   │
│  7. Else → generate fix, GOTO 2                                  │
└──────────────────────────────────────────────────────────────────┘
```

The loop is **autonomous within MAX_ITERATIONS**. It never spins forever and never exits silently with unmet requirements.

---

## Framework Detection (Project-Agnostic)

The skill MUST resolve the test command in this priority order:

1. **`.cleo/project-context.json#testing.command`** — CLEO's per-project canonical (highest priority)
2. **Auto-detection signals** in the worktree:

| Signal | Framework | Canonical Command |
|--------|-----------|-------------------|
| `vitest.config.*` or `vitest` in package.json devDeps | vitest | `pnpm vitest run` (or `npx vitest run`) |
| `jest.config.*` or `jest` in package.json devDeps | jest | `npx jest --ci` |
| `mocha` in package.json devDeps and `.mocharc*` | mocha | `npx mocha` |
| `pytest.ini` / `pyproject.toml [tool.pytest]` / `conftest.py` | pytest | `pytest -q` |
| `tests/__init__.py` or `unittest` in stdlib usage | unittest | `python -m unittest discover -q` |
| `Cargo.toml` | cargo-test | `cargo test --quiet` |
| `go.mod` | go-test | `go test ./...` |
| `Gemfile` with `rspec` | rspec | `bundle exec rspec` |
| `phpunit.xml*` | phpunit | `vendor/bin/phpunit` |
| `*.bats` files in `tests/` | bats | `bats tests/` |
| none of the above | other | fall back to project-context.json or HITL ask |

3. **Fallback** — if no signal matches, the skill MUST stop and ask the operator to declare the test command in `.cleo/project-context.json`.

---

## Convergence Criteria

The loop is converged when **ALL** of these are true:

- Every MUST requirement from the upstream specification maps to at least one passing test (TEST-003).
- The test suite reports `failed: 0`.
- Lint / format / typecheck reports zero errors.
- Spec-match validation (validation stage protocol VALID-001) confirms implementation matches the spec.
- No runtime errors in CI-equivalent local commands.

If any of the above is false, the loop continues until `MAX_ITERATIONS` is hit.

---

## Branch Discipline

- Detect the current branch via `git branch --show-current`.
- If the branch is `main`, `master`, `trunk`, `develop`, or matches `release/*` → STOP.
- Refuse to run the IVT loop on a trunk branch. Request a feature branch from the operator before continuing.
- The IVT loop modifies code; trunk branches MUST be protected.

---

## Manifest Entry

Use `cleo research add` to record the IVT loop result:

```bash
cleo research add \
  --title "Testing IVT loop: <feature>" \
  --file "T####-ivt-report.md" \
  --topics "testing,ivt-loop,<framework>" \
  --findings "framework: <name>,run: N,passed: N,failed: 0,iterations: <n>,converged: true" \
  --status complete \
  --task T#### \
  --agent-type testing
```

The orchestrator MUST then call:

```bash
cleo check protocol --protocolType testing \
  --taskId T#### \
  --framework <name> \
  --testsRun N --testsPassed N --testsFailed 0 \
  --ivtLoopConverged true --ivtLoopIterations <n>
```

This invokes the canonical pure validator (`validateTestingProtocol` in `packages/core/src/orchestration/protocol-validators.ts`) and is the runtime authority for whether the testing stage is complete.

---

## Integration Points

### With Implementation Protocol (the "I" of IVT)

The IVT loop wraps `implementation` work — every fix iteration is governed by IMPL-001..007. The loop MUST NOT skip the implementation protocol's own gates.

### With Validation Protocol (the "V" of IVT)

The validation stage runs **inside** each IVT iteration (step 3), not just before testing. Validation reports feed back into the convergence check.

### With Release Protocol

```
Testing (T) ──► Release (R)
       │              │
       │ Converged?   │ Requires:
       │ Yes          │ - ivtLoopConverged: true
       │              │ - testsFailed: 0
       │              │ - All MUSTs covered
```

The release stage MUST refuse to advance if the testing stage's manifest entry has `ivtLoopConverged: false`.

---

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | SUCCESS | Loop converged, manifest recorded |
| 65 | HANDOFF_REQUIRED | Non-convergence after MAX_ITERATIONS — HITL escalation |
| 67 | CONCURRENT_SESSION | Generic testing protocol violation (used by orchestration validator) |
| 80 | LIFECYCLE_GATE_FAILED | A required gate (validation, spec-match, branch discipline) failed |

---

## HITL Escalation

When the loop fails to converge:

1. Write a manifest entry with:
   - `agent_type: "testing"`
   - `key_findings: ["framework: <name>", "iterations: <MAX>", "converged: false", "remaining failures: <list>"]`
   - `actionable: true`
   - `needs_followup: ["HITL review required"]`
2. Exit with code 65 (`HANDOFF_REQUIRED`).
3. Surface the unmet spec requirements to the operator with concrete next steps.

The operator picks up the loop manually, fixes the blocking failure, and re-launches the IVT loop. The skill MUST NOT silently exit, MUST NOT loosen the spec, and MUST NOT mark the task complete.

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Hardcoding vitest/jest/pytest | Violates the project-agnostic mandate (TEST-001) |
| Running tests once and reporting result | Testing is a LOOP, not a one-shot (TEST-005) |
| Skipping validation between iterations | Validation gates are part of IVT, not a pre-step (TEST-009 wraps both) |
| Bailing silently on non-convergence | Must escalate to HITL with exit 65 (TEST-009) |
| Marking task complete with `failed > 0` | TEST-004: 100% pass required for convergence |
| Modifying main/master branch | TEST-008: branch discipline mandatory |
| Ignoring spec-requirement traceability | TEST-003: every MUST needs a test |
| Treating coverage as the convergence metric | Coverage is advisory; spec satisfaction is the gate |
| Editing test expectations to match broken code | The fix goes in the implementation, not the test |

---

## Cross-Cutting: Contribution Protocol

Multi-agent IVT loops MUST record contributor identity per iteration in the contribution protocol. See `protocols-markdown/contribution.md`.

---

## References

- **Skill**: `packages/skills/skills/ct-ivt-looper/SKILL.md` (project-agnostic loop logic)
- **Pure validator**: `packages/core/src/orchestration/protocol-validators.ts#validateTestingProtocol`
- **Wrapper**: `packages/core/src/validation/protocols/testing.ts`
- **Engine op**: `packages/cleo/src/dispatch/engines/validate-engine.ts#validateProtocolTesting`
- **Dispatch case**: `packages/cleo/src/dispatch/domains/check.ts` (case `'testing'`)
- **Per-project test command override**: `.cleo/project-context.json#testing.command`
- **Implementation protocol** (the "I"): `protocols-markdown/implementation.md`
- **Validation protocol** (the "V"): `protocols-markdown/validation.md`
- **Release protocol** (downstream gate): `protocols-markdown/release.md`
