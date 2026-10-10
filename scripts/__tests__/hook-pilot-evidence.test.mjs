/** Sanitized ephemeral transport/proof fixtures; never release acceptance data (T13350). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hookPilotEvidenceMain,
  implementationSourceDigest,
  validateHookPilotEvidence,
} from '../hook-pilot-evidence.mjs';

let root;
const VERSION = '2026.10.6-canary.1';
const VIDA = 'a'.repeat(40);
const REPO = 'kryptobaseddev/VidaPeps';
const CHECKS = [
  'packedArtifact',
  'publishedCanary',
  'readOnlyDev',
  'readOnlyProd',
  'liveClaude',
  'liveCodex',
  'hostedCi',
];

function write(path, value) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hook-pilot-unit-'));
  write('package.json', {
    name: 'fixture',
    version: VERSION,
    dependencies: { '@cleocode/core': VERSION, zod: '^4.3.6' },
  });
  write('packages/core/package.json', { name: '@cleocode/core', version: VERSION });
  write('packages/core/src/hooks.ts', 'export const behavior = 1;\n');
  write(
    '.github/workflows/release.yml',
    'name: Fixture\njobs:\n  publish:\n    steps:\n      - run: |\n          publish_pkg core\n',
  );
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function bundle() {
  const source = implementationSourceDigest(root);
  const identity = {
    canaryVersion: VERSION,
    sourceDigest: source.digest,
    vidaCommit: VIDA,
    harnessVersions: { claude: '2.1.296', codex: '0.162.1' },
  };
  const index = {
    schemaVersion: 1,
    ...identity,
    vidaRepository: REPO,
    hostedRunId: 42,
    checks: {},
  };
  for (const check of CHECKS) {
    const proof = {
      schemaVersion: 1,
      ...identity,
      check,
      status: 'pass',
      observedAt: '2026-10-10T00:00:00Z',
      checkedCount: 1,
      exitCode: 0,
      mode:
        check === 'packedArtifact'
          ? 'packed-artifact'
          : check === 'publishedCanary'
            ? 'published-canary'
            : check.startsWith('readOnly')
              ? 'read-only'
              : check.startsWith('live')
                ? 'live-harness'
                : 'hosted-ci',
    };
    if (check === 'packedArtifact' || check === 'publishedCanary')
      proof.packageVersions = { '@cleocode/core': VERSION };
    if (check.startsWith('live')) {
      proof.ordinaryCommands = 1;
      proof.disposablePushes = 1;
    }
    if (check === 'hostedCi') {
      proof.hostedRunId = 42;
      proof.url = `https://github.com/${REPO}/actions/runs/42`;
    }
    const path = `${check}.json`;
    write(`retained/${path}`, proof);
    index.checks[check] = {
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(root, 'retained', path)))
        .digest('hex'),
    };
  }
  write('retained/index.json', index);
  return index;
}

function transport(overrides = {}) {
  const run = {
    id: 42,
    head_sha: VIDA,
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/migration-hook-pilot.yml',
    repository: { full_name: REPO },
    html_url: `https://github.com/${REPO}/actions/runs/42`,
    ...overrides.run,
  };
  const jobs = {
    jobs: [
      {
        name: 'exact-candidate',
        status: 'completed',
        conclusion: 'success',
        runner_id: 1,
        runner_name: 'GitHub Actions 1',
        labels: ['ubuntu-latest'],
        steps: [
          {
            name: 'Verify exact candidate with read-only migration ledger credentials',
            status: 'completed',
            conclusion: 'success',
          },
        ],
        ...overrides.job,
      },
    ],
    ...overrides.jobs,
  };
  return (endpoint) => {
    expect(endpoint).toMatch(
      /^repos\/kryptobaseddev\/VidaPeps\/actions\/runs\/42(?:\/jobs\?per_page=100)?$/,
    );
    return JSON.stringify(endpoint.includes('/jobs?') ? jobs : run);
  };
}

function options(readApi = transport()) {
  return {
    root,
    evidencePath: join(root, 'retained/index.json'),
    stableVersion: '2026.10.6',
    vidaRepository: REPO,
    readApi,
  };
}

function replaceProof(index, check, changes) {
  const path = `retained/${check}.json`;
  const proof = { ...JSON.parse(readFileSync(join(root, path), 'utf8')), ...changes };
  write(path, proof);
  index.checks[check].sha256 = createHash('sha256')
    .update(readFileSync(join(root, path)))
    .digest('hex');
  write('retained/index.json', index);
}

describe('normalized implementation digest', () => {
  it('ignores version/cohort JSON changes, key order and test-only changes', () => {
    const before = implementationSourceDigest(root);
    write('package.json', {
      dependencies: { zod: '^4.3.6', '@cleocode/core': '2026.10.6' },
      version: '2026.10.6',
      name: 'fixture',
    });
    write('packages/core/package.json', { version: '2026.10.6', name: '@cleocode/core' });
    write('packages/core/src/hooks.test.ts', 'test changes are not runtime source');
    expect(implementationSourceDigest(root)).toEqual(before);
  });
  it('invalidates on runtime, build/workflow and external dependency changes', () => {
    const before = implementationSourceDigest(root).digest;
    write('packages/core/src/hooks.ts', 'export const behavior = 2;\n');
    expect(implementationSourceDigest(root).digest).not.toBe(before);
    write('packages/core/src/hooks.ts', 'export const behavior = 1;\n');
    write('package.json', {
      name: 'fixture',
      version: VERSION,
      dependencies: { '@cleocode/core': VERSION, zod: '^5.0.0' },
    });
    expect(implementationSourceDigest(root).digest).not.toBe(before);
    write(
      '.github/workflows/release.yml',
      'name: Changed\njobs:\n  publish:\n    steps:\n      - run: |\n          publish_pkg core\n',
    );
    expect(implementationSourceDigest(root).digest).not.toBe(before);
  });
  it('holds on untracked runtime source instead of omitting it', () => {
    write('packages/core/src/new-runner.ts', 'new runtime');
    expect(() => implementationSourceDigest(root)).toThrow(/untracked/);
  });
  it('invalidates when executable delivery changes', () => {
    const before = implementationSourceDigest(root).digest;
    chmodSync(join(root, 'packages/core/src/hooks.ts'), 0o755);
    expect(implementationSourceDigest(root).digest).not.toBe(before);
  });
  it('covers root build and shipped binary wrappers', () => {
    write('build.mjs', 'export const build = 1;\n');
    write('packages/core/bin/postinstall.js', 'export const install = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    const before = implementationSourceDigest(root).digest;
    write('build.mjs', 'export const build = 2;\n');
    expect(implementationSourceDigest(root).digest).not.toBe(before);
    write('build.mjs', 'export const build = 1;\n');
    write('packages/core/bin/postinstall.js', 'export const install = 2;\n');
    expect(implementationSourceDigest(root).digest).not.toBe(before);
  });
  it('covers extensionless shipped Git hook templates', () => {
    write('packages/core/templates/git-hooks/pre-push', '#!/bin/sh\nexit 0\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    const before = implementationSourceDigest(root).digest;
    write('packages/core/templates/git-hooks/pre-push', '#!/bin/sh\nexit 1\n');
    expect(implementationSourceDigest(root).digest).not.toBe(before);
  });
});

describe('stable promotion evidence', () => {
  it('validates all exact bound receipts and independently queries hosted run and jobs', async () => {
    bundle();
    expect((await validateHookPilotEvidence(options())).checks).toEqual(CHECKS);
  });
  it('holds when retained evidence is absent', async () => {
    await expect(validateHookPilotEvidence(options())).rejects.toThrow();
  });
  it('holds after source changes even if package version is unchanged', async () => {
    bundle();
    write('packages/core/src/hooks.ts', 'changed implementation');
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/implementation changed/);
  });
  it('holds on mismatched stable base, redirected repository and stale proof identity', async () => {
    const index = bundle();
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.7' }),
    ).rejects.toThrow(/different stable/);
    await expect(
      validateHookPilotEvidence({ ...options(), vidaRepository: 'another/repo' }),
    ).rejects.toThrow(/redirects/);
    replaceProof(index, 'liveCodex', { harnessVersions: { claude: '2.1.296', codex: 'other' } });
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/identity mismatch/);
  });
  it('holds on tampered proof bytes or missing required phase', async () => {
    const index = bundle();
    write('retained/packedArtifact.json', '{}');
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/hash changed/);
    delete index.checks.readOnlyProd;
    write('retained/index.json', index);
    await expect(validateHookPilotEvidence(options())).rejects.toThrow();
  });
  it('holds on split installed cohort and unverified live push', async () => {
    const index = bundle();
    replaceProof(index, 'publishedCanary', { packageVersions: { '@cleocode/core': '2026.10.5' } });
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/cohort/);
    replaceProof(index, 'publishedCanary', { packageVersions: { '@cleocode/core': VERSION } });
    replaceProof(index, 'liveClaude', { disposablePushes: undefined });
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/disposable-push/);
  });
  it('holds when an environment result is not explicitly read-only', async () => {
    const index = bundle();
    replaceProof(index, 'readOnlyProd', { mode: 'hosted-ci' });
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/read-only/);
  });
  it('holds when the hosted receipt links a different run', async () => {
    const index = bundle();
    replaceProof(index, 'hostedCi', { url: `https://github.com/${REPO}/actions/runs/43` });
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/identify its run/);
  });
  it('rejects symlink escapes and oversized proof files', async () => {
    const index = bundle();
    const external = mkdtempSync(join(tmpdir(), 'hook-pilot-external-'));
    try {
      writeFileSync(join(external, 'proof.json'), '{}');
      symlinkSync(join(external, 'proof.json'), join(root, 'retained/escape.json'));
      index.checks.packedArtifact.path = 'escape.json';
      write('retained/index.json', index);
      await expect(validateHookPilotEvidence(options())).rejects.toThrow(/escapes/);
      index.checks.packedArtifact.path = 'packedArtifact.json';
      write('retained/index.json', index);
      write('retained/packedArtifact.json', 'x'.repeat(256 * 1024 + 1));
      await expect(validateHookPilotEvidence(options())).rejects.toThrow(/size invalid/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
  it.each([
    { run: { head_sha: 'b'.repeat(40) } },
    { run: { conclusion: 'failure' } },
    { run: { path: '.github/workflows/other.yml' } },
    { jobs: { jobs: [] } },
    { job: { runner_id: 0, runner_name: null, steps: [] } },
    { job: { labels: ['self-hosted', 'ubuntu-latest'] } },
    {
      job: {
        steps: [
          {
            name: 'Verify exact candidate with read-only migration ledger credentials',
            status: 'completed',
            conclusion: 'skipped',
          },
        ],
      },
    },
  ])('holds on wrong or non-executed hosted CI: %j', async (overrides) => {
    bundle();
    await expect(validateHookPilotEvidence(options(transport(overrides)))).rejects.toThrow();
  });
  it('holds on unavailable GitHub API and incomplete CLI invocation', async () => {
    bundle();
    await expect(
      validateHookPilotEvidence(
        options(() => {
          throw new Error('Unavailable');
        }),
      ),
    ).rejects.toThrow();
    expect(await hookPilotEvidenceMain(['validate'])).toBe(1);
  });
});
