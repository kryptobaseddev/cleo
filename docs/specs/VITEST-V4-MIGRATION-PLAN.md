# Vitest v4 Migration Plan (T5220)

Status: Planned

Epic: `T5220`

## Purpose

Define the full end-to-end migration from Vitest `3.2.4` to the latest Vitest `v4.x` (currently `4.0.18`), including configuration, test organization, mocking compatibility, coverage behavior, CI scripts, and documentation.

This document is the canonical planning ledger for migration scope and required fixes.

## Current State

- Current Vitest version: `3.2.4`
- Latest available version: `4.0.18`
- Existing test discovery: dynamic via `vitest.config.ts` include patterns
- Existing test footprint: large co-located `src/**/__tests__/` footprint + emerging top-level `tests/` usage

## Migration Outcomes (Required)

1. Upgrade to latest Vitest `v4.x`
2. Preserve all existing test behavior (no regression)
3. Adopt project-based organization via `test.projects` (`unit`, `integration`, `e2e`)
4. Keep co-located `__tests__/` for unit tests
5. Move or map integration/e2e tests into `tests/integration/` and `tests/e2e/`
6. Migrate coverage config to v4 expectations (explicit include/exclude)
7. Resolve all mocking behavior differences introduced in v4
8. Update CI and local scripts for project-scoped runs
9. Document all fixes and troubleshooting guidance

## Task Decomposition (CLEO)

- `T5221` Audit existing Vitest usage and compatibility risks
- `T5222` Upgrade Vitest and related packages to latest v4.x
- `T5224` Migrate `vitest.config.ts` to v4 standards
- `T5223` Implement project-based test organization (`unit`/`integration`/`e2e`)
- `T5228` Migrate coverage configuration for Vitest v4
- `T5226` Fix mock behavior regressions under Vitest v4
- `T5225` Update CI and local test scripts for project matrix
- `T5227` Document migration and troubleshooting
- `T5230` Update `AGENTS.md` testing standards and layout policy
- `T5229` Validate full-suite parity and zero-regression acceptance

## Technical Fix Checklist

## 1) Dependency and Versioning

- Upgrade `vitest` to latest `v4.x`
- Upgrade matching coverage package(s), e.g. `@vitest/coverage-v8`
- Confirm lockfile resolves a single compatible Vitest major

## 2) Config Migration (`vitest.config.ts`)

- Keep/confirm dynamic discovery (no manual test registration)
- Add `test.projects` segmentation:
  - `unit`
  - `integration`
  - `e2e`
- Replace any deprecated/removed options from pre-v4 config
- Confirm pool/worker semantics use v4-compatible options

## 3) Test Layout Policy

- Unit tests remain co-located under `src/**/__tests__/`
- Integration tests target `tests/integration/`
- E2E tests target `tests/e2e/`
- Remove scattered ad-hoc E2E placement over time

## 4) Coverage Migration (v4 behavior)

- Define explicit `coverage.include`
- Define explicit `coverage.exclude`
- Validate thresholds and output parity
- Account for v4 V8 remapping differences in baseline comparisons

## 5) Mocking and Runtime Behavior

Address v4 changes affecting existing tests:

- Constructor mocking/spying behavior
- `mockReset`/`restoreAllMocks` semantic differences
- Snapshot output and mock naming differences where relevant
- Module mock behavior compatibility

## 6) Scripts and CI

- Add project-scoped commands:
  - `vitest run --project unit`
  - `vitest run --project integration`
  - `vitest run --project e2e`
- Update CI matrix to run project scopes explicitly
- Preserve full-run command (`npm test`) for aggregate verification

## 7) Documentation and Agent Guidance

- Keep this migration plan updated as fixes land
- Update `AGENTS.md` with Vitest v4 standards
- Add troubleshooting notes for common v4 migration failures

## Acceptance Criteria

Migration is complete only when all are true:

1. Vitest major is `v4.x` across repo
2. All tests pass under v4 (`unit` + `integration` + `e2e`)
3. No skipped tests introduced by migration
4. Coverage command works with explicit include/exclude configuration
5. Project-scoped runs execute successfully in CI and local scripts
6. `AGENTS.md` reflects canonical testing policy and layout
7. Migration decisions and fixes are fully documented

## Risk Notes

- Coverage report deltas are expected due to v4 remapping accuracy improvements
- Mock behavior differences can create subtle false negatives/positives
- Test organization changes can affect import paths and fixture resolution

## Non-Goals

- No unrelated framework migration
- No broad refactors unrelated to Vitest v4 compatibility
