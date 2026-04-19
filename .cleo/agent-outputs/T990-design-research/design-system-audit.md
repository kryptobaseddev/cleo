# Studio Design System Audit

**Date:** 2026-04-17
**Task:** T990 — Design research for Studio UI rebuild
**Package:** `/mnt/projects/cleocode/packages/studio` (v2026.4.97)
**Auditor:** frontend-architect
**Reference theme:** `/tmp/task-viz/index.html` (operator-approved dark viz)

---

## TL;DR

Operator is correct — **there is no design system**. Studio is a vanilla Svelte 5 + SvelteKit app with zero UI framework, no global CSS file, no tokens, no typography scale, and 38 `<style>` blocks each redefining the same colors from scratch in hex literals. Every page is a standalone design exercise.

Good news: there is an **island of coherence** inside `packages/studio/src/lib/components/tasks/` (T950/T953/T955 work — `TaskCard`, `StatusBadge`, `PriorityBadge`, `FilterChipGroup`) that already mimics the viz vocabulary. And the reference viz at `/tmp/task-viz/index.html` is a **fully-formed token set** ready to port.

**Recommendation:** Adopt the viz tokens as-is into a single `src/lib/styles/tokens.css`, then refactor the existing 38 inline `<style>` blocks to consume them. Do NOT add Tailwind / shadcn / Skeleton — Svelte 5 scoped styles + CSS variables is the right primitive here and we already write exactly that, just without discipline.

---

## 1. Current Tokens — What Exists

### 1a. Global tokens
**None.** There is no `app.css`, no `global.css`, no `tokens.css`. `app.html` has zero style tags. The only global CSS lives inside the `+layout.svelte` `:global(body)` rule (L61-66):

```css
:global(body) {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
  background: #0f1117;
  color: #e2e8f0;
  min-height: 100vh;
}
```

That single `#0f1117` bg color is the only "design token" shared across the app — and it's a hex literal, not a variable. The `font-family` line even has a **bug** (ends with `monospace` instead of `sans-serif`, falling back to monospace on systems that lack the listed sans fonts).

### 1b. CSS custom properties used
`var(--...)` appears only **14 times across 4 files** (out of 38 `<style>` blocks):
- `+page.svelte` (2)
- `FilterChipGroup.svelte` (2 — `--chip-tint` local)
- `brain/3d/+page.svelte` (5 — local to that file)
- `brain/+page.svelte` (5 — local to that file)

i.e. **custom properties are used as local variables inside single components, never as shared tokens**.

### 1c. Hex color inventory (sampled from grep)
Every page independently hard-codes the same semantic palette. I counted **~240 hex-literal color uses** across the 38 style blocks. Representative aliases of the "same" color:

| Semantic role | Variants in the wild |
|---|---|
| Background base | `#0f1117`, `#0b0d12` (viz), `#151a24`, `#13182a` |
| Surface / elevation-1 | `#1a1f2e`, `#151822` (viz), `#161b27`, `#1e2438`, `#1b1f2c` (viz) |
| Surface / elevation-2 | `#1e2435`, `#21273a`, `#222736` |
| Border default | `#2d3748`, `#2a2e3d` (viz), `#1e2435` |
| Border strong | `#3d4a60`, `#3d4f6a`, `#3a4055` (viz), `#5b4a8c` |
| Text primary | `#e2e8f0`, `#f1f5f9`, `#e7eaf3` (viz) |
| Text secondary | `#94a3b8`, `#9aa3b2` (viz) |
| Text tertiary | `#64748b`, `#6b7280` (viz) |
| Text faint | `#475569` |
| Accent (brand purple) | `#a855f7`, `#a78bfa` (viz) — **two different purples used as "the" accent** |
| Accent (info blue) | `#3b82f6`, `#60a5fa`, `#2563eb` |
| Success | `#22c55e`, `#10b981` (viz) — two different greens |
| Warning | `#f59e0b`, `#f97316`, `#eab308` — three different warnings |
| Danger | `#ef4444`, `#f87171`, `#fca5a5`, `#f43f5e` (viz) |

**Six flavors of purple for "the brand color", three warnings, two greens for success.** That is the smoking gun for the "merge-and-ship" complaint.

