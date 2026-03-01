# T4881: Decomposition Plan

**Date**: 2026-02-25
**Task**: T4885
**Epic**: T4881
**Type**: Decomposition
**Status**: complete

## Wave 1 (Documentation and Decision)

- T4882: ADR-016 accepted
- T4883: research completed
- T4884: install/spec docs published
- T4885: decomposition approved

## Wave 2 (CLEO Core)

- T4886: implement channel-aware runtime diagnostics and dev-safe defaults
- Validate `cleo sequence`, `cleo env`, and `mcp-install` surfaces remain channel-consistent
- Refactor installer link creation to `installer/lib/link.sh` mode mapping
- Remove production installer dependency on `dev/setup-claude-aliases.sh`
- Enforce dev command naming policy (`cleo-dev` only, no `ct`)
- Document contributor caveat: raw `npm link` is non-isolated package-bin behavior

## Wave 3 (CAAMP Integration)

- T4887: CAAMP API/CLI install contract for `stable|beta|dev`
- T4888: TUI onboarding/install/update/rollback flow
- Optional Claude alias utility ownership transferred to CAAMP

## Exit Criteria

1. Stable users can install and run CLEO MCP via CAAMP in one command.
2. Beta users can run side-by-side with stable where provider supports it.
3. Contributors can run `cleo-dev` with isolated storage without disturbing stable runtime.
