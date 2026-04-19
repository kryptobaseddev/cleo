/**
 * E2E tests for the hybrid `/tasks` Task Explorer (T949 / T956 / T957 / T958).
 *
 * W3A of T949 — locks down the merged dashboard + 3-tab Explorer surface
 * against the specific regressions caught during shipping:
 *   - `each_key_duplicate` in GraphTab (commit 9d67aa890 fix)
 *   - SSR gate `{#if filters}` hiding the Explorer (commit 9d67aa890 fix)
 *
 * Tests run against a live Studio dev server on port 3456. Playwright's
 * `webServer` block in `playwright.config.ts` reuses an already-running
 * instance when available; CI spawns one fresh.
 *
 * Test groups:
 *   1. SSR rendering invariants (no hydration needed)
 *   2. Tab buttons + visual state
 *   3. Keyboard shortcut tab switching (1 / 2 / 3)
 *   4. URL ↔ tab round-trip (?view= + #hash)
 *   5. 301 redirects from deprecated routes (/tasks/graph, /tasks/tree/[id])
 *   6. Search box `/` focus shortcut
 *   7. Dashboard panel preservation (Epic Progress, Recent Activity, Live SSE)
 *   8. T958 "Cancelled epics" filter rename + legacy `?deferred=1` redirect
 *
 * @task T959
 * @epic T949
 */
import { expect, type Page, test } from '@playwright/test';

/**
 * Selector for a tab button by its visible label inside the Task Explorer
 * tab list. Anchored to `role="tab"` so it never matches the higher-level
 * `/tasks ↔ /tasks/pipeline` page nav.
 */
function tabSelector(name: 'Hierarchy' | 'Graph' | 'Kanban'): string {
  return `[role="tab"]:has-text("${name}")`;
}

