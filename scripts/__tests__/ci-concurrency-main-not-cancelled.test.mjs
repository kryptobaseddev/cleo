/**
 * gh#1362 / T12189, revised by T14103 (D11209) — main CI keeps the run it is
 * verifying and drops runs still queued for commits main has moved past.
 *
 * T12189 gave every main commit its own concurrency group (keyed by
 * `github.sha`) so a merge could never cancel the previous commit's run
 * mid-flight. That also ran every commit of a merge burst in full. T14103
 * puts main back in one group per event with `cancel-in-progress: false`:
 * GitHub then lets the running run finish, keeps at most one pending run,
 * and cancels an older pending run when a newer push arrives. PRs keep
 * `cancel-in-progress: true` in their per-ref group.
 *
 * WHAT THESE TESTS DO AND DO NOT ESTABLISH. GitHub evaluates the `${{ … }}`
 * expressions, and that evaluation is not reproducible here. What they pin is
 * the STRUCTURE that carries the rule: no per-commit key in the group, the
 * event-name join on main, and cancellation that is conditional on the ref
 * not being main. That a merge whose queued run was cancelled still resolves
 * `ci:` evidence through the newest green main run is proved in
 * `packages/core/src/release/__tests__/ci-evidence.test.ts` (T14103).
 *
 * @task T12189
 * @task T14103
 * @epic T12111 (E-EVIDENCE-PIPELINE)
 * @see https://github.com/kryptobaseddev/cleo/issues/1362
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const CI = '.github/workflows/ci.yml';

/** The parsed `concurrency:` block of the CI workflow. */
function concurrency() {
  const doc = parseYaml(readFileSync(CI, 'utf8'));
  return doc.concurrency;
}

describe('gh#1362 / T14103 — CI concurrency', () => {
  it('cancels in progress only off main, so a running main run is never cancelled', () => {
    // On a PR branch a new push really does obsolete the previous run. On main
    // `false` keeps the running run and lets GitHub cancel only the queued one.
    const cancel = concurrency()['cancel-in-progress'];
    expect(typeof cancel).toBe('string');
    expect(cancel.replace(/\s+/g, ' ')).toMatch(/^\$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/);
  });

  it('shares one main group across commits, so a newer push replaces a queued older run', () => {
    // A per-commit key (the T12189 design) would give every main commit its own
    // group, and no queued run for a superseded commit would ever be dropped.
    const group = concurrency().group;
    expect(group).not.toContain('github.sha');
    expect(group).not.toContain('github.run_id');
  });

  it('keys main by event name ONLY under a condition naming main, so schedule and push never collide', () => {
    const group = concurrency().group;
    const expressions = group.match(/\$\{\{[^}]*\}\}/g) ?? [];
    const withEvent = expressions.filter((e) => e.includes('github.event_name'));
    expect(withEvent.length).toBeGreaterThan(0);
    for (const expression of withEvent) {
      expect(expression).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it('keeps the workflow and the ref in the group so unrelated workflows never collide', () => {
    const group = concurrency().group;
    expect(group).toContain('github.workflow');
    expect(group).toContain('github.ref');
  });

  it('leaves the merge-bar aggregate expression untouched', () => {
    // `lint-merge-bar-aggregate.mjs` matches the literal `needs.*.result`; a
    // reflow of this file that broke it would fail silently, since the script
    // reports on the jobs it CAN see.
    // Regex, not a literal: the `${{ … }}` form trips biome's
    // noTemplateCurlyInString inside a plain JS string.
    expect(readFileSync(CI, 'utf8')).toMatch(/RESULTS: \$\{\{ join\(needs\.\*\.result, ','\) \}\}/);
  });
});
