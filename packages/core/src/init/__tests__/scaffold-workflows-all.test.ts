/**
 * Unit tests for T9536 — `cleo init --workflows` defaults to the full
 * four-template set (`release-prepare`, `release-publish`,
 * `release-fanout`, `release-rollback`).
 *
 * Coverage:
 *   - default templates: omitting `templates` renders all four files.
 *   - explicit subset:    passing a subset still works (back-compat for
 *                         T9531 single-template behaviour).
 *   - DEFAULT_WORKFLOW_TEMPLATES: exported constant matches the four
 *                                 canonical names in expected order.
 *   - real templates:    rendering the shipped `*.yml.tmpl` files leaves
 *                        no `{{...}}` placeholders behind (smoke test —
 *                        full actionlint integration belongs to a
 *                        separate Phase 4 integration test).
 *
 * @task T9536
 * @epic T9497
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKFLOW_TEMPLATES,
  scaffoldWorkflows,
  type WorkflowName,
} from '../scaffold-workflows.js';

// ---------------------------------------------------------------------------
// Fixture templates — minimal inline stand-ins for the four `*.yml.tmpl`
// files. Each fixture touches the placeholders its real counterpart uses
// (per packages/cleo/templates/workflows/README.md) so the substitution
// pass is exercised end-to-end without depending on the byte-exact
// contents of the shipped templates.
// ---------------------------------------------------------------------------

const FIXTURE_PREPARE_TMPL = `name: prepare
on:
  workflow_dispatch:
    inputs: { version: { type: string, required: true } }
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: '{{NODE_VERSION}}' }
      - run: {{INSTALL_CMD}}
      - run: {{LINT_CMD}}
      - run: {{TYPECHECK_CMD}}
      - run: {{TEST_CMD}}
      - run: {{BUILD_CMD}}
      - run: |
          BRANCH="{{BRANCH_PREFIX}}/\${{ inputs.version }}"
          gh pr create --label "{{PR_LABEL}}"
`;

const FIXTURE_PUBLISH_TMPL = `name: publish
on: { push: { branches: [main] } }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: '{{NODE_VERSION}}' }
      - run: {{INSTALL_CMD}}
      - run: {{TEST_CMD}}
      - run: {{BUILD_CMD}}
      - run: {{NPM_PUBLISH_CMD}}
      - run: echo "publishers={{PUBLISHERS}}"
`;

const FIXTURE_FANOUT_TMPL = `name: fanout
on: { release: { types: [published] } }
jobs:
  docs:
    if: \${{ {{ENABLE_DOCS_DEPLOY}} }}
    runs-on: ubuntu-latest
    steps:
      - run: {{DOCS_BUILD_CMD}}
  docker:
    if: \${{ {{ENABLE_DOCKER_RETAG}} }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "image={{DOCKER_IMAGE}} user={{DOCKER_HUB_USER}}"
  sentinel:
    if: \${{ {{ENABLE_SENTINEL_NOTIFY}} }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "url={{SENTINEL_WEBHOOK_URL}}"
  studio:
    if: \${{ {{ENABLE_STUDIO_DEPLOY}} }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "hook={{STUDIO_DEPLOY_HOOK}}"
  nightly:
    if: \${{ {{ENABLE_NIGHTLY_TRIGGER}} }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "nightly"
`;

const FIXTURE_ROLLBACK_TMPL = `name: rollback
on:
  workflow_dispatch:
    inputs:
      version: { type: string, required: true }
      mode: { type: choice, options: [metadata-only, full], required: true }
jobs:
  deprecate:
    runs-on: ubuntu-latest
    steps:
      - run: echo "publishers={{PUBLISHERS}}"
      - run: echo "npm packages={{NPM_PACKAGES}}"
      - run: echo "cargo crates={{CARGO_CRATES}}"
      - run: {{NPM_PUBLISH_CMD}}
`;

interface FixturePaths {
  projectRoot: string;
  templatesDir: string;
}

/**
 * Build an isolated temp directory containing all four fixture
 * templates plus a minimal `.cleo/project-context.json`.
 */
async function makeFullFixture(): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-scaffold-workflows-all-'));
  const projectRoot = join(root, 'project');
  const templatesDir = join(root, 'templates');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
  await mkdir(templatesDir, { recursive: true });

  await writeFile(join(templatesDir, 'release-prepare.yml.tmpl'), FIXTURE_PREPARE_TMPL, 'utf-8');
  await writeFile(join(templatesDir, 'release-publish.yml.tmpl'), FIXTURE_PUBLISH_TMPL, 'utf-8');
  await writeFile(join(templatesDir, 'release-fanout.yml.tmpl'), FIXTURE_FANOUT_TMPL, 'utf-8');
  await writeFile(join(templatesDir, 'release-rollback.yml.tmpl'), FIXTURE_ROLLBACK_TMPL, 'utf-8');

  await writeFile(
    join(projectRoot, '.cleo', 'project-context.json'),
    JSON.stringify({ schemaVersion: '1.0.0', primaryType: 'node' }, null, 2),
    'utf-8',
  );

  return { projectRoot, templatesDir };
}