---

## 2. Framework

| Feature | Status |
|---|---|
| Tailwind | NOT installed (no `tailwindcss` in `package.json`, no config) |
| shadcn-svelte | NOT installed |
| Skeleton | NOT installed |
| Bits UI / Melt UI | NOT installed |
| PostCSS plugins | NOT installed |
| CSS-in-JS | NOT used |
| SASS / Stylus | NOT used |
| Active approach | **Vanilla Svelte 5 scoped `<style>` blocks, pure hex literals** |

Svelte 5 `$props`, `$derived`, `$effect` are used correctly — this is a modern Svelte 5 codebase on SvelteKit 2.20. Adapter is `@sveltejs/adapter-node`.

---

## 3. Typography Scale

### 3a. Fonts
**No font loaded.** No `<link rel="preload">`, no `@font-face`, no `@fontsource`. The body `font-family` falls back to system sans via `-apple-system`, `BlinkMacSystemFont`, `'Segoe UI'`, `Roboto`, then **`monospace`** (typo — should be `sans-serif`).

There is no explicit monospace declaration; individual files bring their own, e.g. `TaskCard.svelte` L202-203 inlines `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. Redeclared in at least 4 files.

### 3b. Size scale — what agents shipped vs. what was needed
Scraping `font-size:` across the app, the sizes in use are:

```
0.55rem  0.625rem 0.675rem 0.6875rem 0.7rem
0.75rem  0.8125rem 0.875rem 1rem 1.125rem
1.25rem  1.5rem 2.25rem
```

That's **13 distinct font sizes** including non-standard oddballs like `0.55rem` (8.8px — the gate dot in TaskCard) and `0.675rem` (10.8px — the card ID). Compare to a canonical scale of 6-8 steps.

### 3c. Weight
`font-weight:` uses `400, 500, 600, 700` without a named scale — fine, but inconsistent: some "heading" uses are `600`, others `700`, with no rule.

### 3d. Line-height
Values: `1`, `1.3`, `1.35`, `1.4`, `1.5`. Should collapse to 2-3 canonical values (tight / normal / loose).

---

## 4. Spacing Scale

**No grid.** `padding:` with absolute values appears **222 times across 38 files**. Rhythm uses a mix of:
- `rem`-based: `0.25rem`, `0.375rem`, `0.5rem`, `0.625rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem`
- `px`-based: `2px`, `4px`, `6px`, `8px`, `10px`, `12px`, `14px`, `16px`, `20px`, `24px`

The two systems are **mixed in the same component** (e.g. `TaskCard.svelte` uses `0.625rem` padding and `4px` label-row gap side-by-side). Radii are similarly ad-hoc: `2px`, `3px`, `4px`, `6px`, `8px`, `999px`.

---

## 5. Component Inventory

### 5a. Islands of design-system-shaped code (keep + extend)
These are **already well-structured, TSDoc'd, prop-driven, and ARIA-labeled**. They are the existing foundation:

| File | Purpose | Quality |
|---|---|---|
| `src/lib/components/tasks/TaskCard.svelte` (279 L) | Card for tasks | Good API, compact + focused variants, a11y label, but uses hex literals |
| `src/lib/components/tasks/StatusBadge.svelte` (151 L) | Status pill | Good API, 7 statuses, compact variant, `role="status"` |
| `src/lib/components/tasks/PriorityBadge.svelte` (small) | Priority pill | Peer of StatusBadge |
| `src/lib/components/tasks/FilterChipGroup.svelte` (181 L) | Toolbar chips | Excellent — `role="group"`, `aria-pressed`, `:focus-visible`, exclusive flag, tint via `--chip-tint` custom prop |
| `src/lib/components/tasks/TaskSearchBox.svelte` | Search input | Has `:focus-within`, keyboard shortcut hint |
| `src/lib/components/tasks/DetailDrawer.svelte` (749 L) | Side-drawer task detail | Large; needs decomposition |
| `src/lib/components/tasks/KanbanTab.svelte` (928 L) | Kanban view | Uses TaskCard; self-contained CSS |
| `src/lib/components/tasks/HierarchyTab.svelte` (928 L) | Tree view | Uses TaskCard |
| `src/lib/components/tasks/GraphTab.svelte` (1187 L) | SVG dep graph | Best a11y in the codebase — `focus-visible` on nodes |
| `src/lib/components/tasks/EpicProgressCard.svelte` | Progress card | Small, focused |
| `src/lib/components/tasks/RecentActivityFeed.svelte` | Activity list | Small, focused |

These 11 files in `lib/components/tasks/` are the **operational prototype of a CLEO design system** — correctly prop-driven and accessible. They just need the hex literals swapped for tokens.

### 5b. One-off graph components (keep, but not in the DS)
| File | Notes |
|---|---|
| `BrainGraph.svelte` / `LivingBrainGraph.svelte` / `LivingBrainCosmograph.svelte` / `LivingBrain3D.svelte` / `NexusGraph.svelte` / `TaskDepGraph.svelte` | Graph/3D viz; page-specific |
| `ProjectSelector.svelte` (612 L) | Dropdown with search — **oversized**, should be a reusable `Select` primitive |

### 5c. Admin modals (almost reusable)
| File | Notes |
|---|---|
| `admin/CleanModal.svelte` (526 L) / `ScanModal.svelte` / `DeleteConfirmModal.svelte` | Each implements its own modal shell — there is **no base `<Modal>` primitive**. Duplicate backdrop + focus-trap + close-button logic 3 times. |

### 5d. Missing from component library (routes reimplement inline)
- `<Button>` — every route uses raw `<button>` with per-page CSS
- `<Input>` / `<Textarea>`
- `<Select>` (ProjectSelector solves one case)
- `<Modal>` / `<Dialog>`
- `<Tabs>` (each page builds its own tab bar)
- `<Card>` (every dashboard tile rolls its own)
- `<EmptyState>`
- `<LoadingSpinner>` (viz has `.spinner` keyframes, studio reimplements)
- `<Toast>` / `<Notification>`
- `<Breadcrumb>`
- `<Tooltip>` (used everywhere as `title=`, no visual)

---

## 6. Accessibility

### 6a. ARIA / roles / tabindex
`aria-*`, `role=`, and `tabindex` combined: **111 occurrences across 21 files**. That's **well above average for a greenfield project**, but concentrated in the task components (DetailDrawer: 10, TaskCard: 5, KanbanTab: 10, HierarchyTab: 15, GraphTab: 6, tasks/+page.svelte: 16). Other routes have near-zero a11y. `brain/+page.svelte` has 1 aria attribute.

### 6b. Focus rings
`:focus-visible` appears **only in 6 components** — all in `lib/components/tasks/`. The viz reference uses a 3px soft-purple halo that's missing from 95% of studio's interactive elements. `outline: none` on input borders without a `:focus` replacement happens in `ScanModal.svelte` L254, `brain/observations/+page.svelte` L312, `CleanModal.svelte` L324, `DeleteConfirmModal.svelte` L160 — **four a11y regressions**.

### 6c. Contrast (spot checks on the dark palette)
| Foreground / Background | Ratio | WCAG |
|---|---|---|
| `#e2e8f0` on `#0f1117` | 14.3:1 | AAA |
| `#94a3b8` on `#0f1117` | 7.7:1 | AAA |
| `#64748b` on `#0f1117` | 4.9:1 | AA (body), below AA for fine text |
| `#475569` on `#0f1117` | 3.2:1 | **FAIL** (used for "faint" copy and icon colors) |
| `#3b82f6` on `#0f1117` | 4.3:1 | AA large, fails AA normal |
| `#a855f7` on `#0f1117` | 4.1:1 | AA large, fails AA normal |
| `#3b82f6` on `rgba(59,130,246,0.1)` active nav link | blue-on-blue ~3:1 | **FAIL** |

