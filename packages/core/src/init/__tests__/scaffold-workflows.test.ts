/**
 * Unit tests for the `cleo init --workflows` scaffolder primitive.
 *
 * Covers:
 *   - render: placeholders are substituted from `.cleo/release-config.json`
 *     + ADR-061 tool resolver fallbacks; unused {{...}} tokens are NOT
 *     present in the rendered output for the rendered template.
 *   - write: a fresh project gets `.github/workflows/release-prepare.yml`
 *     with `status='created'`.
 *   - idempotence: re-running with the same inputs produces
 *     `status='unchanged'` and does NOT touch the file.
 *   - force: when content drifts and `force=true`, the file is overwritten
 *     and an audit row lands in `.cleo/audit/init-workflows.jsonl`.
 *   - skipped: drift without `--force` yields `status='skipped'` and the
 *     existing file is preserved verbatim.
 *   - dry-run: no file is written; the rendered YAML is returned.
 *
 * @task T9531
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scaffoldWorkflows } from '../scaffold-workflows.js';

// ---------------------------------------------------------------------------
// Fixture template — a deliberately compact stand-in for
// release-prepare.yml.tmpl that touches every placeholder the prepare
// template uses. Keeping the fixture inline (instead of pointing at the
// real template) means the test asserts the *substitution algorithm*, not
// the byte-exact contents of the shipped template (which T9532 owns).
// ---------------------------------------------------------------------------

const FIXTURE_PREPARE_TMPL = `name: Release Prepare
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4.0
        with:
          node-version: '{{NODE_VERSION}}'
      - name: Install
        run: {{INSTALL_CMD}}
      - name: Lint
        run: {{LINT_CMD}}
      - name: Typecheck
        run: {{TYPECHECK_CMD}}
      - name: Test
        run: {{TEST_CMD}}
      - name: Build
        run: {{BUILD_CMD}}
  prepare:
    needs: preflight
    runs-on: ubuntu-latest
    steps:
      - name: Cut release branch
        run: |
          BRANCH="{{BRANCH_PREFIX}}/\${{ inputs.version }}"
          git checkout -b "$BRANCH"
      - name: Open bump-PR
        run: gh pr create --label "{{PR_LABEL}}"
`;

/**
 * Build an isolated temp directory containing:
 *   - a fixture templates dir with one `release-prepare.yml.tmpl` file.
 *   - a fixture project dir with `.cleo/project-context.json`
 *     (primaryType=node) and optional `.cleo/release-config.json`.
 *
 * Returns absolute paths to both. Each test gets its own temp prefix so
 * runs are parallel-safe.
 */
async function makeFixture(opts?: {
  releaseConfig?: Record<string, unknown>;
  projectContext?: Record<string, unknown>;
}): Promise<{
  projectRoot: string;
  templatesDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-scaffold-workflows-'));
  const projectRoot = join(root, 'project');
  const templatesDir = join(root, 'templates');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
  await mkdir(templatesDir, { recursive: true });

  // Write the fixture template.
  await writeFile(join(templatesDir, 'release-prepare.yml.tmpl'), FIXTURE_PREPARE_TMPL, 'utf-8');

  // Project context (controls ADR-061 tool resolver defaults).
  const ctx = opts?.projectContext ?? {
    schemaVersion: '1.0.0',
    primaryType: 'node',
  };
  await writeFile(
    join(projectRoot, '.cleo', 'project-context.json'),
    JSON.stringify(ctx, null, 2),
    'utf-8',
  );

  // Optional release-config.json override.
  if (opts?.releaseConfig !== undefined) {
    await writeFile(
      join(projectRoot, '.cleo', 'release-config.json'),
      JSON.stringify(opts.releaseConfig, null, 2),
      'utf-8',
    );
  }

  return { projectRoot, templatesDir };
}

