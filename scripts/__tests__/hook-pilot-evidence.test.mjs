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
  hooksPromotionRequired,
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
    event: 'workflow_dispatch',
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

/** Retained native evidence, separate from a Git push succeeding inside a harness. */
function nativeBundle() {
  const index = bundle();
  index.schemaVersion = 2;
  for (const check of CHECKS) {
    const native = check.startsWith('live')
      ? {
          sessionId: `${check}-session`,
          checkout: check === 'liveCodex' ? 'linked-worktree' : 'standalone',
          startedAt: '2026-10-10T00:00:00Z',
          endedAt: '2026-10-10T00:00:10Z',
          receipt: {
            path: `${check}-agent.json`,
            sessionId: `${check}-session`,
            harness: check === 'liveClaude' ? 'claude-code' : 'codex',
            source: 'agent',
            event: 'PreToolUse',
            recordedAt: '2026-10-10T00:00:05Z',
          },
          trust: { mode: 'persisted', home: 'isolated', grantedBy: 'native-interactive' },
          contextInjection: 'unverified',
          infrastructureFaults: [],
        }
      : undefined;
    if (native) {
      write(`retained/${native.receipt.path}`, {
        schemaVersion: 1,
        manifestHash: 'e'.repeat(64),
        outcomes: [],
        sessionId: native.sessionId,
        harness: native.receipt.harness,
        source: native.receipt.source,
        event: native.receipt.event,
        recordedAt: native.receipt.recordedAt,
      });
      native.receipt.sha256 = createHash('sha256')
        .update(readFileSync(join(root, 'retained', native.receipt.path)))
        .digest('hex');
    }
    replaceProof(index, check, { schemaVersion: 2, ...(native ? { native } : {}) });
  }
  write('retained/index.json', index);
  return index;
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

describe('hooks promotion scope', () => {
  it('exempts ordinary releases, absent plans and hotfixes', () => {
    expect(hooksPromotionRequired(root, '2026.10.6')).toBe(false);
    write('.cleo/release/v2026.10.6.plan.json', { releaseKind: 'regular' });
    expect(hooksPromotionRequired(root, '2026.10.6')).toBe(false);
    write('.cleo/release/v2026.10.6.plan.json', { releaseKind: 'hotfix', hooksV1Promotion: true });
    expect(hooksPromotionRequired(root, '2026.10.6')).toBe(false);
  });
  it('requires evidence for an explicitly scoped stable promotion only', () => {
    write('.cleo/release/v2026.10.6.plan.json', { releaseKind: 'regular', hooksV1Promotion: true });
    expect(hooksPromotionRequired(root, '2026.10.6')).toBe(true);
    expect(hooksPromotionRequired(root, VERSION)).toBe(false);
    expect(hooksPromotionRequired(root, '../outside')).toBe(false);
  });
  it('rejects malformed promotion metadata', () => {
    write('.cleo/release/v2026.10.6.plan.json', {
      releaseKind: 'regular',
      hooksV1Promotion: 'true',
    });
    expect(() => hooksPromotionRequired(root, '2026.10.6')).toThrow();
  });
});

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
  it('normalizes release-owned canary and hotfix metadata without hiding other manifest changes', () => {
    const before = implementationSourceDigest(root);
    write('packages/core/package.json', {
      name: '@cleocode/core',
      version: VERSION,
      // The hooks-v1 promotion stamp is release-owned too (T13557).
      cleo: { channel: 'canary', hotfix: true, releasedFeatures: ['hooks-v1'] },
    });
    expect(implementationSourceDigest(root)).toEqual(before);
    write('packages/core/package.json', {
      name: '@cleocode/core',
      version: VERSION,
      cleo: { channel: 'canary', runtimePolicy: 'changed' },
    });
    expect(implementationSourceDigest(root).digest).not.toBe(before.digest);
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
  it('accepts a later stable release only when every exact source-bound proof still validates', async () => {
    bundle();
    expect(
      (await validateHookPilotEvidence({ ...options(), stableVersion: 'v2026.10.9' })).checks,
    ).toEqual(CHECKS);
    write('packages/core/src/hooks.ts', 'changed implementation');
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.9' }),
    ).rejects.toThrow(/implementation changed/);
  });
  it('validates all exact bound receipts and independently queries hosted run and jobs', async () => {
    bundle();
    expect((await validateHookPilotEvidence(options())).checks).toEqual(CHECKS);
  });
  it('holds when retained evidence is absent', async () => {
    await expect(validateHookPilotEvidence(options())).rejects.toThrow();
  });
  it('T13818: future promotions reject legacy counts-only evidence; historical 10.17 stays verifiable', async () => {
    bundle();
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/schema version 2/);
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.17' }),
    ).resolves.toBeDefined();
  });
  it('T13818: accepts retained native delivery without claiming context injection', async () => {
    nativeBundle();
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).resolves.toBeDefined();
  });
  it.each([
    'pull_request',
    'push',
    undefined,
  ])('T13831: refuses v2 hosted evidence from trigger %s despite a matching head SHA', async (event) => {
    nativeBundle();
    await expect(
      validateHookPilotEvidence({
        ...options(transport({ run: { event } })),
        stableVersion: '2026.10.18',
      }),
    ).rejects.toThrow(/workflow_dispatch/);
  });
  it.each([
    'pull_request',
    undefined,
  ])('T13831: preserves historical v1 hosted trigger %s', async (event) => {
    bundle();
    await expect(
      validateHookPilotEvidence({
        ...options(transport({ run: { event } })),
        stableVersion: '2026.10.17',
      }),
    ).resolves.toBeDefined();
  });
  it('T13818: accepts isolated native-command trust and rejects hand-seeded trust', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', {
      native: {
        ...proof.native,
        trust: { mode: 'persisted', home: 'isolated', grantedBy: 'native-command' },
      },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).resolves.toBeDefined();
    replaceProof(index, 'liveCodex', {
      native: {
        ...proof.native,
        trust: { mode: 'persisted', home: 'isolated', grantedBy: 'hand-seeded' },
      },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow();
  });
  it('T13818: requires retained context evidence when injection is observed', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveClaude.json'), 'utf8'));
    replaceProof(index, 'liveClaude', {
      native: { ...proof.native, contextInjection: 'observed' },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/Observed context requires retained evidence/);
    write('retained/context.json', { hook_additional_context: 'sanitized native hook context' });
    const contextEvidence = {
      path: 'context.json',
      sha256: createHash('sha256')
        .update(readFileSync(join(root, 'retained/context.json')))
        .digest('hex'),
    };
    replaceProof(index, 'liveClaude', {
      native: { ...proof.native, contextInjection: 'observed', contextEvidence },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).resolves.toBeDefined();
    write('retained/context.json', 'tampered');
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/hash changed/);
  });
  it('T13818: requires Codex linked-worktree coverage in new proofs', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', { native: { ...proof.native, checkout: 'standalone' } });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/Codex linked-worktree/);
  });
  it('T13818: keeps infrastructure faults typed and requires explicit fault/context reporting', async () => {
    const index = nativeBundle();
    const { HookPilotProofSchema } = await import(
      '../../packages/contracts/dist/release/hook-pilot.js'
    );
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    proof.native.infrastructureFaults = [
      { source: 'git', code: 'HOOK_RECEIPT_WRITE_FAILED' },
      { source: 'sandbox', code: 'EPERM' },
    ];
    expect(HookPilotProofSchema.parse(proof).native.infrastructureFaults).toEqual(
      proof.native.infrastructureFaults,
    );
    replaceProof(index, 'liveCodex', {
      native: { ...proof.native, infrastructureFaults: undefined },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow();
    replaceProof(index, 'liveCodex', { native: { ...proof.native, contextInjection: undefined } });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow();
  });
  it('T13818: refuses relabeled receipt times and escaping receipt paths', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', {
      native: {
        ...proof.native,
        receipt: { ...proof.native.receipt, recordedAt: '2026-10-10T00:00:06Z' },
      },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/identity mismatch/);
    replaceProof(index, 'liveCodex', {
      native: { ...proof.native, receipt: { ...proof.native.receipt, path: '../outside.json' } },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow();
  });
  it('T13818: rejects a v2 live proof without its native agent receipt', async () => {
    const index = nativeBundle();
    replaceProof(index, 'liveCodex', { native: undefined });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/native agent receipt/);
  });
  it.each([
    'home',
    'prompt',
    'token',
  ])('T13827: strict receipt contract rejects extra %s', async (field) => {
    nativeBundle();
    const { HookPilotNativeReceiptSchema } = await import(
      '../../packages/contracts/dist/release/hook-pilot.js'
    );
    const receipt = JSON.parse(readFileSync(join(root, 'retained/liveCodex-agent.json'), 'utf8'));
    expect(
      HookPilotNativeReceiptSchema.safeParse({ ...receipt, [field]: 'private-fixture' }).success,
    ).toBe(false);
  });
  it('T13826: refuses a receipt from another native session', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', { native: { ...proof.native, sessionId: 'another-session' } });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/identity mismatch/);
  });
  it('T13826: refuses a shared receipt backing both Claude and Codex', async () => {
    const index = nativeBundle();
    const claude = JSON.parse(readFileSync(join(root, 'retained/liveClaude.json'), 'utf8'));
    replaceProof(index, 'liveCodex', { native: { ...claude.native, checkout: 'linked-worktree' } });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/identity mismatch/);
  });
  it.each([
    'home',
    'prompt',
    'token',
  ])('T13827: rejects undeclared receipt field %s', async (field) => {
    const index = nativeBundle();
    const path = join(root, 'retained/liveCodex-agent.json');
    write('retained/liveCodex-agent.json', {
      ...JSON.parse(readFileSync(path, 'utf8')),
      [field]: 'private-fixture',
    });
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    proof.native.receipt.sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    replaceProof(index, 'liveCodex', { native: proof.native });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/Unrecognized key/);
  });
  it('T13818: rejects tampered receipts and Git receipts presented as native delivery', async () => {
    const index = nativeBundle();
    write('retained/liveCodex-agent.json', {
      ...JSON.parse(readFileSync(join(root, 'retained/liveCodex-agent.json'), 'utf8')),
      source: 'git',
      event: 'PreToolUse',
      recordedAt: '2026-10-10T00:00:05Z',
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/hash changed/);
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    proof.native.receipt.sha256 = createHash('sha256')
      .update(readFileSync(join(root, 'retained/liveCodex-agent.json')))
      .digest('hex');
    replaceProof(index, 'liveCodex', { native: proof.native });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow();
  });
  it('T13818: refuses persisted native trust from a user-global home', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', {
      native: { ...proof.native, trust: { ...proof.native.trust, home: 'user-global' } },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/isolated/);
  });
  it('T13818: rejects receipts outside their session and bypassed native trust', async () => {
    const index = nativeBundle();
    const proof = JSON.parse(readFileSync(join(root, 'retained/liveCodex.json'), 'utf8'));
    replaceProof(index, 'liveCodex', {
      native: { ...proof.native, endedAt: '2026-10-10T00:00:04Z' },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/session window/);
    replaceProof(index, 'liveCodex', {
      native: {
        ...proof.native,
        trust: { mode: 'bypassed', home: 'isolated', flag: '--dangerously-bypass-hook-trust' },
        infrastructureFaults: [{ source: 'git', code: 'HOOK_RECEIPT_WRITE_FAILED' }],
      },
    });
    await expect(
      validateHookPilotEvidence({ ...options(), stableVersion: '2026.10.18' }),
    ).rejects.toThrow(/persisted native trust/);
  });
  it('holds after source changes even if package version is unchanged', async () => {
    bundle();
    write('packages/core/src/hooks.ts', 'changed implementation');
    await expect(validateHookPilotEvidence(options())).rejects.toThrow(/implementation changed/);
  });
  it.each([
    '2026.10.5',
    '2026.10.9-canary.1',
    '2026.10.9-rc.1',
    'latest',
    '2026.10',
  ])('holds on invalid or backward stable target %s', async (stableVersion) => {
    bundle();
    await expect(validateHookPilotEvidence({ ...options(), stableVersion })).rejects.toThrow(
      /stable version at or after/,
    );
  });
  it('holds on redirected repository and stale proof identity', async () => {
    const index = bundle();
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
