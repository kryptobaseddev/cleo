# T649 — Route Rename: /brain (canvas) + /brain/overview (dashboard) + /code (was /nexus)

## Status: complete

## Changes Made

### File moves (git mv — history preserved)
- `brain/+page.svelte` → `brain/overview/+page.svelte` (stats dashboard)
- `brain/+page.server.ts` → `brain/overview/+page.server.ts`
- `living-brain/+page.svelte` → `brain/+page.svelte` (canvas now owns root)
- `living-brain/+page.server.ts` → `brain/+page.server.ts`
- `living-brain/` directory removed
- `nexus/` directory → `code/` directory (entire subtree)

### Nav updated (`+layout.svelte`)
- Old: `[Projects] [Nexus] [Brain] [Living Brain] [Tasks]`
- New: `[Brain] [Code] [Tasks]` (3 items + header project dropdown)

### Internal links fixed
- `brain/+page.svelte` (canvas): title updated to "Brain — CLEO Studio", h1 to "Brain Canvas", added side-panel cross-links per substrate/kind
- `brain/overview/+page.svelte`: added "Open in Canvas →" pill, back-links updated
- `brain/decisions/+page.svelte`: back-link → /brain/overview, "Open in Canvas →" pill added
- `brain/observations/+page.svelte`: back-link → /brain/overview, "Open in Canvas →" pill added
- `brain/quality/+page.svelte`: back-link → /brain/overview, "Open in Canvas →" pill added
- `brain/graph/+page.svelte`: back-link → /brain/overview
- `code/+page.svelte`: drillDownBase `/nexus/community/:id` → `/code/community/:id`, community hrefs, title, "Open in Canvas →" pill
- `code/community/[id]/+page.svelte`: breadcrumb, back-link, symbol/community hrefs, drillDownBase all updated to /code/..., "Open in Canvas →" pill
- `code/symbol/[name]/+page.svelte`: breadcrumb, all chip hrefs, drillDownBase all updated to /code/..., "Open in Canvas →" pill
- `+page.svelte` (landing): portals array reordered (Brain first), /nexus → /code href, descriptions updated

### Server load update
- `brain/+page.server.ts`: TSDoc note added explaining /api/living-brain API path retention

### Cross-links added (Step 5)
- Canvas side panel: brain observations/decisions → /brain/observations, /brain/decisions; nexus symbols → /code/symbol/<name>; nexus communities → /code/community/<id>
- /brain/overview: "Open in Canvas →" → /brain
- /brain/decisions: "Open in Canvas →" → /brain?scope=brain&type=decision
- /brain/observations: "Open in Canvas →" → /brain?scope=brain&type=observation
- /brain/quality: "Open in Canvas →" → /brain
- /code: "Open in Canvas →" → /brain?scope=nexus
- /code/community/[id]: "Open in Canvas →" → /brain?scope=nexus&community=<id>
- /code/symbol/[name]: "Open in Canvas →" → /brain?scope=nexus

### Test added
- `brain/__tests__/route-existence.test.ts`: 18 assertions covering target tree existence, old route removal, and unchanged route preservation

## Quality Gates
- `pnpm biome check --write packages/studio`: PASS (no fixes applied)
- `pnpm --filter @cleocode/studio run build`: PASS (✓ built in 5.09s)
- `pnpm --filter @cleocode/studio run test`: PASS (93/93 tests)

## API paths unchanged
- `/api/living-brain` and `/api/nexus` preserved — no churn, TSDoc note added