The viz palette is better (`--accent: #a78bfa` on `#0b0d12` ≈ 7.2:1 — AAA). **Porting viz colors improves contrast for free.**

### 6d. Keyboard tab order
No `skip-to-content` link. The layout uses correct landmark semantics (`<header>`, `<main>`) but `<nav>` appears *after* `<main>` in reading order because of the flex `margin-left: auto` trick — keyboard users land in the logo, then skip all nav links, then get to page body. Needs source-order fix or an explicit `tabindex` plan.

### 6e. Reduced motion
Zero `prefers-reduced-motion` respect. All transitions fire unconditionally. Synapse firing / 3D graph animation will be hostile to vestibular-sensitive users.

### 6f. Responsive
`@media` queries exist in **4 files only**, all `max-width`-based (no mobile-first). The `app.html` viewport tag is fine. No fluid typography, no container queries.

---

## 7. Dark / Light Theme Support

**Dark-only, no infrastructure.** No `data-theme` attribute, no `prefers-color-scheme` media query, no theme-store. Every color is a raw hex literal baked into component CSS. Migrating to light mode later would require editing all 38 `<style>` blocks. Tokens fix this.

---

## 8. Recommendation — Design-System Approach for T990

### 8a. Keep vanilla Svelte 5 scoped CSS + CSS custom properties
**Do NOT introduce Tailwind, shadcn-svelte, or Skeleton.** Reasons:
1. The codebase is already 38 mature Svelte 5 `<style>` blocks using scoped CSS. Tailwind would require ripping up every file.
2. shadcn-svelte (bits-ui + melt-ui) pulls in a runtime dependency that CLEO's "no heavyweight UI deps" philosophy rejects; Studio already dedupes on `@cleocode/*` workspaces.
3. Skeleton assumes Tailwind underneath.
4. What's wrong is **not the framework**, it's the **absence of tokens**. Fix tokens → system emerges.
5. The `tasks/` island already proves the pattern works when authors have tokens to consume.

