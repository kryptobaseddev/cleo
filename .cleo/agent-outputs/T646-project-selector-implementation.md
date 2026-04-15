# T646 — UX P0: Header Project Selector

**Task**: T646  
**Date**: 2026-04-15  
**Status**: complete

## What Was Built

Four files created to deliver the always-visible header project selector:

### 1. ProjectSelector.svelte
`packages/studio/src/lib/components/ProjectSelector.svelte`

Svelte 5 runes component with full spec coverage:
- Props: `projects: ProjectSummary[]`, `activeProjectId: string | null`
- Trigger: colored chip (first letter, hashed from name) + project name + chevron
- Dropdown: search input (autofocused), "Show test" toggle (off by default)
- Test project filter: `/(tmp|test|fixture|scratch|sandbox)\b/i` on projectPath
- Unhealthy projects: shown at `opacity: 0.55` with red status dot
- Project rows: chip + name + path + stats pills (tasks/symbols counts)
- Switch action: `POST /api/project/switch` with `{projectId}`, then `window.location.reload()`
- Keyboard: ArrowUp/Down navigate, Enter selects, Escape closes
- Click-outside: `onMount` + `document.addEventListener('mousedown', ...)` with cleanup
- Theme: `#1a1f2e` bg, `#2d3748` borders, `#e2e8f0` text — matches existing dark theme

### 2. +layout.server.ts
`packages/studio/src/routes/+layout.server.ts`

Root layout server load that calls `listRegisteredProjects()` + `getActiveProjectId(cookies)` and returns both to every page via the layout data cascade.

### 3. API switch endpoint
`packages/studio/src/routes/api/project/switch/+server.ts`

`POST /api/project/switch` — reads `{projectId}` JSON, validates, calls `setActiveProjectId(cookies, projectId)`, returns `{success: true}`. Proper 400 errors for bad input.

### 4. +layout.svelte (updated)
`packages/studio/src/routes/+layout.svelte`

Wired `ProjectSelector` between logo and nav. Passes `data.projects` and `data.activeProjectId` from the layout server load. Nav uses `margin-left: auto` to stay right-aligned.

### 5. ProjectSelector.test.ts
`packages/studio/src/lib/components/__tests__/ProjectSelector.test.ts`

Logic-isolation tests (no jsdom needed) covering:
- `chipLetter`: uppercase first char, empty string fallback
- `chipColor`: deterministic hash, valid hex output
- `isTestProject`: all 5 path keywords, case-insensitivity, substring-word non-match
- `filterProjects`: test projects hidden by default, toggle reveals them, search by name/path, whitespace-only query treated as no filter
- Unhealthy project identification
- Project name display / active project lookup
- Switch payload shape

## Quality Gates

- `pnpm biome check --write packages/studio` — PASSED (3 auto-fixes applied)
- `pnpm --filter @cleocode/studio run build` — PASSED (built in 1.82s)
- `pnpm --filter @cleocode/studio run test` — PASSED (69/69 tests, 4 test files)

## Acceptance Criteria Coverage

| Criterion | Status |
|-----------|--------|
| Project selector visible in studio header on every page | Done — in root layout |
| Shows currently active project name | Done — trigger button |
| Searchable dropdown filters by name/path | Done |
| Test/scratch projects hidden by default with toggle | Done |
| Unhealthy projects shown grayed-out | Done — opacity 0.55 + red dot |
| Project switch sets cookie and reloads current page | Done — POST + reload |
| GitNexus-inspired pattern — chevron + search + scrollable list | Done |
| Build green | Done |
| Type-safe | Done — no any/unknown, proper interfaces |
