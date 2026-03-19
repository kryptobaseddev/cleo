# CI Workflow — Completion Report

**Task**: CI workflow for @cleocode monorepo
**Date**: 2026-03-18
**Status**: complete

---

## Summary

Created a GitHub Actions CI workflow for the pnpm-based `@cleocode/monorepo`, adapted from the old `claude-todo` workflow. The new workflow uses `pnpm/action-setup@v4`, pnpm store caching, and checks against `packages/cleo/dist/` and `packages/core/dist/` instead of the old `dist/`. YAML syntax verified valid. Pre-existing TypeScript errors in test files were present before this task and are unrelated to the workflow files.

---

## Files Written

- `/mnt/projects/cleocode/.github/workflows/ci.yml` — primary workflow
- `/mnt/projects/cleocode/templates/github/workflows/ci.yml` — template copy for `cleo init`

---

## Jobs

| Job | Trigger | Purpose |
|-----|---------|---------|
| `changes` | always | Path-filter: `code` (packages/**) and `schemas` |
| `biome` | always | `biome ci .` — lint + format check |
| `typecheck` | code changed | `pnpm run typecheck` (`tsc -b`) |
| `unit-tests` | code changed | `vitest run --shard=N/2`, multi-OS on PRs to main |
| `build-verify` | code changed | `node build.mjs`, verify `packages/core/dist/index.js` and CLI binary |
| `validate-json` | schemas changed | `jq empty` on `packages/*/schemas/**/*.json` |
| `install-test` | code changed | `pnpm link --global`, `cleo version`, `cleo init` smoke test |

## Key Differences from Old Workflow

| Area | Old (claude-todo) | New (cleocode) |
|------|-------------------|----------------|
| Package manager | npm / `npm ci` | pnpm / `pnpm install --frozen-lockfile` |
| Install action | `actions/setup-node` cache: npm | `pnpm/action-setup@v4` + pnpm store cache |
| Build | `node build.mjs` → `dist/` | `node build.mjs` → `packages/*/dist/` |
| CLI check | `node dist/cli/index.js version` | `node packages/cleo/dist/cli/index.js version` |
| MCP check | `node dist/mcp/index.js` | `node packages/cleo/dist/mcp/index.js` |
| Core dist check | n/a | `packages/core/dist/index.js` |
| Global link | `npm link` | `pnpm link --global packages/cleo` |
| Typecheck | `npx tsc --noEmit` | `pnpm run typecheck` (runs `tsc -b`) |
| Dev hygiene scripts | bash dev/ scripts | Removed — biome + tsc cover these |
| Integration/E2E jobs | separate jobs | Removed — vitest.config.ts has no project splits yet |

## Notes

- The old `hygiene` job (check-todo-hygiene.sh, check-underscore-import.mjs, check-core-purity.sh) was intentionally dropped per task instructions — biome and tsc handle static analysis in the new repo.
- Integration and E2E vitest project configs do not exist yet in the new repo (`vitest.config.ts` has no `projects` array), so those jobs were omitted to avoid false failures. Add them when project configs are defined.
- `pnpm/action-setup@v4` requires pnpm version to match `packageManager` field in root `package.json` (`pnpm@10.30.0`).
- The `install-test` job uses `pnpm link --global packages/cleo` (not `npm link`) and `pnpm unlink --global @cleocode/cleo` for cleanup.

## TSC Status

Pre-existing type errors exist in test files (`packages/core/src/**/__tests__/*.test.ts`). These were present before this task. No new errors were introduced — the workflow files are YAML/markdown only.