describe('scaffoldWorkflows defaults — full four-template set (T9536)', () => {
  it('DEFAULT_WORKFLOW_TEMPLATES exports the four canonical names in order', () => {
    expect(DEFAULT_WORKFLOW_TEMPLATES).toEqual([
      'release-prepare',
      'release-publish',
      'release-fanout',
      'release-rollback',
    ]);
  });

  it('renders all four templates when `templates` is omitted', async () => {
    const { projectRoot, templatesDir } = await makeFullFixture();

    const result = await scaffoldWorkflows({ projectRoot, templatesDir });

    expect(result.outcomes).toHaveLength(4);
    const names = result.outcomes.map((o) => o.template);
    expect(names).toEqual([
      'release-prepare',
      'release-publish',
      'release-fanout',
      'release-rollback',
    ]);
    // Every outcome was created on a fresh filesystem.
    for (const o of result.outcomes) {
      expect(o.status).toBe('created');
    }

    // Files exist with the rendered content.
    for (const o of result.outcomes) {
      const onDisk = await readFile(o.targetPath, 'utf-8');
      expect(onDisk).toBe(o.rendered);
    }
  });

  it('honours an explicit single-template subset (T9531 back-compat)', async () => {
    const { projectRoot, templatesDir } = await makeFullFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      templates: ['release-prepare'],
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.template).toBe('release-prepare');
  });

  it('substitutes every placeholder across all four templates', async () => {
    const { projectRoot, templatesDir } = await makeFullFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    expect(result.outcomes).toHaveLength(4);
    for (const o of result.outcomes) {
      // No raw {{NAME}} tokens should remain in the rendered output.
      expect(o.rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(o.rendered.length).toBeGreaterThan(0);
    }
  });

  it('idempotence: re-running with the same fixture returns all `unchanged`', async () => {
    const { projectRoot, templatesDir } = await makeFullFixture();

    const first = await scaffoldWorkflows({ projectRoot, templatesDir });
    expect(first.outcomes.every((o) => o.status === 'created')).toBe(true);

    const second = await scaffoldWorkflows({ projectRoot, templatesDir });
    expect(second.outcomes).toHaveLength(4);
    for (const o of second.outcomes) {
      expect(o.status).toBe('unchanged');
    }
  });

  it('dry-run: every outcome carries a non-empty rendered body without writing', async () => {
    const { projectRoot, templatesDir } = await makeFullFixture();

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    expect(result.outcomes).toHaveLength(4);
    for (const o of result.outcomes) {
      expect(o.status).toBe('dry-run');
      expect(o.rendered.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke test against the REAL shipped templates — guards against template
// drift that would leave a {{...}} placeholder behind in the rendered
// output. Full `actionlint` integration is deferred to a separate Phase 4
// integration suite (R-261).
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `packages/cleo/templates/workflows/` from
 * this test file. Walks the directory tree without depending on the
 * package layout (works in both monorepo dev + dist builds).
 */
function resolveRealTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = packages/core/src/init/__tests__   (in source)
  //      = packages/core/dist/init/__tests__  (after esbuild emit)
  // From either anchor, "up" four levels lands at packages/core/, and
  // "../cleo/templates/workflows" is the target.
  return resolve(here, '..', '..', '..', '..', 'cleo', 'templates', 'workflows');
}

describe('scaffoldWorkflows against the real shipped templates (T9536 smoke)', () => {
  it('renders all four real templates without leaving placeholder tokens', async () => {
    const templatesDir = resolveRealTemplatesDir();

    // Fresh project dir so no on-disk drift influences the outcome.
    const projectRoot = await mkdtemp(join(tmpdir(), 'cleo-real-tmpl-'));
    await mkdir(join(projectRoot, '.cleo'), { recursive: true });
    await writeFile(
      join(projectRoot, '.cleo', 'project-context.json'),
      JSON.stringify({ schemaVersion: '1.0.0', primaryType: 'node' }, null, 2),
      'utf-8',
    );

    const result = await scaffoldWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    expect(result.outcomes).toHaveLength(4);

    const names: WorkflowName[] = result.outcomes.map((o) => o.template);
    expect(new Set(names)).toEqual(
      new Set(['release-prepare', 'release-publish', 'release-fanout', 'release-rollback']),
    );

    for (const o of result.outcomes) {
      // No {{PLACEHOLDER}} tokens should remain.
      expect(o.rendered, `template ${o.template} had unsubstituted placeholders`).not.toMatch(
        /\{\{[A-Z_]+\}\}/,
      );
      // YAML "name:" front-matter should survive rendering.
      expect(o.rendered).toMatch(/^name:\s+/m);
    }
  });
});
