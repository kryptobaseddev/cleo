/** Independent npm-produced fixtures exercise both operational packaging wrappers. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Source tests exercise the real CAAMP leaf. Built export/install checks remain separate.
vi.mock('@cleocode/caamp', () => import('../../packages/caamp/src/core/artifacts/validation.ts'));

import { checkCleoTarball } from '../../packages/cleo/scripts/check-cleo-tarball-size.mjs';
import { assertCleoTarball } from '../assert-cleo-tarball.mjs';
import {
  assertPackedHealthResponse,
  assertPackedTaskResponse,
  assertPackedVersion,
  packedEnvironment,
  runPackedCommand,
  verifyPackedProviderProcess,
} from '../packed-install-smoke.mjs';

const required = [
  'dist/cli/index.js',
  'studio-dist/index.js',
  'studio-dist/handler.js',
  'studio-dist/server/index.js',
  'studio-dist/server/manifest.js',
  'studio-dist/client/_app/immutable/entry/start.fixture.js',
  'studio-dist/client/_app/immutable/entry/app.fixture.js',
];
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-package-wrappers-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function put(path, bytes = 'export const fixture = true;\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function manifest(files = ['dist', 'studio-dist', '!dist/**/*.map']) {
  put('package.json', JSON.stringify({ name: 'cleo-wrapper-fixture', version: '1.0.0', files }));
}
function complete() {
  manifest();
  for (const path of required) put(path);
}