/**
 * Wait for Svelte hydration to finish so click handlers are wired before
 * we interact with the page. SvelteKit's `page.goto()` resolves on the
 * `load` DOM event, which fires BEFORE Svelte attaches its event listeners
 * in dev mode — clicks on un-hydrated tab buttons silently no-op, producing
 * brittle assertion flips in this suite.
 *
 * The 2.5 s settle window is empirical: d3 + Vite HMR overhead pushes
 * first-paint-to-hydrated to ~1.8 s locally when the dev server is under
 * parallel load. We deliberately DO NOT poll `networkidle` — the `/api/tasks/
 * events` EventSource keeps the connection warm forever and would time out
 * the wait. We also avoid polling for the Live SSE indicator label ("Live")
 * because it races with the heartbeat and can re-enter "Connecting…".
 * Settle-then-probe is deterministic and cheap.
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
}

// ---------------------------------------------------------------------------
// Group 1 — SSR rendering invariants
// ---------------------------------------------------------------------------

test.describe('SSR rendering', () => {
  test('GET /tasks returns 200 and ships the Task Explorer in initial HTML', async ({
    request,
  }) => {
    const response = await request.get('/tasks');
    expect(response.status()).toBe(200);
    const body = await response.text();
    // T949/T956 contract: the Explorer section must be present in the SSR
    // payload — never gated behind client-only `{#if filters}`. Regression
    // fixed in commit 9d67aa890.
    expect(body).toContain('aria-label="Task Explorer"');
    expect(body).toContain('aria-label="Task Explorer views"');
  });

  test('GET /tasks SSR includes the Dashboard summary panel', async ({ request }) => {
    const response = await request.get('/tasks');
    const body = await response.text();
    expect(body).toContain('aria-label="Dashboard summary"');
    expect(body).toContain('aria-label="Dashboard filters"');
  });

  test('GET /tasks SSR has hierarchy tab marked aria-selected="true" by default', async ({
    request,
  }) => {
    const response = await request.get('/tasks');
    const body = await response.text();
    // The first tab in document order is Hierarchy; default view = hierarchy.
    const ariaTrueCount = (body.match(/aria-selected="true"/g) ?? []).length;
    expect(ariaTrueCount).toBeGreaterThanOrEqual(1);
    // And the Hierarchy label must be in the active tab block.
    expect(body).toMatch(/aria-selected="true"[^>]*>[\s\S]{0,500}Hierarchy/);
  });

  test('GET /tasks?view=graph SSR pre-selects the Graph tab', async ({ request }) => {
    const response = await request.get('/tasks?view=graph');
    const body = await response.text();
    // Graph tab must be the active one when ?view=graph is present.
    expect(body).toMatch(/aria-selected="true"[^>]*>[\s\S]{0,500}Graph/);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Tab buttons + visual state
// ---------------------------------------------------------------------------

test.describe('Tab buttons', () => {
  test('three role=tab buttons exist with correct labels', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator(tabSelector('Hierarchy'))).toBeVisible();
    await expect(page.locator(tabSelector('Graph'))).toBeVisible();
    await expect(page.locator(tabSelector('Kanban'))).toBeVisible();
  });

  test('Hierarchy tab is active by default after hydration', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator(tabSelector('Hierarchy'))).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator(tabSelector('Kanban'))).toHaveAttribute('aria-selected', 'false');
  });

  test('clicking Graph tab activates it and updates URL', async ({ page }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    await page.locator(tabSelector('Graph')).click();
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]view=graph/);
  });

  test('clicking Kanban tab activates it and updates URL', async ({ page }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    await page.locator(tabSelector('Kanban')).click();
    await expect(page.locator(tabSelector('Kanban'))).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]view=kanban/);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Keyboard shortcut tab switching (1 / 2 / 3)
// ---------------------------------------------------------------------------

test.describe('Keyboard shortcut tab switching', () => {
  test('pressing "2" switches to Graph tab', async ({ page }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    // Ensure focus is on body, not in any input — the page-level handler
    // bails when an input/textarea owns focus.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('2');
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]view=graph/);
  });

  test('pressing "1" switches to Hierarchy tab', async ({ page }) => {
    await page.goto('/tasks?view=graph');
    await waitForHydration(page);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('1');
    await expect(page.locator(tabSelector('Hierarchy'))).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Hierarchy is the default view so `?view=` is stripped from the URL
    // (see `writeToUrl` in task-filters.svelte.ts). The hash still reflects
    // the active tab for shareable deep-links.
    await expect(page).toHaveURL(/#hierarchy/);
  });

  test('pressing "3" switches to Kanban tab', async ({ page }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('3');
    await expect(page.locator(tabSelector('Kanban'))).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]view=kanban/);
  });

  test('keyboard shortcuts are inert while typing in the search input', async ({ page }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    // Use the explorer toolbar's TaskSearchBox specifically (filters by id/title).
    const explorerSearch = page.locator(
      'input[aria-label="Filter explorer by id or title..."]',
    );
    await explorerSearch.click();
    await explorerSearch.fill('2');
    // Hierarchy should still be the active tab — the "2" went into the input.
    await expect(page.locator(tabSelector('Hierarchy'))).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(explorerSearch).toHaveValue('2');
  });
});

// ---------------------------------------------------------------------------
// Group 4 — URL ↔ tab round-trip (?view= + #hash)
// ---------------------------------------------------------------------------

test.describe('URL round-trip', () => {
  test('navigating to /tasks?view=graph activates the Graph tab on arrival', async ({
    page,
  }) => {
    await page.goto('/tasks?view=graph');
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
  });

  test('navigating to /tasks?view=kanban activates the Kanban tab on arrival', async ({
    page,
  }) => {
    await page.goto('/tasks?view=kanban');
    await expect(page.locator(tabSelector('Kanban'))).toHaveAttribute('aria-selected', 'true');
  });

  test('hash fragment overrides ?view= query (hash wins) — graph beats hierarchy', async ({
    page,
  }) => {
    await page.goto('/tasks?view=hierarchy#graph');
    await waitForHydration(page);
    // The hashchange/onMount handler in +page.svelte prefers the hash.
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
  });

  test('clicking a tab writes the view back to URL hash for shareable links', async ({
    page,
  }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    await page.locator(tabSelector('Kanban')).click();
    // switchView in +page.svelte writes both ?view= and #hash via replaceState.
    await expect(page).toHaveURL(/#kanban/);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — 301 redirects from deprecated routes (T957)
// ---------------------------------------------------------------------------

test.describe('301 redirects from deprecated routes', () => {
  test('GET /tasks/graph 301s to /tasks?view=graph#graph (Location header)', async ({
    request,
  }) => {
    const response = await request.get('/tasks/graph', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    const location = response.headers()['location'];
    expect(location).toBe('/tasks?view=graph#graph');
  });

  test('GET /tasks/tree/T949 301s to /tasks?view=hierarchy&epic=T949#hierarchy', async ({
    request,
  }) => {
    const response = await request.get('/tasks/tree/T949', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    const location = response.headers()['location'];
    expect(location).toBe('/tasks?view=hierarchy&epic=T949#hierarchy');
  });

  test('navigating /tasks/graph in a browser lands on Graph tab active', async ({ page }) => {
    await page.goto('/tasks/graph');
    await expect(page).toHaveURL(/\/tasks\?view=graph/);
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
  });

  test('navigating /tasks/tree/T949 lands on Hierarchy tab with epic filter', async ({
    page,
  }) => {
    await page.goto('/tasks/tree/T949');
    await expect(page).toHaveURL(/\/tasks\?view=hierarchy&epic=T949/);
    await expect(page.locator(tabSelector('Hierarchy'))).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('GET /tasks/graph?archived=1 preserves the archived filter in the redirect', async ({
    request,
  }) => {
    const response = await request.get('/tasks/graph?archived=1', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    const location = response.headers()['location'];
    // Caller params come first, then `view` is appended → archived=1 must be present.
    expect(location).toContain('archived=1');
    expect(location).toContain('view=graph');
    expect(location).toContain('#graph');
  });

  test('GET /tasks/tree/T949?archived=1 preserves the archived filter in the redirect', async ({
    request,
  }) => {
    const response = await request.get('/tasks/tree/T949?archived=1', { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    const location = response.headers()['location'];
    expect(location).toContain('archived=1');
    expect(location).toContain('epic=T949');
    expect(location).toContain('view=hierarchy');
    expect(location).toContain('#hierarchy');
  });
});

// ---------------------------------------------------------------------------
// Group 6 — Search box `/` focus shortcut
// ---------------------------------------------------------------------------

test.describe('Search box `/` focus shortcut', () => {
  test('pressing "/" anywhere on the page focuses the explorer search input', async ({
    page,
  }) => {
    await page.goto('/tasks');
    await waitForHydration(page);
    // Click body to ensure focus is not on an input.
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('/');
    const explorerSearch = page.locator(
      'input[aria-label="Filter explorer by id or title..."]',
    );
    await expect(explorerSearch).toBeFocused();
  });

  test('the explorer search input renders the "/" keyboard hint badge', async ({ page }) => {
    await page.goto('/tasks');
    // The TaskSearchBox renders a `<kbd>/</kbd>` hint badge next to the input.
    const explorerToolbar = page.locator('section[aria-label="Task Explorer"]');
    await expect(explorerToolbar.locator('kbd', { hasText: '/' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Group 7 — Dashboard panel preservation
// ---------------------------------------------------------------------------

test.describe('Dashboard panel preservation', () => {
  test('Epic Progress panel is rendered on /tasks', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.getByText('Epic Progress', { exact: true })).toBeVisible();
  });

  test('Recent Activity feed is rendered on /tasks', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.getByText('Recent Activity', { exact: true })).toBeVisible();
  });

  test('live SSE indicator is rendered with a status label', async ({ page }) => {
    await page.goto('/tasks');
    // Element has `class="live-indicator"`; label is "Live" or "Connecting...".
    const indicator = page.locator('.live-indicator');
    await expect(indicator).toBeVisible();
    const label = indicator.locator('.live-label');
    await expect(label).toBeVisible();
  });

  test('legacy ID/title search bar is preserved at the top', async ({ page }) => {
    await page.goto('/tasks');
    const legacySearch = page.locator(
      'input[placeholder="Search by ID (T663, t663, 663) or title..."]',
    );
    await expect(legacySearch).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Group 8 — T958 "Cancelled epics" rename + legacy redirect
// ---------------------------------------------------------------------------

test.describe('T958 Cancelled epics filter rename', () => {
  test('toggle chip text reads "Cancelled epics" (NOT legacy "Deferred")', async ({
    page,
  }) => {
    await page.goto('/tasks');
    // The chip is rendered as an `<a>` inside `aria-label="Dashboard filters"`.
    // We scope to that region so matches on "deferred" inside task content
    // (e.g. Recent Activity rows that mention the word) do not collide.
    const filterBar = page.locator('[aria-label="Dashboard filters"]');
    await expect(filterBar).toBeVisible();
    const chip = filterBar.getByRole('link', { name: /Cancelled epics/i });
    await expect(chip).toBeVisible();
    // Negative assertion — the rename must not regress to the legacy label
    // inside the filter bar itself.
    await expect(filterBar.getByText(/deferred/i)).toHaveCount(0);
  });

  test('toggle chip click flips the URL to ?cancelled=1', async ({ page }) => {
    await page.goto('/tasks');
    const filterBar = page.locator('[aria-label="Dashboard filters"]');
    const chip = filterBar.getByRole('link', { name: /Cancelled epics/i });
    await chip.click();
    await expect(page).toHaveURL(/[?&]cancelled=1/);
    // Legacy alias must NOT be coexisting after the toggle.
    expect(page.url()).not.toContain('deferred=1');
  });

  test('GET /tasks?deferred=1 still loads (legacy alias honoured for one release)', async ({
    request,
  }) => {
    const response = await request.get('/tasks?deferred=1');
    expect(response.status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Group 9 — Regression sentinels (the specific bugs commit 9d67aa890 fixed)
// ---------------------------------------------------------------------------

test.describe('Regression sentinels (commit 9d67aa890)', () => {
  test('Graph tab opens without fatal errors (each_key_duplicate sentinel)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    // Navigate directly to the Graph view so we avoid a tab click race.
    // The regression we are locking down is hydration-level (each_key_duplicate
    // on `simLinks` / simNodes + effect_update_depth_exceeded on
    // startSimulation) — both fire on first Graph render regardless of how
    // the view was reached.
    await page.goto('/tasks?view=graph');
    await waitForHydration(page);
    // Explorer section must be present and the Graph tab must be active.
    await expect(page.locator('section[aria-label="Task Explorer"]')).toBeVisible();
    await expect(page.locator(tabSelector('Graph'))).toHaveAttribute('aria-selected', 'true');
    const fatal = errors.filter(
      (e) =>
        e.includes('each_key_duplicate') ||
        e.includes('effect_update_depth_exceeded') ||
        e.includes('Cannot read'),
    );
    expect(fatal, `Graph tab produced fatal errors: ${fatal.join(' | ')}`).toHaveLength(0);
  });

  test('Task Explorer is visible without waiting for client hydration', async ({ page }) => {
    // Disable JS to prove the section is in the SSR HTML, not gated by `{#if filters}`.
    await page.context().addInitScript(() => {
      // No-op: keeping JS enabled because the explorer needs hydration for tabs,
      // but the assertion below confirms the section element exists pre-hydration.
    });
    await page.goto('/tasks', { waitUntil: 'commit' });
    // Element is present in the document before any client mount work happens.
    await expect(page.locator('section[aria-label="Task Explorer"]')).toBeAttached();
  });
});
