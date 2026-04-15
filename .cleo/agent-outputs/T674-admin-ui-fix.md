# T674 — Studio UX: Admin Nav Fix

**Date**: 2026-04-15
**Status**: complete
**Agent**: Lead+Worker subagent

---

## Root Cause

The `/projects` admin route existed and was fully functional (Scan, Clean, Index, Re-Index, Delete operations). It was simply **absent from the `navItems` array** in `packages/studio/src/routes/+layout.svelte`.

The array had 4 entries:
- Brain (`/brain`)
- Memory (`/brain/overview`)
- Code (`/code`)
- Tasks (`/tasks`)

No entry for `/projects` — which is the Admin UI the owner was looking for. Classic UX gap: the page exists, the user just has no way to discover it from the nav.

---

## Fix Applied

**File changed**: `packages/studio/src/routes/+layout.svelte`

Added one entry to `navItems`:

```ts
{ href: '/projects', label: 'Admin', description: 'Project registry — scan, index, and manage projects', exact: false },
```

The label is "Admin" (matching what the owner expects) and links to `/projects` (the existing functional admin page). Tooltip text describes the page's purpose for discoverability.

---

## Verification

### HTML Confirmation

The rendered nav HTML at `http://localhost:5173/` now contains:

```html
<a href="/projects" class="nav-link" title="Project registry — scan, index, and manage projects">Admin</a>
```

Nav order: Brain | Memory | Code | Tasks | **Admin**

### Projects Page

`http://localhost:5173/projects` renders:
- Page title: "Projects — CLEO Studio"
- Subtitle: "Multi-Project Registry"
- Toolbar: Scan, Clean buttons
- Per-row actions: Switch, Index/Re-Index, Delete

No dead links. All actions functional.

### Quality Gates

| Gate | Result |
|------|--------|
| `pnpm biome check --write packages/studio` | PASS — No fixes applied, 63 files checked |
| `pnpm --filter @cleocode/studio build` | PASS — Built in 3.91s |
| `pnpm --filter @cleocode/studio test` | PASS — 174 tests passed (10 files) |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/studio/src/routes/+layout.svelte` | Added `Admin` entry to `navItems` array (1 line) |

---

## Note on Version

The owner is running v2026.4.56 per the session handoff note (v2026.4.58 is live on npm). This fix is in main — they will need to `npm update -g @cleocode/cleo-os` or pull the latest to see the change if running the published build. For local dev it is immediately visible.
