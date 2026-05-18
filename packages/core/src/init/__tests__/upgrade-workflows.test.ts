/**
 * Unit tests for the `cleo upgrade workflows` SDK primitive (T9536).
 *
 * Coverage:
 *   - unchanged:       re-rendering produces the same byte-equal output
 *                      already on disk.
 *   - missing:         the on-disk file is absent (drift, but distinct
 *                      from `drift-detected`).
 *   - drift-detected:  rendered output differs and no override applies.
 *   - override-kept:   rendered output differs but `.workflow-overrides.yml`
 *                      declares an entry for the template.
 *   - updated + audit: `force=true` overwrites the drifted file and
 *                      lands an audit row.
 *   - hasDrift flag:   `--check`-style exit contract is reflected on
 *                      the envelope.
 *   - parseOverridesYamlBody: minimal top-level-key parser.
 *
 * @task T9536
 * @epic T9497
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scaffoldWorkflows, type WorkflowName } from '../scaffold-workflows.js';
import { parseOverridesYamlBody, upgradeWorkflows } from '../upgrade-workflows.js';

const FIXTURE_PREPARE_TMPL = `name: prepare
on: { workflow_dispatch: {} }
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: '{{NODE_VERSION}}' }
      - run: {{INSTALL_CMD}}
      - run: |
          BRANCH="{{BRANCH_PREFIX}}/x"
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
    runs-on: ubuntu-latest
    steps:
      - run: {{DOCS_BUILD_CMD}}
      - run: echo "{{ENABLE_DOCS_DEPLOY}} {{ENABLE_DOCKER_RETAG}} {{ENABLE_SENTINEL_NOTIFY}} {{ENABLE_STUDIO_DEPLOY}} {{ENABLE_NIGHTLY_TRIGGER}}"
      - run: echo "{{DOCKER_IMAGE}} {{DOCKER_HUB_USER}} {{SENTINEL_WEBHOOK_URL}} {{STUDIO_DEPLOY_HOOK}}"
`;

const FIXTURE_ROLLBACK_TMPL = `name: rollback
on: { workflow_dispatch: {} }
jobs:
  deprecate:
    runs-on: ubuntu-latest
    steps:
      - run: echo "publishers={{PUBLISHERS}} npm={{NPM_PACKAGES}} cargo={{CARGO_CRATES}}"
      - run: {{NPM_PUBLISH_CMD}}
`;

interface FixturePaths {
  projectRoot: string;
  templatesDir: string;
}

/**
 * Build a fixture with all four template files. The project is fresh
 * (no `.github/workflows/` files yet) — individual tests bootstrap
 * those via `scaffoldWorkflows` if they want an "in-sync" starting
 * state.
 */
async function makeUpgradeFixture(): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-upgrade-workflows-'));
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