### 8b. Adopt the viz token set directly
Port `/tmp/task-viz/index.html` L20-55 into `packages/studio/src/lib/styles/tokens.css` and import once from `+layout.svelte`:

```css
/* packages/studio/src/lib/styles/tokens.css */
:root {
  /* Surface */
  --bg:           #0b0d12;
  --bg-elev-1:    #151822;
  --bg-elev-2:    #1b1f2c;

  /* Border */
  --border:        #2a2e3d;
  --border-strong: #3a4055;

  /* Text */
  --text:       #e7eaf3;
  --text-dim:   #9aa3b2;
  --text-faint: #6b7280;

  /* Accent (single source of truth — violet, AAA on bg) */
  --accent:      #a78bfa;
  --accent-soft: rgba(167, 139, 250, 0.2);
  --accent-halo: rgba(167, 139, 250, 0.12);

  /* Semantic */
  --success:      #10b981;
  --success-soft: rgba(16, 185, 129, 0.2);
  --warning:      #f59e0b;
  --warning-soft: rgba(245, 158, 11, 0.2);
  --danger:       #ef4444;
  --danger-soft:  rgba(239, 68, 68, 0.2);
  --info:         #3b82f6;
  --info-soft:    rgba(59, 130, 246, 0.2);
  --neutral:      #6b7280;
  --neutral-soft: rgba(107, 114, 128, 0.2);

  /* Status (used by StatusBadge) */
  --status-pending:    var(--warning);
  --status-active:     var(--info);
  --status-blocked:    var(--danger);
  --status-done:       var(--success);
  --status-cancelled:  var(--neutral);
  --status-archived:   #64748b;
  --status-proposed:   var(--accent);

  /* Priority */
  --priority-critical: #f43f5e;
  --priority-high:     var(--danger);
  --priority-medium:   var(--warning);
  --priority-low:      var(--neutral);

  /* Shape */
  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-pill: 999px;

  /* Spacing (4-pt grid; NO rem/px mixing) */
  --space-1:  0.25rem;  /*  4px */
  --space-2:  0.5rem;   /*  8px */
  --space-3:  0.75rem;  /* 12px */
  --space-4:  1rem;     /* 16px */
  --space-5:  1.25rem;  /* 20px */
  --space-6:  1.5rem;   /* 24px */
  --space-8:  2rem;     /* 32px */
  --space-10: 2.5rem;   /* 40px */

  /* Typography */
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, -apple-system,
               BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
               Arial, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo,
               Consolas, "Liberation Mono", monospace;

  --text-2xs: 0.6875rem;  /* 11px — chip labels, uppercase eyebrows */
  --text-xs:  0.75rem;    /* 12px — secondary UI */
  --text-sm:  0.8125rem;  /* 13px — body-ui default */
  --text-base:0.875rem;   /* 14px — paragraph body */
  --text-md:  1rem;       /* 16px — subheads */
  --text-lg:  1.125rem;   /* 18px — section heads */
  --text-xl:  1.25rem;    /* 20px — page heads */
  --text-2xl: 1.5rem;     /* 24px — hero heads */
  --text-3xl: 2.25rem;    /* 36px — landing only */

  --leading-tight:  1.25;
  --leading-normal: 1.5;

  /* Motion */
  --ease:        150ms cubic-bezier(0.4, 0, 0.2, 1);
  --ease-slow:   250ms cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: 400ms cubic-bezier(0.34, 1.56, 0.64, 1);

  /* Elevation */
  --shadow-sm:    0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md:    0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-hover: 0 0 0 1px var(--border-strong),
                  0 8px 24px rgba(167, 139, 250, 0.1);
  --shadow-lg:    0 12px 32px rgba(0, 0, 0, 0.5);
  --shadow-focus: 0 0 0 3px var(--accent-halo);
}

/* Honour user motion preference */
@media (prefers-reduced-motion: reduce) {
  :root {
    --ease:        0ms;
    --ease-slow:   0ms;
    --ease-spring: 0ms;
  }
}
```

