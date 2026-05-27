/**
 * Snapshot test for the release-prepare.yml.tmpl workflow template (T9532).
 *
 * Renders the template with a sample placeholder set and compares against a
 * checked-in snapshot at __snapshots__/release-prepare.yml.snap. If
 * `actionlint` is available on PATH, the rendered output is also fed through
 * actionlint to catch syntax errors that snapshot diffing alone misses.
 *
 * @task T9532
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  'templates',
  'workflows',
  'release-prepare.yml.tmpl',
);

/**
 * Minimal template renderer for `{{UPPER_SNAKE_CASE}}` placeholders.
 *
 * Performs a single deterministic regex substitution pass. Mirrors what the
 * T9531 `cleo init --workflows` scaffolder is required to do — see
 * workflows/README.md "Template contract".
 *
 * @param template Raw template source.
 * @param values   Map from placeholder name (without braces) to substitution.
 * @returns Rendered string with all placeholders replaced.
 */
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{([A-Z_]+)}}/g, (_match, name: string) => {
    if (!(name in values)) {
      throw new Error(`renderTemplate: missing value for {{${name}}}`);
    }
    return values[name]!;
  });
}

/**
 * Sample placeholder set used to render the snapshot. Mirrors what the
 * scaffolder would derive from a typical pnpm/Node monorepo via ADR-061.
 */
const SAMPLE_VALUES: Record<string, string> = {
  NODE_VERSION: '22.x',
  INSTALL_CMD: 'pnpm install --frozen-lockfile',
  LINT_CMD: 'pnpm biome ci .',
  TYPECHECK_CMD: 'pnpm run typecheck',
  TEST_CMD: 'pnpm run test',
  BUILD_CMD: 'pnpm run build',
  BRANCH_PREFIX: 'release',
  PR_LABEL: 'release',
};

describe('release-prepare.yml.tmpl', () => {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');

  it('contains every required placeholder', () => {
    const found = new Set<string>();
    for (const m of raw.matchAll(/{{([A-Z_]+)}}/g)) {
      found.add(m[1]!);
    }
    for (const key of Object.keys(SAMPLE_VALUES)) {
      expect(found, `expected placeholder {{${key}}} in template`).toContain(key);
    }
  });

  it('declares mandatory RFC2119 invariants from SPEC §5.1', () => {
    // R-200: workflow_dispatch only — MUST NOT have push trigger.
    expect(raw).toMatch(/^\s*on:\s*$/m);
    expect(raw).toMatch(/workflow_dispatch:/);
    expect(raw).not.toMatch(/\n\s*push:\s*\n/);

    // R-201: required inputs.
    expect(raw).toMatch(/version:/);
    expect(raw).toMatch(/plan-blob-sha256:/);

    // R-202: required permissions, no `packages: write` in the actual
    // permissions block. Strip comment lines (anything starting with #) and
    // then assert against the live YAML body so doc-comments mentioning
    // "MUST NOT request packages:write" don't trip the negative match.
    const nonComment = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(nonComment).toMatch(/contents:\s*write/);
    expect(nonComment).toMatch(/pull-requests:\s*write/);
    expect(nonComment).toMatch(/id-token:\s*write/);
    expect(nonComment).not.toMatch(/packages:\s*write/);

    // R-203: preflight + prepare jobs in order.
    const preflightIdx = raw.indexOf('preflight:');
    const prepareIdx = raw.indexOf('prepare:');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(prepareIdx).toBeGreaterThan(preflightIdx);
    expect(raw).toMatch(/needs:\s*preflight/);

    // R-207: concurrency group keyed on version, cancel-in-progress: false.
    expect(raw).toMatch(/group:\s*release-prepare-\$\{\{\s*inputs\.version\s*\}\}/);
    expect(raw).toMatch(/cancel-in-progress:\s*false/);

    // R-206: every job and every step has a timeout-minutes.
    expect(raw).toMatch(/timeout-minutes:\s*20/);

    // R-262: defaults.run.shell: bash.
    expect(raw).toMatch(/defaults:\s*\n\s*run:\s*\n\s*shell:\s*bash/);

    // R-209: failure path deletes branch + prints recovery command.
    expect(raw).toMatch(/cleanup-on-failure:/);
    expect(raw).toMatch(/git push origin --delete/);
    expect(raw).toMatch(/Recovery:\s*cleo release plan/);
  });

  it('pins third-party Actions to major+minor (R-263)', () => {
    // Capture every `uses:` ref and assert no `@main`, `@master`, `@latest`,
    // or bare-major (`@v4` without a minor) reference slips in.
    const usesRefs = [...raw.matchAll(/uses:\s*([^\s\n]+)/g)].map((m) => m[1]!);
    expect(usesRefs.length).toBeGreaterThan(0);
    for (const ref of usesRefs) {
      expect(ref, `pinned third-party Action: ${ref}`).not.toMatch(/@(main|master|latest)$/);
      // Must be major+minor: `name@vX.Y` (e.g. `actions/checkout@v4.1`).
      expect(ref, `${ref} must pin to major+minor`).toMatch(/@v\d+\.\d+$/);
    }
  });

  it('renders deterministically and matches the checked-in snapshot', async () => {
    const rendered = renderTemplate(raw, SAMPLE_VALUES);

    // No unsubstituted placeholders left.
    expect(rendered).not.toMatch(/{{[A-Z_]+}}/);

    // Rendered output has the sample values inlined where expected.
    expect(rendered).toContain('node-version: \'22.x\'');
    expect(rendered).toContain('pnpm install --frozen-lockfile');
    expect(rendered).toContain('pnpm biome ci .');
    expect(rendered).toContain('release/${{ inputs.version }}');

    await expect(rendered).toMatchFileSnapshot(
      './__snapshots__/release-prepare.yml.snap',
    );
  });

  it('throws on missing placeholder values', () => {
    expect(() =>
      renderTemplate('hello {{UNKNOWN_KEY}}', { OTHER: 'x' }),
    ).toThrow(/UNKNOWN_KEY/);
  });
});

/**
 * Optional actionlint gate (R-260). Skipped when `actionlint` is not on
 * PATH so the test suite remains runnable in environments without it (e.g.
 * sparse worker pods). CI is responsible for installing actionlint and
 * exercising this code path — see SPEC AC-8.
 */
function hasActionlint(): boolean {
  try {
    execSync('command -v actionlint', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const ACTIONLINT_DESCRIBE = hasActionlint() ? describe : describe.skip;

ACTIONLINT_DESCRIBE('release-prepare.yml.tmpl actionlint gate', () => {
  it('passes actionlint on the rendered output', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf8');
    const rendered = renderTemplate(raw, SAMPLE_VALUES);
    // `actionlint -` reads from stdin.
    expect(() =>
      execSync('actionlint -', {
        input: rendered,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).not.toThrow();
  });
});
