/**
 * Accessibility smoke test — WCAG 2.1 A/AA via axe-core + Playwright.
 *
 * Walks the five top-level Studio routes and fails the run on any
 * `critical` or `serious` violation. `minor` and `moderate` violations
 * are printed to the test log as warnings but do NOT fail the gate —
 * the Wave 0 brief sets the acceptance bar at serious+critical only so
 * the other waves can iterate without a flaky dependency.
 *
 * @task T990
 * @wave 0
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES: Array<{ name: string; path: string }> = [
  { name: 'dashboard', path: '/' },
  { name: 'brain', path: '/brain' },
  { name: 'code', path: '/code' },
  { name: 'tasks', path: '/tasks' },
  { name: 'projects', path: '/projects' },
];

for (const { name, path } of ROUTES) {
  test(`a11y: ${name} has no critical or serious violations`, async ({ page }, testInfo) => {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // Give SSR hydration + streaming loaders a moment to settle before we scan.
    await page.waitForLoadState('networkidle').catch(() => {
      // Some data loaders intentionally stream long — a 2s grace is enough.
    });

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const blocking = result.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    const warnings = result.violations.filter(
      (v) => v.impact === 'minor' || v.impact === 'moderate',
    );

    for (const v of warnings) {
      // Non-blocking — surfaces improvement backlog for future waves.
      testInfo.annotations.push({
        type: `a11y-warning:${v.impact ?? 'unknown'}`,
        description: `${v.id} — ${v.help} — nodes: ${v.nodes.length}`,
      });
    }

    if (blocking.length > 0) {
      const summary = blocking
        .map(
          (v) =>
            `[${v.impact}] ${v.id} — ${v.help}\n  ${v.helpUrl}\n  ${v.nodes.length} node(s)`,
        )
        .join('\n\n');
      expect(blocking, `Blocking a11y violations on ${path}:\n\n${summary}`).toEqual([]);
    }
  });
}