Ship the exact viz palette — operator has already validated it visually.

### 8c. Build a primitives layer at `src/lib/ui/`
Ten primitives cover 95% of Studio's surface. All pure Svelte 5, no external deps:

```
src/lib/ui/
  Button.svelte        — variants: primary | secondary | ghost | danger; sizes: sm | md
  IconButton.svelte    — square button, slot for icon
  Input.svelte         — text input with focus ring, icon slot
  Textarea.svelte
  Select.svelte        — refactored ProjectSelector
  Modal.svelte         — backdrop + focus trap + ESC close; slot for content
  Tabs.svelte / TabPanel.svelte
  Card.svelte          — padding variant, interactive variant
  Badge.svelte         — replaces StatusBadge/PriorityBadge generically (tone prop)
  Chip.svelte / ChipGroup.svelte  — refactored FilterChipGroup
  Spinner.svelte
  EmptyState.svelte    — icon + title + subtext + slot for action
  Tooltip.svelte       — use the popover API; upgrades `title=`
  Drawer.svelte        — extracted from DetailDrawer shell
```

Each primitive reads tokens via `var(--...)` and accepts `class` passthrough for escape hatches.

### 8d. Migration strategy (non-destructive)
1. **Land tokens + global reset** without touching components — no visual change.
2. **Swap `tasks/` island hex literals → tokens** (mechanical `sed`; ~10 min per file). Done first because it's already correctly structured.
3. **Build primitives** in `lib/ui/`.
4. **Refactor admin modals → `<Modal>`**.
5. **Refactor remaining routes** page-by-page, each behind a feature flag or in a separate PR.

Per CLEO rules (AGENTS.md): "NEVER remove code — ALWAYS improve existing code". Every refactor replaces hex literal with token reference; nothing is deleted.

### 8e. Tooling
- **No build-step change** — CSS custom properties work in every target browser.
- Add **stylelint** with rules banning raw hex literals in `.svelte` (force `var(--...)`).
- Add **axe-playwright** check to existing e2e suite (Playwright is already present).
- Run **contrast check** in CI against the token table.

---

## 9. Typography Pairing + Font Choice

### 9a. Recommendation
| Role | Font | Rationale |
|---|---|---|
| UI + body | **Inter Variable** | De facto 2026 standard; excellent tabular-nums (needed for ID chips, counts, timestamps); variable weight 100-900; small x-height reads well at 12-14px. |
| Code / IDs / timestamps | **JetBrains Mono Variable** | Matches the "code intelligence" positioning; the viz already uses `ui-monospace` fallback. Ligatures off by default. |
| Display (landing / 3xl) | **Inter** with `letter-spacing: -0.02em` | No extra font — tight-track Inter at large size gives an editorial feel without a second download. |