describe('upgradeWorkflows (T9536)', () => {
  it('reports `missing` for every template on a fresh project', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();

    const result = await upgradeWorkflows({ projectRoot, templatesDir });

    expect(result.outcomes).toHaveLength(4);
    for (const o of result.outcomes) {
      expect(o.status).toBe('missing');
      expect(o.existing).toBeNull();
    }
    expect(result.hasDrift).toBe(true);
  });

  it('reports `unchanged` after a fresh scaffold (round-trip)', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    // Bootstrap the workflows so the on-disk state matches the rendered
    // output byte-for-byte.
    await scaffoldWorkflows({ projectRoot, templatesDir });

    const result = await upgradeWorkflows({ projectRoot, templatesDir });

    expect(result.outcomes).toHaveLength(4);
    for (const o of result.outcomes) {
      expect(o.status).toBe('unchanged');
      expect(o.existing).toBe(o.rendered);
    }
    expect(result.hasDrift).toBe(false);
  });

  it('reports `drift-detected` when the on-disk file diverges', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    await scaffoldWorkflows({ projectRoot, templatesDir });

    // Hand-tweak release-prepare.yml so it no longer matches the
    // re-render.
    const preparePath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    const original = await readFile(preparePath, 'utf-8');
    await writeFile(preparePath, `${original}\n# hand-edited tail\n`, 'utf-8');

    const result = await upgradeWorkflows({ projectRoot, templatesDir });

    const prepareOutcome = result.outcomes.find((o) => o.template === 'release-prepare');
    expect(prepareOutcome).toBeDefined();
    expect(prepareOutcome?.status).toBe('drift-detected');
    expect(result.hasDrift).toBe(true);

    // No write should have happened — the drifted content is preserved.
    const after = await readFile(preparePath, 'utf-8');
    expect(after).toContain('# hand-edited tail');
  });

  it('reports `override-kept` when `.workflow-overrides.yml` declares the template', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    await scaffoldWorkflows({ projectRoot, templatesDir });

    // Drift the file.
    const preparePath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await writeFile(preparePath, 'name: operator-owned\n', 'utf-8');

    // Declare an override.
    await writeFile(
      join(projectRoot, '.workflow-overrides.yml'),
      'release-prepare:\n  jobs:\n    preflight:\n      env:\n        EXTRA: "true"\n',
      'utf-8',
    );

    const result = await upgradeWorkflows({ projectRoot, templatesDir });

    const prepareOutcome = result.outcomes.find((o) => o.template === 'release-prepare');
    expect(prepareOutcome?.status).toBe('override-kept');
    expect(prepareOutcome?.overrideDeclared).toBe(true);

    // hasDrift must stay false — override-kept is operator-declared, not
    // implicit drift.
    expect(result.hasDrift).toBe(false);

    // Drifted file preserved verbatim.
    const after = await readFile(preparePath, 'utf-8');
    expect(after).toBe('name: operator-owned\n');
  });

  it('overwrites + audit-logs when force=true and drift has no override', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    await scaffoldWorkflows({ projectRoot, templatesDir });

    const preparePath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await writeFile(preparePath, 'name: stale\n', 'utf-8');

    const result = await upgradeWorkflows({
      projectRoot,
      templatesDir,
      force: true,
    });

    const prepareOutcome = result.outcomes.find((o) => o.template === 'release-prepare');
    expect(prepareOutcome?.status).toBe('updated');

    // File was overwritten with the rendered output.
    const after = await readFile(preparePath, 'utf-8');
    expect(after).toBe(prepareOutcome?.rendered);

    // Audit row landed.
    const auditPath = join(projectRoot, '.cleo', 'audit', 'upgrade-workflows.jsonl');
    const auditContents = await readFile(auditPath, 'utf-8');
    const lines = auditContents.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const row = JSON.parse(lines[0] as string);
    expect(row.operation).toBe('workflow-upgrade');
    expect(row.template).toBe('release-prepare');
    expect(row.reason).toBe('force');
  });

  it('dry-run never writes, never flips hasDrift, and carries renders', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    await scaffoldWorkflows({ projectRoot, templatesDir });

    const preparePath = join(projectRoot, '.github', 'workflows', 'release-prepare.yml');
    await writeFile(preparePath, 'name: stale\n', 'utf-8');

    const result = await upgradeWorkflows({
      projectRoot,
      templatesDir,
      dryRun: true,
    });

    for (const o of result.outcomes) {
      expect(o.status).toBe('dry-run');
      expect(o.rendered.length).toBeGreaterThan(0);
    }
    // hasDrift is NOT computed under dry-run — the caller is expected to
    // run a non-dry-run pass for the exit-code contract.
    expect(result.hasDrift).toBe(false);

    // Pre-tweaked file is preserved.
    const after = await readFile(preparePath, 'utf-8');
    expect(after).toBe('name: stale\n');
  });

  it('honours overridesOverride without touching .workflow-overrides.yml on disk', async () => {
    const { projectRoot, templatesDir } = await makeUpgradeFixture();
    await scaffoldWorkflows({ projectRoot, templatesDir });

    // Drift fanout.
    const fanoutPath = join(projectRoot, '.github', 'workflows', 'release-fanout.yml');
    await writeFile(fanoutPath, 'name: operator-fanout\n', 'utf-8');

    const result = await upgradeWorkflows({
      projectRoot,
      templatesDir,
      overridesOverride: { 'release-fanout': true },
    });

    const fanoutOutcome = result.outcomes.find(
      (o: { template: WorkflowName }) => o.template === 'release-fanout',
    );
    expect(fanoutOutcome?.status).toBe('override-kept');
  });
});

describe('parseOverridesYamlBody (T9536)', () => {
  it('extracts top-level canonical template keys', () => {
    const body = [
      'release-prepare:',
      '  jobs:',
      '    preflight:',
      '      env: { X: "1" }',
      'release-publish:',
      '  jobs: {}',
      '# release-fanout: ignored — commented',
      'release-rollback:',
      '  jobs: {}',
    ].join('\n');

    const parsed = parseOverridesYamlBody(body);
    expect(parsed['release-prepare']).toBe(true);
    expect(parsed['release-publish']).toBe(true);
    expect(parsed['release-rollback']).toBe(true);
    expect(parsed['release-fanout']).toBeUndefined();
  });

  it('ignores nested keys with the same shape', () => {
    const body = [
      'release-prepare:',
      '  release-publish: { still-nested: true }',
      '  jobs: {}',
    ].join('\n');

    const parsed = parseOverridesYamlBody(body);
    expect(parsed['release-prepare']).toBe(true);
    expect(parsed['release-publish']).toBeUndefined();
  });

  it('returns an empty object on an empty body', () => {
    expect(parseOverridesYamlBody('')).toEqual({});
    expect(parseOverridesYamlBody('# only comments\n')).toEqual({});
  });
});
