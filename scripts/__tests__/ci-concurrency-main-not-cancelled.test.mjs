/**
 * gh#1362 / T12189 — main CI runs must not cancel each other.
 *
 * `github.ref` is `refs/heads/main` for every push to main, so a single
 * concurrency group covered all of them and each merge cancelled the run of the
 * commit before it. During a merge burst only the last commit was verified
 * against main; the intermediate ones sat on main with no main-tip result, and
 * a cancelled run looks exactly like a superseded one, so nothing reported it.
 *
 * WHAT THESE TESTS DO AND DO NOT ESTABLISH. GitHub evaluates the `${{ … }}`
 * expression, and that evaluation is not reproducible here — no assertion below
 * proves what GitHub computes. What they do pin is the STRUCTURE that carries
 * the fix, so the two properties it depends on cannot be silently removed:
 * `github.sha` participates in the group, and it does so only under a condition
 * that names main. The behavioural proof is the first merge burst after this
 * lands — two main commits, two runs, neither cancelled.
 *
 * @task T12189
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

describe('gh#1362 — CI concurrency', () => {
  it('still cancels in progress, because PR cancellation is correct and pays for itself', () => {
    // The defect is main-only. Removing cancellation everywhere would be a
    // regression wearing a bugfix's clothes: on a PR branch a new push really
    // does obsolete the previous run, and macOS allocation is the bottleneck
    // (gh#1351).
    expect(concurrency()['cancel-in-progress']).toBe(true);
  });

  it('puts every main commit in its own group by including the SHA', () => {
    expect(concurrency().group).toContain('github.sha');
  });

  it('includes the SHA ONLY under a condition naming main, so no other event changes', () => {
    const group = concurrency().group;
    // Every occurrence of github.sha must sit in an expression that also tests
    // the ref against refs/heads/main. A bare `github.sha` would give PRs a
    // per-commit group too and silently disable PR cancellation.
    const expressions = group.match(/\$\{\{[^}]*\}\}/g) ?? [];
    const withSha = expressions.filter((e) => e.includes('github.sha'));
    expect(withSha.length).toBeGreaterThan(0);
    for (const expression of withSha) {
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
