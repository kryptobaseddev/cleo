# GitHub Templates — Integration Complete

**Date**: 2026-03-18
**Status**: complete

---

## Summary

GitHub issue and PR templates were copied from the old `claude-todo` repo, updated for the cleocode monorepo, and wired into `init`, `upgrade`, and `doctor` so they are installed automatically on first run and surfaced as a health warning when absent.

---

## What was done

### Step 1 — Template files written

**Destination**: `/mnt/projects/cleocode/templates/github/` (repo root copy for reference)

Runtime path used by the package: `packages/core/templates/github/` (already existed with correct content; root copy now matches it)

Files reviewed and updated:
- `ISSUE_TEMPLATE/bug_report.yml` — Updated install-method options (removed curl/bash installer, added npm and monorepo options). Updated diagnostics command (removed jq/Bash deps, added Node version).
- `ISSUE_TEMPLATE/config.yml` — Updated GitHub URLs from `kryptobaseddev/cleo` to `cleocode/cleo`.
- `ISSUE_TEMPLATE/feature_request.yml` — Added `@cleocode/core package API` and `Provider adapters` dropdown options.
- `ISSUE_TEMPLATE/help_question.yml` — Same topic area additions; updated doc links to `cleocode/cleo`.
- `pull_request_template.md` — Changed `npm test` to `pnpm test`, added verb-standards checklist item.

### Step 2 — `installGitHubTemplates()` added to `init.ts`

**File**: `/mnt/projects/cleocode/packages/core/src/init.ts`

- Added `writeFile` to imports.
- Added `installGitHubTemplates(projectRoot, created, skipped)` function (lines ~310-375):
  - Guards: only runs when `.git/` exists; skips silently if template source dir absent.
  - Idempotent: skips individual files that already exist using the `skipped` array.
  - Copies all `ISSUE_TEMPLATE/*.yml` files and `pull_request_template.md`.
- Called from `initProject()` before `removeCleoFromRootGitignore()`.
- Updated doc comment to list step 14.

### Step 3 — Upgrade health check added to `upgrade.ts`

**File**: `/mnt/projects/cleocode/packages/core/src/upgrade.ts`

- Imported `installGitHubTemplates` from `./init.js`.
- Non-dry-run (Step 8 structural maintenance): if `.git` exists and `.github/ISSUE_TEMPLATE/` is absent, calls `installGitHubTemplates` and records an `applied` action.
- Dry-run path: emits a `preview` action with `fix: 'cleo upgrade'` suggestion when templates are missing.

### Step 4 — Doctor check added to `health.ts`

**File**: `/mnt/projects/cleocode/packages/core/src/system/health.ts`

- Added `github_templates` check in `coreDoctorReport()` (after `agent_definition`, before Node version).
- Non-critical `warning` status when `.github/ISSUE_TEMPLATE/` is absent (only when `.git` exists).
- `ok` status with message when templates are present.
- Does not affect `startupHealthCheck` — this is informational only, surfaced via `cleo doctor`.

### Step 5 — TypeScript check

Ran `npx tsc --noEmit` from `/mnt/projects/cleocode/`. Zero errors in the files changed. Pre-existing errors in test mocks (`cli-mcp-parity.integration.test.ts`, `parity.test.ts`, `nexus.test.ts`) are unrelated to this work.

---

## Runtime path resolution

`getPackageRoot()` resolves to `packages/core/` (the directory containing `package.json` for `@cleocode/core`). The template source path at runtime is therefore:

```
packages/core/templates/github/ISSUE_TEMPLATE/  (4 yml files)
packages/core/templates/github/pull_request_template.md
```

These files pre-existed with correct content. The repo-root `templates/github/` copy is kept in sync for discoverability and for the `.github/` directory that would be installed from there by CI or manual copy.

---

## Key files changed

- `/mnt/projects/cleocode/packages/core/src/init.ts` — new function + call
- `/mnt/projects/cleocode/packages/core/src/upgrade.ts` — import + warning/install step
- `/mnt/projects/cleocode/packages/core/src/system/health.ts` — `github_templates` doctor check
- `/mnt/projects/cleocode/templates/github/ISSUE_TEMPLATE/bug_report.yml` — created (updated)
- `/mnt/projects/cleocode/templates/github/ISSUE_TEMPLATE/config.yml` — created (updated)
- `/mnt/projects/cleocode/templates/github/ISSUE_TEMPLATE/feature_request.yml` — created (updated)
- `/mnt/projects/cleocode/templates/github/ISSUE_TEMPLATE/help_question.yml` — created (updated)
- `/mnt/projects/cleocode/templates/github/pull_request_template.md` — created (updated)
