/**
 * Snapshot test for the release-publish.yml.tmpl workflow template (T9533).
 *
 * Renders the template with a sample placeholder set and compares against a
 * checked-in snapshot at __snapshots__/release-publish.yml.snap. If
 * `actionlint` is available on PATH, the rendered output is also fed through
 * actionlint to catch syntax errors that snapshot diffing alone misses.
 *
 * @task T9533
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
  'release-publish.yml.tmpl',
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
  NPM_PUBLISH_CMD: 'pnpm publish -r --access public --tag latest',
  PUBLISHERS: 'npm cargo',
};

describe('release-publish.yml.tmpl', () => {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');

  // Strip comment lines (anything starting with #) to assert against the live
  // YAML body — doc-comments mentioning RFC2119 invariants don't trip
  // negative matches.
  const nonComment = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('contains every required placeholder', () => {
    const found = new Set<string>();
    for (const m of raw.matchAll(/{{([A-Z_]+)}}/g)) {
      found.add(m[1]!);
    }
    for (const key of Object.keys(SAMPLE_VALUES)) {
      expect(found, `expected placeholder {{${key}}} in template`).toContain(key);
    }
  });

  it('declares the trigger surface from SPEC §5.2 (R-220, R-221)', () => {
    // R-220: push: main with version-file paths filter.
    expect(nonComment).toMatch(/push:\s*\n\s*branches:\s*\n\s*-\s*main/);
    expect(nonComment).toMatch(/paths:/);
    expect(nonComment).toMatch(/'package\.json'/);
    expect(nonComment).toMatch(/'packages\/\*\/package\.json'/);
    expect(nonComment).toMatch(/'Cargo\.toml'/);
    expect(nonComment).toMatch(/'pyproject\.toml'/);

    // R-221: workflow_dispatch with `version` input.
    expect(nonComment).toMatch(/workflow_dispatch:/);
    expect(nonComment).toMatch(/version:\s*\n\s*description:/);
  });

  it('declares the permission surface from SPEC §5.2 (R-222)', () => {
    // R-222: workflow-level contents:write + id-token:write. No packages:write
    // at the top level — it is per-job on publish-and-tag only.
    const workflowPermsMatch = nonComment.match(
      /^permissions:\s*\n((?:\s{2,}.+\n?)+)/m,
    );
    expect(workflowPermsMatch, 'workflow-level permissions block').not.toBeNull();
    const workflowPerms = workflowPermsMatch?.[1] ?? '';
    expect(workflowPerms).toMatch(/contents:\s*write/);
    expect(workflowPerms).toMatch(/id-token:\s*write/);
    expect(workflowPerms).not.toMatch(/packages:\s*write/);

    // Per-job packages:write granted in publish-and-tag.
    const publishJobStart = nonComment.indexOf('publish-and-tag:');
    expect(publishJobStart).toBeGreaterThan(-1);
    const publishJobBody = nonComment.slice(publishJobStart);
    expect(publishJobBody).toMatch(/packages:\s*write/);
  });

  it('declares 4 jobs in the order detect → build-matrix → publish-and-tag → reconcile (R-223)', () => {
    const detectIdx = nonComment.indexOf('detect:');
    const buildMatrixIdx = nonComment.indexOf('build-matrix:');
    const publishIdx = nonComment.indexOf('publish-and-tag:');
    const reconcileIdx = nonComment.indexOf('reconcile:');
    expect(detectIdx).toBeGreaterThan(-1);
    expect(buildMatrixIdx).toBeGreaterThan(detectIdx);
    expect(publishIdx).toBeGreaterThan(buildMatrixIdx);
    expect(reconcileIdx).toBeGreaterThan(publishIdx);

    // Dependency edges enforce the order at runtime.
    expect(raw).toMatch(/needs:\s*detect/);
    // publish-and-tag needs detect + build-matrix
    expect(raw).toMatch(/needs:\s*\n\s*-\s*detect\s*\n\s*-\s*build-matrix/);
    // reconcile needs detect + publish-and-tag
    expect(raw).toMatch(/needs:\s*\n\s*-\s*detect\s*\n\s*-\s*publish-and-tag/);
  });

  it('classifies release commits via the canonical grep regex (R-224)', () => {
    // R-224: grep -E '^release: prepare v' against the commit-range subject.
    expect(raw).toMatch(/grep -E '\^release: prepare v'/);
    expect(raw).toMatch(/should_publish=true/);
    expect(raw).toMatch(/should_publish=false/);
    expect(raw).toMatch(/should_publish:\s*\$\{\{\s*steps\.classify\.outputs\.should_publish\s*\}\}/);
    expect(raw).toMatch(/version:\s*\$\{\{\s*steps\.classify\.outputs\.version\s*\}\}/);
  });

  it('expands build-matrix across all 5 T1737 platform tuples (R-225)', () => {
    expect(nonComment).toMatch(/platform:\s*linux-x64/);
    expect(nonComment).toMatch(/platform:\s*linux-arm64/);
    expect(nonComment).toMatch(/platform:\s*macos-x64/);
    expect(nonComment).toMatch(/platform:\s*macos-arm64/);
    expect(nonComment).toMatch(/platform:\s*windows-x64/);

    // R-225: integration smoke uses ./bin/cleo --version + briefing --json | jq .ok.
    expect(raw).toMatch(/\.\/bin\/cleo --version/);
    expect(raw).toMatch(/\.\/bin\/cleo briefing --json/);
    expect(raw).toMatch(/ANTHROPIC_API_KEY:/);
  });

  it('gates publish-and-tag behind environment: cleo-publish (R-226, R-235)', () => {
    expect(raw).toMatch(/environment:\s*cleo-publish/);
    // softprops/action-gh-release@v2 per R-226(e)
    expect(raw).toMatch(/softprops\/action-gh-release@v2\.\d+/);
    expect(raw).toMatch(/generate_release_notes:\s*true/);
    expect(raw).toMatch(/fail_on_unmatched_files:\s*true/);
  });

  it('enforces the F6-eliminating confirm-PR step BEFORE git tag (R-229)', () => {
    // R-229: confirm step polls gh pr view --json state,mergeCommit.
    expect(raw).toMatch(/gh pr view "?\$?PR_NUMBER"?\s+--json state,mergeCommit/);
    // Asserts state=MERGED.
    expect(raw).toMatch(/STATE.*!=.*"?MERGED"?/);
    // Asserts mergeCommit.oid == $GITHUB_SHA.
    expect(raw).toMatch(/MERGE_OID.*!=.*github\.sha/);
    // Failure mode is E_TAG_MISMATCH.
    expect(raw).toMatch(/E_TAG_MISMATCH/);

    // CRITICAL ordering: the confirm step MUST appear before the tag step.
    const confirmIdx = raw.indexOf('Confirm PR merge state');
    const tagStepMatch = raw.match(/-\s*name:\s*Tag release/);
    expect(confirmIdx).toBeGreaterThan(-1);
    expect(tagStepMatch).not.toBeNull();
    const tagIdx = raw.indexOf(tagStepMatch?.[0] ?? '');
    expect(tagIdx).toBeGreaterThan(confirmIdx);
  });

  it('makes reconcile non-blocking (R-227)', () => {
    // reconcile job has continue-on-error: true at the job level.
    const reconcileStart = nonComment.indexOf('reconcile:');
    expect(reconcileStart).toBeGreaterThan(-1);
    // Scope to reconcile job body (until end-of-file in this template).
    const reconcileBody = nonComment.slice(reconcileStart);
    expect(reconcileBody).toMatch(/continue-on-error:\s*true/);

    // Opens a provenance-backfill issue on failure.
    expect(raw).toMatch(/gh issue create/);
    expect(raw).toMatch(/Provenance backfill needed/);
    expect(raw).toMatch(/release-incident/);

    // Uses `cleo release reconcile <version> --from-workflow --json`.
    expect(raw).toMatch(/cleo release reconcile.*--from-workflow.*--json/);
  });

  it('enforces concurrency group + cancel-in-progress=false (R-230)', () => {
    expect(raw).toMatch(/group:\s*release-publish-\$\{\{\s*github\.sha\s*\}\}/);
    expect(raw).toMatch(/cancel-in-progress:\s*false/);
  });

  it('declares the secret surface from SPEC §5.2 (R-234)', () => {
    // R-234: GITHUB_TOKEN, NPM_TOKEN, ANTHROPIC_API_KEY required.
    expect(raw).toMatch(/secrets\.GITHUB_TOKEN/);
    expect(raw).toMatch(/secrets\.NPM_TOKEN/);
    expect(raw).toMatch(/secrets\.ANTHROPIC_API_KEY/);
    // Optional: CARGO_TOKEN.
    expect(raw).toMatch(/secrets\.CARGO_TOKEN/);
  });

  it('sets defaults.run.shell: bash (R-262)', () => {
    expect(raw).toMatch(/defaults:\s*\n\s*run:\s*\n\s*shell:\s*bash/);
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
    expect(rendered).toContain("node-version: '22.x'");
    expect(rendered).toContain('pnpm install --frozen-lockfile');
    expect(rendered).toContain('pnpm publish -r --access public --tag latest');
    // PUBLISHERS is hoisted into env so the `if:` becomes dynamic for
    // actionlint (constant-expression-in-condition warning otherwise).
    expect(rendered).toContain("PUBLISHERS: 'npm cargo'");
    expect(rendered).toContain("contains(env.PUBLISHERS, 'npm')");
    expect(rendered).toContain("contains(env.PUBLISHERS, 'cargo')");

    await expect(rendered).toMatchFileSnapshot(
      './__snapshots__/release-publish.yml.snap',
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

ACTIONLINT_DESCRIBE('release-publish.yml.tmpl actionlint gate', () => {
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