describe('scaffoldWorkflows (T9531)', () => {
  let cwdBefore: string;

  beforeEach(() => {
    cwdBefore = process.cwd();
  });
  afterEach(() => {
    process.chdir(cwdBefore);
  });

  // ---- render --------------------------------------------------------------

  it('substitutes every placeholder using release-config + ADR-061 defaults', async () => {
    const { projectRoot, templatesDir } = await makeFixture({
      releaseConfig: {
        nodeVersion: '20.x',
        releaseBranchPrefix: 'rel',
        prLabel: 'release-pr',
      },
    });

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0];
    if (!outcome) throw new Error('expected one outcome');

    // release-config.json overrides.
    expect(outcome.rendered).toContain("node-version: '20.x'");
    expect(outcome.rendered).toContain('BRANCH="rel/');
    expect(outcome.rendered).toContain('--label "release-pr"');

    // ADR-061 hard-coded fallbacks (since release-config has no installCmd
    // and project-context.json carries no testing/build override, the
    // resolver falls through to `npm`/`npx` defaults — we just assert
    // *some* substitution happened).
    expect(outcome.rendered).not.toMatch(/\{\{NODE_VERSION\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{INSTALL_CMD\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{LINT_CMD\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{TYPECHECK_CMD\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{TEST_CMD\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{BUILD_CMD\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{BRANCH_PREFIX\}\}/);
    expect(outcome.rendered).not.toMatch(/\{\{PR_LABEL\}\}/);
  });

  it('falls back to defaults when no release-config.json is present', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    const outcome = result.outcomes[0];
    if (!outcome) throw new Error('expected one outcome');

    // Default node version (22.x) and default branch/label prefixes.
    expect(outcome.rendered).toContain("node-version: '22.x'");
    expect(outcome.rendered).toContain('BRANCH="release/');
    expect(outcome.rendered).toContain('--label "release"');
    expect(result.resolvedTools.install).toBe('pnpm install --frozen-lockfile');
  });

  it('resolvedTools matches what the substitution pass emitted', async () => {
    const { projectRoot, templatesDir } = await makeFixture({
      projectContext: {
        schemaVersion: '1.0.0',
        primaryType: 'node',
        testing: { command: 'pnpm vitest run' },
        build: { command: 'pnpm run build:fast' },
      },
    });

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    expect(result.resolvedTools.test).toBe('pnpm vitest run');
    expect(result.resolvedTools.build).toBe('pnpm run build:fast');

    const outcome = result.outcomes[0];
    if (!outcome) throw new Error('expected one outcome');
    expect(outcome.rendered).toContain('run: pnpm vitest run');
    expect(outcome.rendered).toContain('run: pnpm run build:fast');
  });

  // ---- write + idempotence -------------------------------------------------

  it('creates .github/workflows/release-prepare.yml on first run', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    const result = await scaffoldWorkflows({ projectRoot, templatesDir });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.status).toBe('created');

    const written = await readFile(
      join(projectRoot, '.github', 'workflows', 'release-prepare.yml'),
      'utf-8',
    );
    expect(written).toBe(result.outcomes[0]?.rendered);
  });

  it('is idempotent: re-running with the same config returns unchanged', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    const first = await scaffoldWorkflows({ projectRoot, templatesDir });
    expect(first.outcomes[0]?.status).toBe('created');

    const second = await scaffoldWorkflows({ projectRoot, templatesDir });
    expect(second.outcomes[0]?.status).toBe('unchanged');
  });

  // ---- skipped + force -----------------------------------------------------

  it('returns skipped when content drifts and force is false', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    // Pre-create a drifted workflow file.
    await mkdir(join(projectRoot, '.github', 'workflows'), { recursive: true });
    const targetPath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await writeFile(targetPath, 'name: stale handcrafted yaml\n', 'utf-8');

    const result = await scaffoldWorkflows({ projectRoot, templatesDir });
    expect(result.outcomes[0]?.status).toBe('skipped');

    // The drifted file must NOT have been overwritten.
    const after = await readFile(targetPath, 'utf-8');
    expect(after).toBe('name: stale handcrafted yaml\n');
  });

  it('overwrites and audit-logs when force=true', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    await mkdir(join(projectRoot, '.github', 'workflows'), { recursive: true });
    const targetPath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await writeFile(targetPath, 'name: stale\n', 'utf-8');

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      force: true,
    });
    expect(result.outcomes[0]?.status).toBe('updated');

    const after = await readFile(targetPath, 'utf-8');
    expect(after).toBe(result.outcomes[0]?.rendered);

    // Audit-log row present.
    const auditPath = join(projectRoot, '.cleo', 'audit', 'init-workflows.jsonl');
    const auditContents = await readFile(auditPath, 'utf-8');
    const lines = auditContents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0] as string);
    expect(row.operation).toBe('workflow-overwrite');
    expect(row.template).toBe('release-prepare');
    expect(row.targetPath).toBe(targetPath);
    expect(row.reason).toBe('force');
  });

  // ---- dry-run -------------------------------------------------------------

  it('dry-run does NOT write the file', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });
    expect(result.outcomes[0]?.status).toBe('dry-run');
    expect(result.outcomes[0]?.rendered.length).toBeGreaterThan(0);

    const targetPath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await expect(readFile(targetPath, 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  // ---- override --------------------------------------------------------

  it('honours releaseConfigOverride without touching the filesystem', async () => {
    const { projectRoot, templatesDir } = await makeFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
      releaseConfigOverride: {
        nodeVersion: '21.x',
        releaseBranchPrefix: 'cut',
        prLabel: 'rel',
      },
    });

    expect(result.outcomes[0]?.rendered).toContain("node-version: '21.x'");
    expect(result.outcomes[0]?.rendered).toContain('BRANCH="cut/');
    expect(result.outcomes[0]?.rendered).toContain('--label "rel"');
  });
});