describe('real npm inventory through release wrappers', () => {
  it('accepts tiny complete content and preserves the negated files entry', () => {
    complete();
    put('dist/cli/index.js.map', 'excluded map');
    expect(assertCleoTarball(root)).toBe(true);
    expect(checkCleoTarball(root)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
    const receipt = JSON.parse(console.log.mock.calls[0][0]);
    expect(receipt.inventory.source).toBe('npm-pack-dry-run');
    expect(receipt.runtime).toBe('not-assessed');
    expect(receipt.inventory.tarballSha256).toBeUndefined();
    expect(receipt.inventory.files.some((file) => file.path.endsWith('.map'))).toBe(false);
  });

  it('rejects empty directories that previously passed existence checks', () => {
    manifest();
    mkdirSync(join(root, 'dist/cli'), { recursive: true });
    mkdirSync(join(root, 'studio-dist/client/_app'), { recursive: true });
    expect(assertCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('Required resource');
  });

  it('rejects missing server content despite padding above both old floors', () => {
    complete();
    rmSync(join(root, 'studio-dist/server/manifest.js'));
    for (let index = 0; index < 601; index++)
      put(`studio-dist/padding/${index}.dat`, Buffer.alloc(40_000, 65));
    expect(checkCleoTarball(root)).toBe(false);
    const receipt = JSON.parse(console.log.mock.calls[0][0]);
    expect(receipt.unpackedBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(receipt.inventory.files.length).toBeGreaterThan(600);
    expect(receipt.issues.filter((issue) => issue.code === 'budget')).toEqual([]);
    expect(receipt.issues).toContainEqual(
      expect.objectContaining({ code: 'missing', subject: 'studio-manifest' }),
    );
  });

  it('rejects required resources excluded by npm despite complete staging', () => {
    complete();
    manifest(['dist', 'studio-dist', '!studio-dist/server/manifest.js']);
    expect(assertCleoTarball(root)).toBe(false);
  });

  it('retains declaration/stray JavaScript build-shape rejection', () => {
    complete();
    put('dist/cli/index.d.ts', 'export declare const fixture: boolean;');
    put('dist/not-shipped.js');
    expect(checkCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('E_DEV_TREE');
  });

  it('retains actual selected sourcemap rejection', () => {
    complete();
    put('studio-dist/server/index.js.map', '{}');
    expect(checkCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('forbidden');
  });

  it('retains literal staging promises beyond the semantic entrypoints', () => {
    complete();
    manifest(['dist', 'studio-dist', 'missing-promised.json']);
    expect(assertCleoTarball(root)).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toContain('missing-promised.json');
  });

  it('rejects malformed files declarations instead of skipping validation', () => {
    manifest([]);
    expect(() => assertCleoTarball(root)).toThrow('nonempty array');
    expect(() => checkCleoTarball(root)).toThrow('nonempty array');
  });
});

describe('packed operational execution', () => {
  it('rejects a failed child even when it prints a plausible version', () => {
    expect(() =>
      runPackedCommand(process.execPath, [
        '-e',
        "process.stdout.write('2026.9.8'); process.exit(7)",
      ]),
    ).toThrow();
    expect(runPackedCommand(process.execPath, ['-e', "process.stdout.write('fixture')"])).toBe(
      'fixture',
    );
  });
  it('does not inherit credentials, preloads, or host runtime aliases', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-must-not-copy');
    vi.stubEnv('NODE_OPTIONS', '--import=/host/guard.mjs');
    vi.stubEnv('CLEO_DIR', '/host/project/.cleo');
    vi.stubEnv('TMPDIR', '/host/tmp');
    const env = packedEnvironment(root);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=2048');
    expect(env.CLEO_DIR).toBe(join(root, 'project/.cleo'));
    expect(env.TMPDIR).toBe(join(root, 'tmp'));
    for (const key of [
      'HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'NEXUS_HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'KIMI_HOME',
    ])
      expect(env[key].startsWith(root + '/')).toBe(true);
  });
});

describe('independent installed response oracles', () => {
  it('requires an exact successful version envelope, not arbitrary nonempty stdout', () => {
    expect(assertPackedVersion('{"success":true,"data":{"version":"2026.9.8"}}', '2026.9.8')).toBe(
      '2026.9.8',
    );
    for (const output of [
      '2026.9.8',
      '{"success":false,"data":{"version":"2026.9.8"}}',
      '{"success":true,"data":{"version":"wrong"}}',
      '{"success":true,"data":{"version":"2026.9.8"}}\nnoise',
    ])
      expect(() => assertPackedVersion(output, '2026.9.8')).toThrow();
  });
  it('requires canonical task identity and content, not merely HTTP success or an unrelated row', () => {
    expect(() =>
      assertPackedTaskResponse({ tasks: [{ id: 'T002', title: 'expected' }] }, 'T002', 'expected'),
    ).not.toThrow();
    for (const body of [
      { tasks: [] },
      { tasks: [{ id: 'T001', title: 'expected' }] },
      { tasks: [{ id: 'T002', title: 'wrong' }] },
      { error: 'tasks.db unavailable' },
    ])
      expect(() => assertPackedTaskResponse(body, 'T002', 'expected')).toThrow();
  });
});

describe('independent scoped health oracle', () => {
  const expected = {
    version: '2026.9.8',
    projectDb: '/synthetic/project/.cleo/cleo.db',
    globalDb: '/synthetic/global/cleo.db',
    taskCount: 2,
  };
  function health() {
    const databases = {};
    for (const [name, scope, table] of [
      ['tasks', 'project', 'tasks_tasks'],
      ['nexus', 'project', 'nexus_nodes'],
      ['brain', 'project', 'brain_observations'],
      ['conduit', 'project', 'conduit_messages'],
      ['project-registry', 'global', 'nexus_project_registry'],
      ['agent-registry', 'global', 'agent_registry_agents'],
    ])
      databases[name] = {
        scope,
        table,
        path: scope === 'project' ? expected.projectDb : expected.globalDb,
        projectId: scope === 'project' ? 'fixture-id' : null,
        available: true,
        coverage: 'current',
        rowCount: name === 'tasks' ? 2 : 0,
        errors: [],
        lifecycle: 'owned-read-only-snapshot',
        schemaVersion: '0',
        observedPragmas: {
          journal_mode: 'wal',
          foreign_keys: 1,
          busy_timeout: 5000,
          query_only: 0,
        },
      };
    return {
      service: 'cleo-studio',
      version: '2026.9.8',
      projectId: 'fixture-id',
      ok: true,
      okScope: 'listed-store-probes-only',
      databases,
      coverage: {
        status: 'partial',
        observedRealms: ['studio-main'],
        unobservedRealms: ['core-main', 'core-workers'],
        limitations: ['Live handles not inventoried'],
      },
    };
  }
  it('accepts actual scoped counts with explicit incomplete realm coverage', () => {
    expect(() => assertPackedHealthResponse(health(), expected)).not.toThrow();
  });
  it.each([
    'missing',
    'failed',
  ])('rejects explicit %s separately from a healthy zero', (coverage) => {
    const body = health();
    body.ok = false;
    body.coverage.status = coverage === 'failed' ? 'failed' : 'partial';
    Object.assign(body.databases.tasks, {
      coverage,
      available: coverage !== 'missing',
      rowCount: null,
      errors: ['synthetic diagnostic'],
    });
    expect(() => assertPackedHealthResponse(body, expected)).toThrow(`is ${coverage}`);
    body.databases.tasks.rowCount = 0;
    expect(() => assertPackedHealthResponse(body, expected)).toThrow(
      'disguises an unassessed count',
    );
  });
  it.each([
    [
      'retired zero count',
      (body) => {
        body.databases.tasks.rowCount = 0;
      },
    ],
    [
      'unknown version',
      (body) => {
        body.version = 'unknown';
      },
    ],
    [
      'global graph confusion',
      (body) => {
        body.databases.nexus.path = expected.globalDb;
      },
    ],
    [
      'retired table',
      (body) => {
        body.databases.tasks.table = 'tasks';
      },
    ],
    [
      'foreign project',
      (body) => {
        body.databases.tasks.projectId = 'other';
      },
    ],
    [
      'unobserved realm hidden',
      (body) => {
        body.coverage.unobservedRealms = [];
      },
    ],
    [
      'false complete coverage',
      (body) => {
        body.coverage.status = 'current';
      },
    ],
    [
      'missing pragma',
      (body) => {
        delete body.databases.tasks.observedPragmas.journal_mode;
      },
    ],
    [
      'failed probe as current',
      (body) => {
        body.databases.tasks.errors = ['failed read'];
      },
    ],
  ])('rejects %s despite HTTP success', (_name, corrupt) => {
    const body = health();
    corrupt(body);
    expect(() => assertPackedHealthResponse(body, expected)).toThrow();
  });
});

describe('packed provider process prerequisites, not workflow certification', () => {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function fixture(certification = 'unverified') {
    const app = join(root, 'app');
    const env = packedEnvironment(root);
    const inventories = [];
    for (const [name, files] of [
      [
        '@cleocode/core',
        { 'templates/CLEO-INJECTION.md': 'Managed protocol: inspect authority and coverage.\n' },
      ],
      [
        '@cleocode/skills',
        { 'skills/ct-cleo/SKILL.md': 'Managed skill: verify receipts and preserve history.\n' },
      ],
      [
        '@cleocode/cleo-os',
        {
          'dist/harnesses/provider-verification.js': `import {writeFileSync} from 'node:fs';import {join} from 'node:path';export async function runProviderVerification(input){writeFileSync(join(input.isolationRoot,'fixture-launched'),'yes');return {certification:${JSON.stringify(certification)},stdout:'agent claims workflow passed',outcome:'exited',exitCode:0};}`,
        },
      ],
    ]) {
      const packageRoot = join(app, 'node_modules', name);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', type: 'module' }),
      );
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
        writeFileSync(join(packageRoot, path), content);
      }
      const packed = JSON.parse(
        runPackedCommand(
          'npm',
          ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
          { cwd: packageRoot, env },
        ),
      )[0];
      inventories.push({
        packageName: name,
        version: '1.0.0',
        source: 'npm-pack',
        packedBytes: packed.size,
        tarballSha256: digest(readFileSync(join(root, packed.filename))),
        files: packed.files.map((file) => ({
          path: file.path,
          size: file.size,
          sha256: digest(readFileSync(join(packageRoot, file.path))),
        })),
      });
    }
    return {
      app,
      inventories,
      input: {
        provider: 'codex',
        executable: process.execPath,
        invocationId: 'packed-fixture',
        isolationRoot: root,
        projectRoot: env.CLEO_ROOT,
        environment: env,
        prompt: 'Inspect the synthetic project and follow its managed instructions.',
        deadlineAt: Date.now() + 10000,
        transcriptByteLimit: 4096,
        memoryMaxMb: 256,
      },
    };
  }
  it('matches real npm-produced fixture bytes and stages exact instructions without certifying their reading', async () => {
    const { app, inventories, input } = fixture();
    const result = await verifyPackedProviderProcess(app, input, inventories);
    expect(result.workflow).toBe('unverified');
    expect(result.instructions.delivery).toBe('staged-unverified');
    expect(result.process.stdout).toContain('claims workflow passed');
    const bytes = readFileSync(result.instructions.bootstrap.locator);
    expect(digest(bytes)).toBe(result.instructions.bootstrap.sha256);
    expect(bytes.toString()).toBe(
      'Managed protocol: inspect authority and coverage.\n\nManaged skill: verify receipts and preserve history.\n\n',
    );
    expect(result.instructions.sources).toHaveLength(2);
    expect(result.artifacts).toHaveLength(4);
    expect(result.limitations.join(' ')).toContain('reference expansion remain unverified');
  });
  it('rejects an installed fixture runner attempting to promote process output into certification', async () => {
    const { app, inventories, input } = fixture('verified');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow(
      'unsupported capability promotion',
    );
  });
  it('rejects an installed runner edited after pack, before loading or executing it', async () => {
    const { app, inventories, input } = fixture();
    writeFileSync(
      join(app, 'node_modules/@cleocode/cleo-os/dist/harnesses/provider-verification.js'),
      'throw new Error("must not load");',
    );
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('differs');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
  it('rejects a preview inventory and ambiguous package identities', async () => {
    const { app, inventories, input } = fixture();
    inventories[0].source = 'npm-pack-dry-run';
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow(
      'Actual retained npm-pack',
    );
    inventories[0].source = 'npm-pack';
    inventories.push(inventories[0]);
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow(
      'Exactly one packed inventory',
    );
  });
  it('preserves pre-existing project instruction bytes and refuses conflict', async () => {
    const { app, inventories, input } = fixture();
    const path = join(input.projectRoot, 'AGENTS.md');
    writeFileSync(path, 'User-authored instructions.');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('conflicts');
    expect(readFileSync(path, 'utf8')).toBe('User-authored instructions.');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
  it('preserves original deadline/cancellation through preparation without launch or bootstrap writes', async () => {
    const { app, inventories, input } = fixture();
    input.deadlineAt = Date.now() - 1;
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('deadline');
    input.deadlineAt = Date.now() + 10000;
    input.signal = AbortSignal.abort();
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
    expect(existsSync(join(input.projectRoot, 'AGENTS.md'))).toBe(false);
  });
  it('refuses package symlinks escaping the isolated installation', async () => {
    const { app, inventories, input } = fixture();
    const packageRoot = join(app, 'node_modules/@cleocode/cleo-os');
    rmSync(packageRoot, { recursive: true });
    symlinkSync(dirname(root), packageRoot, 'dir');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('escapes');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
});
