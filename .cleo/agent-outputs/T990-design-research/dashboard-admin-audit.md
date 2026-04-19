# Studio Root Dashboard + Admin Audit (T990)

**Scope**: `/` (root), `/projects` (admin), API health endpoints, global layout, project context resolution  
**Audit Date**: 2026-04-17  
**Context**: 5-minute rapid audit of operational dashboard and admin surfaces

---

## 1. Root Dashboard (`/` + `/+page.svelte`)

### Purpose & Content
- **Type**: Portal hub (not dead weight)
- **Role**: Landing page that surfaces 4 major data domains in a 2x2 grid
- **Stats Display**: Live stats pulled on every page load via `/+page.server.ts`

### Portal Cards Exposed
1. **Brain** (`/brain`) — 5-substrate living canvas; shows node count + observations
2. **Code** (`/code`) — Code intelligence / symbol graph; shows symbols + relations counts
3. **Memory** (`/brain/overview`) — BRAIN dashboard; shows same brain stats as Brain portal
4. **Tasks** (`/tasks`) — Task management; shows task count + epic count

### Design Observations
- **Grid Layout**: Responsive 4-column grid (auto-fill, 260px min-width); collapses gracefully
- **Visual Hierarchy**: Hero title (2.25rem), subtitle (1rem), cards with color-coded icons
- **Accessibility**: Minimal; no alt text on SVG arrows, no ARIA labels
- **Stats Fallback**: Shows "Database not found" in red (#ef4444) if DB unavailable
- **Interactivity**: Hover effect on cards triggers border color change + arrow translation
- **Color Scheme**: Dark theme (#0f1117 bg, #f1f5f9 text, accent colors per portal)

### Issues
- Duplicate stats assignment: `brainStats` mapped to both Brain + Memory portals (appears intentional but confusing)
- No loading states while stats are fetched
- No error handling if `/+page.server.ts` fails (stats will be null, card shows "Database not found")

---

## 2. Global Navigation (`/+layout.svelte` + `/+layout.server.ts`)

### Nav Structure
Sticky header (48px height, z-index 100) with 5 top-level items:

| Link | Route | Exact Match | Description |
|------|-------|-------------|-------------|
| Brain | `/brain` | YES | 5-substrate living canvas |
| Memory | `/brain/overview` | NO | BRAIN dashboard |
| Code | `/code` | NO | Code intelligence |
| Tasks | `/tasks` | NO | Task management |
| Admin | `/projects` | NO | Project registry—scan, index, manage |

### Visual Design
- **Logo**: "C" mark (3b82f6 blue) + "CLEO Studio" text (94a3b8 gray)
- **Active State**: Blue bg (rgba(59,130,246,0.1)) + blue text (#3b82f6)
- **Hover**: Gray text (#e2e8f0) + dark bg (#2d3748)
- **Typography**: 0.8125rem, 500 weight, subtle letter-spacing
- **Spacing**: 0.25rem gap between links, 0.75rem padding per link

### Project Selector Integration
Located in header between logo + nav. Displays:
- **Trigger**: Colored chip + project name + chevron icon
- **Tooltip**: Full project path on hover
- **Dropdown**: Searchable list with filter toggles (show test projects checkbox)
- **Stats**: Task count + symbol count badges per project
- **Health Indicator**: Green dot for active, red dot for unhealthy

---

## 3. Project Context Flow (Cookie-Based)

### Architecture
```
hooks.server.ts
  ├─ On every request
  ├─ getActiveProjectId(cookies)  // Read 'activeProject' cookie
  ├─ resolveProjectContext(id) || resolveDefaultProjectContext()
  └─ event.locals.projectCtx → available to all pages/endpoints
```

### Context Propagation
- **+layout.server.ts**: Supplies `activeProjectId` + `projects[]` to all pages
- **ProjectSelector.svelte**: Calls `POST /api/project/switch` to set cookie
- **Per-Page Isolation**: Each page reads `locals.projectCtx` independently (brain, tasks, nexus DBs)

### Cookie Mechanics
- **Name**: `activeProject` (assumed, not shown in code)
- **Fallback**: Default project context (CLEO_ROOT / cwd) if cookie missing/invalid
- **Persistence**: Survives page reloads + tab changes (browser-side)

### Risks
- No explicit cookie expiry or SameSite policy visible
- No validation that project still exists in registry after switch
- Unhealthy projects are still selectable (silhouetted in UI but allowed)

---

## 4. Admin Page (`/projects` route)

### Purpose
Multi-project registry hub. Centralized surface for:
- Scanning filesystem for projects
- Registering/unregistering projects
- Indexing projects (lexical analysis)
- Deleting projects from registry
- Cleaning up stale/unhealthy projects

### Operations Exposed

#### Per-Project Actions (in card rows)
| Action | Condition | Endpoint | Details |
|--------|-----------|----------|---------|
| Switch to Project | Not active | Cookie set | Full page reload |
| Clear Selection | Is active | Cookie clear | Returns to default context |
| Index | Never indexed | `POST /api/project/[id]/index` | First-time analysis |
| Re-Index | Already indexed | `POST /api/project/[id]/index` | Refresh analysis |
| Delete | Always | `DELETE /api/project/[id]` | Remove from registry |

#### Global Toolbar Actions
- **Scan**: Opens modal to scan filesystem for projects (configurable roots, depth, auto-register)
- **Clean**: Opens modal to purge stale/unhealthy projects (dry-run by default, requires "PURGE" confirmation for real delete)

### Information Density
**Per Project Card**:
- Project name + "active" badge (green, uppercase)
- Project path (monospace, gray)
- 4-column stats grid: Tasks | Symbols | Relations | Last Indexed
- Orange stale dot (if last indexed >7 days ago)
- Action button row with loading/success/error states

**Empty State**: 
- Shows CLI commands (`cleo nexus projects register` / `cleo nexus analyze`)
- Directs user to "Scan" button

### UI Feedback
- **Loading**: Inline spinner (4 corners) during action; button text clears
- **Success**: Green badge "Done" appears for 3s, then fades
- **Error**: Red badge "Error" with hover tooltip showing error message
- **Stale Detection**: Re-Index button turns orange if index >7 days old

### Design Issues
1. **Poor Information Scent**: "Last Indexed" field shows only date (YYYY-MM-DD), no time. Unclear if "stale" threshold is hard-coded (appears to be 7 days)
2. **Action Button Overflow**: On small screens, action row may wrap; layout degrades poorly
3. **No Bulk Operations**: Each project requires individual action; no "select multiple" or "reindex all" option
4. **No Undo**: Delete is soft-confirmed (modal) but registry purge is permanent with no recovery path shown
5. **Missing Context**: No indication of project health status beyond activity badges

---

## 5. Health Endpoint (`/api/health/+server.ts`)

### Response Schema
```json
{
  "ok": true,
  "service": "cleo-studio",
  "version": "2026.4.47",
  "databases": {
    "nexus": "available|not found",
    "brain": "available|not found",
    "tasks": "available|not found"
  },
  "paths": {
    "nexus": "/path/to/nexus.db",
    "brain": "/path/to/brain.db",
    "tasks": "/path/to/tasks.db"
  }
}
```

### Version String
- **Hardcoded**: `2026.4.47`
- **Status**: DRIFT DETECTED
  - Today is 2026-04-17, so version claims "April 47" (invalid date)
  - Should be `2026.04.17` or use semantic versioning (e.g., `2.0.47`)
  - No correlation with package.json version visible

### Database Status Reporting
- **Nexus**: Global, project-agnostic DB (symbols, relations)
- **Brain**: Per-project (observations, decisions, page nodes)
- **Tasks**: Per-project (tasks, epics, sessions)
- **Paths**: Absolute paths to DB files returned (helpful for debugging)

### Issues
1. **Hardcoded Version**: Not updated automatically; requires manual bump
2. **No Timestamp**: No `checkedAt` or `uptime` field
3. **No Detailed Health**: Only "available" or "not found"; no query performance, table counts, or schema version
4. **No Endpoint Status**: No indication of studio server readiness (e.g., CPU, memory)

---

## 6. Missing Admin Operations (CLI vs. Studio)

### Operations in CLI but NOT in `/projects` Admin UI

#### Backup / Export
- `cleo nexus backup` / `cleo nexus export` (assumed to exist)
- **Studio Status**: No backup modal or toolbar action
- **Gap**: Users must drop to CLI for data preservation

#### Database Doctor / Repair
- `cleo nexus doctor` (verify integrity, repair corruption)
- **Studio Status**: Not exposed
- **Gap**: No self-healing or diagnostics surface

#### Migration / Schema Updates
- `cleo nexus migrate` (upgrade DB schema)
- **Studio Status**: Not exposed
- **Gap**: No visibility into schema version or migration status

#### Garbage Collection
- `cleo nexus gc` (cleanup unused data)
- **Studio Status**: Not exposed in `/projects`
- **Gap**: Registry cleanup is via modal (via `/api/project/clean`), but symbol graph GC is missing

#### Project Health Audit
- `cleo nexus projects status` (detailed per-project health report)
- **Studio Status**: Only boolean "unhealthy" flag shown as red dot
- **Gap**: No detailed diagnostics (missing files, corrupted indices, etc.)

#### Reindex All
- Bulk reindex operation (implied, not confirmed)
- **Studio Status**: Per-project only; no bulk action
- **Gap**: Scaling concern for large registries

---

## 7. Design Gaps & Observations

### Information Density
| Surface | Density | Notes |
|---------|---------|-------|
| Root Dashboard | LOW | Intentional; portal/hub role; good for quick orientation |
| Global Nav | MEDIUM | 5 items is reasonable; project selector adds complexity but essential |
| Projects Admin | MEDIUM-HIGH | Card layout is compact; stats grid could be larger; font hierarchy is clear |
| ProjectSelector | HIGH | 320px dropdown with search, stats, health indicators; responsive but cramped on small viewports |

### Typography System
- **Headings**: 2.25rem (hero) → 1.5rem (page) → 1rem (card title) → 0.875rem (label)
- **Body**: 0.8125rem (primary), 0.75rem (secondary), 0.6875rem (tertiary)
- **Monospace**: Used for paths, counts, regex patterns (good consistency)
- **Font Family**: System font stack (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, monospace`) — No custom font imports

### Color Palette
| Role | Color | Hex |
|------|-------|-----|
| Background | Dark Navy | #0f1117 |
| Card | Darker Navy | #1a1f2e |
| Border | Slate | #2d3748 |
| Text (Primary) | Light Gray | #f1f5f9 |
| Text (Secondary) | Muted Gray | #94a3b8 |
| Accent (Primary) | Blue | #3b82f6 |
| Success | Green | #10b981 |
| Warning | Amber | #f59e0b |
| Error | Red | #ef4444 |

**Consistency**: Well-applied throughout; no color clashes. Tailwind-adjacent palette.

### Interactive Feedback
- **Hover States**: All clickable elements (buttons, cards, nav links) have explicit transitions (0.12s–0.15s)
- **Focus States**: No visible `:focus-visible` styles in code (accessibility gap)
- **Loading States**: Spinner animations (0.65s–0.7s rotation) + opacity changes
- **Confirmation**: Modal dialogs for destructive actions (delete, purge); text input required for "PURGE"

### Accessibility
**Strengths**:
- Semantic HTML (buttons, forms, role attributes)
- ARIA labels on modals + interactive regions
- Keyboard navigation in ProjectSelector (arrow keys, enter, escape)
- Color + icon/text for status (not color-only)

**Gaps**:
- No `alt` text on SVG icons (logo, arrows, search, chevrons)
- No `aria-label` on standalone icons
- No `:focus-visible` styles (keyboard users won't see focus rings)
- Modal backdrop has no `inert` attribute (could improve focus trapping)
- No skip links (header is sticky, nav is always visible, so less critical)

### Responsiveness
- **Breakpoints**: No explicit media queries in audit scope
- **Grid Layouts**: Use `auto-fill` and `minmax()` for fluid responsive behavior
- **Modal Widths**: `min(520px, 92vw)` — good mobile constraint
- **Overflow Handling**: Monospace paths use `word-break: break-all` (readable but ugly; consider `overflow-wrap: break-word`)

---

## 8. Operational Readiness

### What Works Well
1. **Project Context Isolation**: Cookie-based switching is simple, fast, and persists across sessions
2. **Modal-Driven Admin**: Scan + Clean operations are modal-based, reducing page clutter
3. **Incremental Feedback**: Per-row action states (loading/success/error) provide clear UX
4. **Fallback Handling**: Graceful degradation when DBs unavailable (cards show "not found")
5. **Dry-Run Safety**: Clean operation defaults to dry-run; requires explicit confirmation for purge

### Operational Concerns
1. **No Bulk Operations**: Scaling to 100+ projects is painful (one-at-a-time reindex)
2. **Missing Health Diagnostics**: No detailed error logs or repair tools in UI
3. **Health Endpoint Drift**: Version string is hardcoded and incorrect
4. **No Audit Trail**: No logging of who/when/what for admin actions (backup/delete/reindex)
5. **Stale Detection**: 7-day threshold is hardcoded in component; no configuration option
6. **No Rate Limiting**: Spam-clicking "Re-Index" could hammer server

---

## 9. Recommendations (Out of Scope for This Audit)

### Quick Wins
1. Fix health endpoint version string to `2026.04.17` (or auto-derive from git tag)
2. Add `:focus-visible` styles to all interactive elements
3. Add `alt` + `aria-label` to SVG icons
4. Show time (not just date) in "Last Indexed" field
5. Add "Reindex All" button to toolbar (guards with confirmation)

### Medium-Term
1. Implement audit trail for admin actions (append-only log, accessible via API)
2. Add "Doctor" button to run `cleo nexus doctor` on unhealthy projects
3. Break down stale threshold into configuration (per-project or global setting)
4. Migrate hardcoded 7-day threshold to environment variable or DB config

### Long-Term
1. Build health & diagnostics dashboard separate from registry view
2. Implement bulk project management (multi-select, batch actions)
3. Add project tagging/filtering (team, status, SLA tier)
4. Expose DB schema version + migration status in health endpoint

---

## Summary

| Aspect | Status | Notes |
|--------|--------|-------|
| **Root Dashboard** | OK | Clear portal hub; good information scent; no dead weight |
| **Global Nav** | OK | 5 items + project selector; well-designed hierarchy |
| **Project Context** | OK | Cookie-based, simple, effective; isolation is solid |
| **Admin Page** | GOOD | Per-project actions well-organized; modal-driven; good UX feedback |
| **Health Endpoint** | DRIFT | Version string hardcoded + incorrect; otherwise functional |
| **Missing Ops** | GAP | Backup, doctor, migration, GC not exposed in UI (CLI-only) |
| **Design Consistency** | STRONG | Typography, color, spacing, responsive; accessibility gaps exist |
| **Operational Ready** | CAUTION | Scaling concerns; no bulk ops; missing diagnostics/audit trail |

**Verdict**: Studio provides a solid observability + light admin surface for small–medium projects. Operational constraints emerge at scale (100+ projects, frequent bulk operations). Health endpoint version drift is a low-priority fix.

---

**Generated**: 2026-04-17 | **Budget**: 5 minutes | **Lines of Code Audited**: ~2,500