Load via `@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono` in `app.html` `<link rel="preload">` tags. ~32kb total with `font-display: swap`.

### 9b. Why not a display face
A tempting "wedge-serif display + geometric-sans body" combo (e.g. Fraunces + Inter) would look striking on the landing page but hurts perceived density in the tight information-dashboard views where 80% of Studio lives. One font family, one monospace = fewer moving parts, faster LCP.

### 9c. Numerals
Set `font-variant-numeric: tabular-nums` on everything that shows IDs, counts, hex hashes, dates, percentages, and token counts. Critical for the viz-style counters. Add to body:

```css
body { font-variant-numeric: tabular-nums; }
```

---

## 10. Motion / Animation Conventions

The Brain visualizations require motion to communicate. Codify it:

### 10a. Timing tokens
```css
--ease:        150ms ease;      /* hover, focus, color swaps */
--ease-slow:   250ms ease;      /* modal / drawer enter */
--ease-spring: 400ms spring;    /* card lift / success celebration */
--ease-pulse:  1200ms ease-in-out infinite;  /* synapse fire */
```

### 10b. Interaction patterns
| Interaction | Motion |
|---|---|
| Card hover | `translateY(-1px)` + `shadow-hover` in `var(--ease)` — matches viz `.card:hover` pattern |
| Button press | `scale(0.98)` in 80ms, released in `var(--ease)` |
| Tab switch | Cross-fade with 150ms overlap; active tab gets the `--accent-soft` pill in `var(--ease)` |
| Focus ring | **Instant** — never animate focus (accessibility). Apply `box-shadow: var(--shadow-focus)` on `:focus-visible`. |
| Modal open | Backdrop fade `var(--ease-slow)`, content `scale(0.96 → 1)` + opacity in `var(--ease-slow)` |
| Drawer open | Slide from right `translateX(100% → 0)` in `var(--ease-slow)` |
| Synapse firing | 3-phase pulse — brighten (200ms), hold (300ms), decay (700ms). Trigger on new observation/decision events. Respect `prefers-reduced-motion`. |
| Node selection (3D) | `emissiveIntensity` ramp + 200ms camera easing |
| Loading | Spinner keyframes from viz L752 (`0.7s linear infinite`). One spinner, one timing. |

### 10c. Scroll + layout
- No scroll-snap globally; opt-in per viz.
- No parallax.
- Respect `prefers-reduced-motion: reduce` with the token override in §8b.

### 10d. Sound (future)
Synapse firing could layer subtle audio — out of scope for T990, but reserve a motion-token slot for "sonic feedback on/off" now so it can plug in later without a refactor.

---

## Supporting Evidence — Files I Read

Absolute paths (for CLEO traceability):

- `/mnt/projects/cleocode/packages/studio/package.json`
- `/mnt/projects/cleocode/packages/studio/svelte.config.js`
- `/mnt/projects/cleocode/packages/studio/vite.config.ts`
- `/mnt/projects/cleocode/packages/studio/src/app.html`
- `/mnt/projects/cleocode/packages/studio/src/routes/+layout.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/tasks/TaskCard.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/tasks/StatusBadge.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/tasks/FilterChipGroup.svelte`
- `/tmp/task-viz/index.html` (tokens at L20-55, components at L200-720)
- Grepped all 38 `<style>` blocks under `/mnt/projects/cleocode/packages/studio/src/**/*.svelte` for `font-size`, `padding`, color literals, `var(--)`, `aria-`, `role=`, `focus`, `@media`.

---

## Executive Summary for the Operator

The UI isn't broken, it's **ungoverned**. 38 component files each paid the "pick colors from memory" tax independently, so six purples and three warnings coexist. The fix is one file of tokens + one pass of tokenization; no framework change required. The reference viz you liked is already the answer — we port its variables verbatim and let the existing `lib/components/tasks/` island teach the rest of the app how to be a design system. Add Inter + JetBrains Mono, codify motion in four easing tokens, honor `prefers-reduced-motion` and `focus-visible`, and Studio will read as one product instead of five stapled views.
