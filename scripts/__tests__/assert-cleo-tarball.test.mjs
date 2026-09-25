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

// Small deterministic source fixtures exercise the real target/transport/group
// behavior, without claiming kernel memory/process limits on a CI host. Actual
// installed runtime verification uses the unmocked port and observed cgroups.
const captureRequests = vi.hoisted(() => []);
vi.mock('../../packages/core/dist/resources/spawn-wrapper.js', async () => {
  const source = await import('../../packages/core/src/resources/spawn-wrapper.ts');
  return {
    ...source,
    captureWrapped: async (command, args, options) => {
      captureRequests.push(options);
      return source.captureWrapped(command, args, {
        ...options,
        memoryMaxMb: undefined,
        tasksMax: undefined,
      });
    },
  };
});

import { checkCleoTarball } from '../../packages/cleo/scripts/check-cleo-tarball-size.mjs';
import { _forceSystemdRunAvailable } from '../../packages/core/dist/resources/spawn-wrapper.js';
import { assertCleoTarball } from '../assert-cleo-tarball.mjs';
import {
  assertPackedHealthResponse,
  assertPackedProviderRepairState,
  assertPackedProviderStaleRejection,
  assertPackedTaskResponse,
  assertPackedVersion,
  packedEnvironment,
  packedInstallFailure,
  runPackedCommand,
  verifyPackedGit,
  verifyPackedProviderProcess,
  verifyPackedRuntime,
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
  captureRequests.length = 0;
  _forceSystemdRunAvailable(false);
  root = mkdtempSync(join(tmpdir(), 'cleo-package-wrappers-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  _forceSystemdRunAvailable(undefined);
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

// T12309: every case below drives `assertCleoTarball`, which runs
// `execFileSync('npm', ['pack', '--dry-run', …])` — a real npm subprocess.
// vitest's default per-test timeout is 5000ms, and npm's own startup is a
// large fraction of that: this FILE takes ~9.3s on an idle developer machine.
// On a CI shard competing with a full sweep one case crossed the line and the
// suite failed with `Test timed out in 5000ms` on a tree that was otherwise
// entirely green — a timing flake, not a defect, and indistinguishable from
// one in the log. The budget is sized for a loaded runner; a genuine hang
// still fails, 12x later.
describe('real npm inventory through release wrappers', { timeout: 60_000 }, () => {
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
  it('refuses resource escalation before capture admission', async () => {
    await expect(
      runPackedCommand(process.execPath, ['--version'], { memoryMaxMb: 8192 }),
    ).rejects.toThrow('4096 MiB');
    await expect(
      runPackedCommand(process.execPath, ['--version'], { tasksMax: 1024 }),
    ).rejects.toThrow('256 tasks');
    expect(captureRequests).toHaveLength(0);
  });
  it('rejects a failed child even when it prints a plausible version', async () => {
    await expect(
      runPackedCommand(process.execPath, [
        '-e',
        "process.stdout.write('2026.9.8'); process.exit(7)",
      ]),
    ).rejects.toThrow();
    expect(
      await runPackedCommand(process.execPath, ['-e', "process.stdout.write('fixture')"]),
    ).toBe('fixture');
    expect(captureRequests).toHaveLength(2);
    for (const request of captureRequests) {
      expect(request.memoryMaxMb).toBe(4096);
      expect(request.tasksMax).toBe(256);
    }
  });
  it('keeps the original deadline and cancellation rather than renewing timeout', async () => {
    const marker = join(root, 'must-not-run');
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`];
    await expect(
      runPackedCommand(process.execPath, args, {
        cwd: root,
        env: packedEnvironment(root),
        timeout: 60000,
        execution: { deadlineAt: Date.now() - 1 },
      }),
    ).rejects.toThrow('deadline');
    await expect(
      runPackedCommand(process.execPath, args, {
        cwd: root,
        env: packedEnvironment(root),
        execution: { deadlineAt: Date.now() + 10000, signal: AbortSignal.abort() },
      }),
    ).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });
  it('captures mutable environment before launch and retains exact target failure', async () => {
    const env = packedEnvironment(root);
    env.CAPTURE_FIXTURE = 'original';
    const invocation = runPackedCommand(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CAPTURE_FIXTURE);process.exit(7)'],
      { cwd: root, env },
    );
    env.CAPTURE_FIXTURE = 'changed';
    await expect(invocation).rejects.toMatchObject({
      stdout: 'original',
      capture: { started: true, exitCode: 7, targetCloseObserved: true, transportClosed: true },
    });
  });
  it('observes exact owned descendant termination within a bounded cleanup interval', async () => {
    const marker = join(root, 'child.pid');
    const childCode = 'setInterval(()=>{},1000)';
    const code = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)},'cleo-packed-owned-child'],{stdio:'ignore'});const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));child.unref();`;
    let identity;
    const ownedRunning = () => {
      try {
        const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[19] === identity.start && fields[0] !== 'Z';
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    };
    try {
      await runPackedCommand(process.execPath, ['-e', code], {
        cwd: root,
        env: packedEnvironment(root),
        timeout: 3000,
      });
      identity = JSON.parse(readFileSync(marker, 'utf8'));
      // Signal delivery is not completed cleanup. Observe the exact PID/start
      // identity for a separate bounded cleanup interval; never repeat the action.
      const cleanupDeadline = Date.now() + 1000;
      while (ownedRunning() && Date.now() < cleanupDeadline)
        await new Promise((done) => setTimeout(done, 10));
      expect(ownedRunning()).toBe(false);
    } finally {
      if (!identity && existsSync(marker)) identity = JSON.parse(readFileSync(marker, 'utf8'));
      if (identity) {
        try {
          if (
            ownedRunning() &&
            readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').includes(
              'cleo-packed-owned-child',
            )
          )
            process.kill(identity.pid, 'SIGKILL');
        } catch (error) {
          expect(['ENOENT', 'ESRCH']).toContain(error.code);
        }
      }
    }
  });
  it('refuses detached runtime before actions when the original invocation expired', async () => {
    const env = packedEnvironment(root);
    await expect(
      verifyPackedRuntime(join(root, 'app'), root, env, {
        execution: { deadlineAt: Date.now() - 1 },
      }),
    ).rejects.toThrow('deadline');
    expect(captureRequests).toHaveLength(0);
    expect(existsSync(join(root, 'runtime-scope.json'))).toBe(false);
  });
  it('refuses installed Git before discovery when the shared attempt expired', async () => {
    await expect(
      verifyPackedGit(join(root, 'app'), root, packedEnvironment(root), {
        execution: { deadlineAt: Date.now() - 1 },
      }),
    ).rejects.toThrow('deadline');
    expect(captureRequests).toHaveLength(0);
    expect(existsSync(join(root, 'installed-git-fixture'))).toBe(false);
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

describe('gh#1471 packed install failure classification', () => {
  const captureFailure = (stderr) =>
    Object.assign(
      new Error(
        'Packed command failed: target=1, signal=null, stop=null, error=null, cleanup=scope-terminal',
      ),
      { stdout: '', stderr },
    );

  it('reports the registry timeout as a network fault, not a packaging defect', () => {
    // Verbatim shape from the v2026.9.6 release run in the issue: a transitive
    // postinstall could not reach a non-npm host, so nothing was ever resolved
    // against the published graph.
    const diagnosed = packedInstallFailure(
      captureFailure(
        'npm error command sh -c node ./script/install\n' +
          'npm error AggregateError [ETIMEDOUT]:\n' +
          'npm error     Error: connect ETIMEDOUT 150.171.110.151:443\n' +
          'npm error     Error: connect ENETUNREACH 2603:1061:14:192::1:443\n',
      ),
    );
    expect(diagnosed.message).toContain('network access (ETIMEDOUT)');
    expect(diagnosed.message).not.toContain('workspace-private');
    expect(diagnosed.stderr).toContain('ETIMEDOUT');
  });

  it.each(['EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH'])('treats %s as a network fault', (code) => {
    expect(packedInstallFailure(captureFailure(`npm error Error: ${code}`)).message).toContain(
      `network access (${code})`,
    );
  });

  it.each([
    'ERR_MODULE_NOT_FOUND',
    'ETARGET',
    'E404',
  ])('keeps the dependency-declaration diagnosis for %s', (code) => {
    const message = packedInstallFailure(captureFailure(`npm error code ${code}`)).message;
    expect(message).toContain(code);
    expect(message).toContain('not declared in its dependencies');
  });

  it('says the cause is undetermined instead of defaulting to a packaging defect', () => {
    const message = packedInstallFailure(
      captureFailure('npm error code EACCES\nnpm error syscall mkdir'),
    ).message;
    expect(message).toContain('undetermined');
    expect(message).not.toContain('not declared in its dependencies');
  });

  it('leaves a successful install unchanged', async () => {
    expect(
      await runPackedCommand(process.execPath, ['-e', "process.stdout.write('installed')"]),
    ).toBe('installed');
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
  async function fixture(certification = 'unverified') {
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
        await runPackedCommand(
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
    const { app, inventories, input } = await fixture();
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
    const { app, inventories, input } = await fixture('verified');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow(
      'unsupported capability promotion',
    );
  });
  it('rejects an installed runner edited after pack, before loading or executing it', async () => {
    const { app, inventories, input } = await fixture();
    writeFileSync(
      join(app, 'node_modules/@cleocode/cleo-os/dist/harnesses/provider-verification.js'),
      'throw new Error("must not load");',
    );
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('differs');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
  it('rejects a preview inventory and ambiguous package identities', async () => {
    const { app, inventories, input } = await fixture();
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
    const { app, inventories, input } = await fixture();
    const path = join(input.projectRoot, 'AGENTS.md');
    writeFileSync(path, 'User-authored instructions.');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('conflicts');
    expect(readFileSync(path, 'utf8')).toBe('User-authored instructions.');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
  it('preserves original deadline/cancellation through preparation without launch or bootstrap writes', async () => {
    const { app, inventories, input } = await fixture();
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
    const { app, inventories, input } = await fixture();
    const packageRoot = join(app, 'node_modules/@cleocode/cleo-os');
    rmSync(packageRoot, { recursive: true });
    symlinkSync(dirname(root), packageRoot, 'dir');
    await expect(verifyPackedProviderProcess(app, input, inventories)).rejects.toThrow('escapes');
    expect(existsSync(join(root, 'fixture-launched'))).toBe(false);
  });
});

describe('independent provider repair data oracle', () => {
  const identity = {
    projectId: 'synthetic-provider-project',
    actor: 'verifier-owned-actor',
    noiseId: 'O-noise',
    incidentId: 'O-incident',
  };
  function fixture() {
    const original = {
      id: identity.noiseId,
      title: 'Task complete: T123',
      narrative: 'Task T123 completed with status: undefined',
      invalid_at: null,
      source: 'synthetic-fixture',
    };
    const before = {
      observations: [
        { id: identity.noiseId, rowJson: JSON.stringify(original) },
        {
          id: identity.incidentId,
          rowJson: JSON.stringify({
            id: identity.incidentId,
            title: 'Image expiry incident',
            narrative: 'Regenerate the signed image URL before rendering.',
            invalid_at: null,
          }),
        },
      ],
      jobs: [],
      metadata: [],
    };
    const proposal = {
      id: 'proposal-authentic',
      projectId: identity.projectId,
      identity: {
        projectId: identity.projectId,
        actor: identity.actor,
        operation: 'doctor.knowledge',
        idempotencyKey: 'proposal-authentic',
      },
      action: { operation: 'knowledge.quarantine-stubs' },
      resources: [
        {
          id: identity.noiseId,
          role: 'affected',
          kind: 'observation',
          beforeHash: createHash('sha256').update(before.observations[0].rowJson).digest('hex'),
        },
      ],
    };
    const proposalJson = JSON.stringify(proposal);
    const job = {
      id: 'job-authentic',
      status: 'pending',
      proposalJson,
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      resultJson: null,
    };
    const after = structuredClone(before);
    after.jobs.push(job);
    const receipt = {
      id: proposal.id,
      proposalId: proposal.id,
      state: 'repaired',
      projectId: identity.projectId,
      execution: {
        jobId: job.id,
        proposalHash: job.proposalHash,
        identity: { actor: identity.actor },
        resources: [
          { id: identity.noiseId, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
        ],
      },
    };
    const repair = () => {
      after.observations[0].rowJson = JSON.stringify({
        ...original,
        invalid_at: '2026-09-20T00:00:00.000Z',
      });
      job.status = 'complete';
      job.resultJson = JSON.stringify(receipt);
      after.metadata.push({
        key: `knowledge_repair:${receipt.id}`,
        valueJson: JSON.stringify({ receipt }),
      });
    };
    const rollback = () => {
      after.observations[0].rowJson = before.observations[0].rowJson;
      const recoveryProposal = {
        id: 'recovery-authentic',
        projectId: identity.projectId,
        identity: { actor: identity.actor },
        action: { operation: 'knowledge.rollback' },
        rollback: { receiptId: receipt.id },
      };
      const recoveryProposalJson = JSON.stringify(recoveryProposal);
      const recovery = {
        id: recoveryProposal.id,
        state: 'repaired',
        projectId: identity.projectId,
        action: { operation: 'knowledge.rollback', arguments: { receiptId: receipt.id } },
        execution: { jobId: 'job-recovery', identity: { actor: identity.actor } },
      };
      after.jobs.push({
        id: 'job-recovery',
        status: 'complete',
        proposalJson: recoveryProposalJson,
        proposalHash: createHash('sha256').update(recoveryProposalJson).digest('hex'),
        resultJson: JSON.stringify(recovery),
      });
      after.metadata.push(
        {
          key: `knowledge_repair:${recovery.id}`,
          valueJson: JSON.stringify({ receipt: recovery }),
        },
        {
          key: `knowledge_rollback:${receipt.id}`,
          valueJson: JSON.stringify({ receiptId: recovery.id }),
        },
      );
    };
    return { before, after, job, receipt, repair, rollback };
  }
  it('requires a durable scoped immutable pending job with unchanged evidence for preparation', () => {
    const f = fixture();
    expect(assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toMatchObject({
      jobId: 'job-authentic',
      receiptId: null,
    });
    f.job.proposalHash = '0'.repeat(64);
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'hash differs',
    );
  });
  it('rejects premature mutation during prepare even when the command returned success', () => {
    const f = fixture();
    f.repair();
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'Preparation mutated',
    );
  });
  it('requires both actual quarantine and a matching committed job receipt', () => {
    const f = fixture();
    f.repair();
    expect(assertPackedProviderRepairState(f.before, f.after, identity, 'repaired').receiptId).toBe(
      'proposal-authentic',
    );
    f.after.observations[0].rowJson = f.before.observations[0].rowJson;
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'repaired')).toThrow(
      'solely quarantine',
    );
  });
  it('rejects changed incident knowledge and destroyed original records', () => {
    const f = fixture();
    f.repair();
    f.after.observations[1].rowJson = JSON.stringify({
      id: identity.incidentId,
      narrative: 'empty completion',
    });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'repaired')).toThrow(
      'incident evidence changed',
    );
    f.after.observations = [];
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'repaired')).toThrow(
      'retained observation',
    );
  });
  it('rejects unrelated or mismatching completion receipts', () => {
    const f = fixture();
    f.repair();
    f.receipt.execution.jobId = 'unrelated-job';
    f.after.metadata[0].valueJson = JSON.stringify({ receipt: f.receipt });
    f.job.resultJson = JSON.stringify(f.receipt);
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'repaired')).toThrow(
      'do not agree',
    );
  });
  it('verifies all 26 seeded resources through preparation, repair and rollback', () => {
    const f = fixture();
    const additionalNoiseIds = Array.from({ length: 25 }, (_, index) => `O-extra-${index}`);
    const extended = { ...identity, additionalNoiseIds };
    const proposal = JSON.parse(f.job.proposalJson);
    for (const id of additionalNoiseIds) {
      const row = {
        id,
        rowJson: JSON.stringify({ ...JSON.parse(f.before.observations[0].rowJson), id }),
      };
      f.before.observations.push(row);
      f.after.observations.push({ ...row });
      proposal.resources.push({
        id,
        role: 'affected',
        kind: 'observation',
        beforeHash: createHash('sha256').update(row.rowJson).digest('hex'),
      });
      f.receipt.execution.resources.push({
        id,
        beforeHash: 'c'.repeat(64),
        afterHash: 'd'.repeat(64),
      });
    }
    f.job.proposalJson = JSON.stringify(proposal);
    f.job.proposalHash = createHash('sha256').update(f.job.proposalJson).digest('hex');
    f.receipt.execution.proposalHash = f.job.proposalHash;
    expect(assertPackedProviderRepairState(f.before, f.after, extended, 'prepared').jobId).toBe(
      f.job.id,
    );
    f.repair();
    for (const row of f.after.observations.filter((row) => additionalNoiseIds.includes(row.id)))
      row.rowJson = JSON.stringify({
        ...JSON.parse(row.rowJson),
        invalid_at: '2026-09-20T00:00:00.000Z',
      });
    expect(assertPackedProviderRepairState(f.before, f.after, extended, 'repaired').receiptId).toBe(
      f.receipt.id,
    );
    f.rollback();
    for (const row of f.after.observations.filter((row) => additionalNoiseIds.includes(row.id)))
      row.rowJson = f.before.observations.find((original) => original.id === row.id).rowJson;
    expect(
      assertPackedProviderRepairState(f.before, f.after, extended, 'rolled-back').rollbackReceiptId,
    ).toBe('recovery-authentic');
    proposal.resources.pop();
    f.job.proposalJson = JSON.stringify(proposal);
    f.job.proposalHash = createHash('sha256').update(f.job.proposalJson).digest('hex');
    expect(() =>
      assertPackedProviderRepairState(f.before, f.after, extended, 'rolled-back'),
    ).toThrow('unexpected resources');
  });
  it.each(['extra', 'duplicate', 'wrong-id'])('rejects %s affected resource membership', (kind) => {
    const f = fixture();
    const proposal = JSON.parse(f.job.proposalJson);
    if (kind === 'wrong-id') proposal.resources[0].id = identity.incidentId;
    else
      proposal.resources.push({
        ...proposal.resources[0],
        id: kind === 'extra' ? 'O-extra' : identity.noiseId,
      });
    f.job.proposalJson = JSON.stringify(proposal);
    f.job.proposalHash = createHash('sha256').update(f.job.proposalJson).digest('hex');
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'unexpected resources',
    );
  });
  function retrievedFixture() {
    const f = fixture();
    f.before.capturedAtMs = Date.parse('2026-09-20T00:00:01.500Z');
    f.after.capturedAtMs = Date.parse('2026-09-20T00:00:03.500Z');
    f.before.observations[1].rowJson = JSON.stringify({
      ...JSON.parse(f.before.observations[1].rowJson),
      citation_count: 2,
      updated_at: '2026-09-20 00:00:00',
    });
    f.after.observations[1].rowJson = JSON.stringify({
      ...JSON.parse(f.before.observations[1].rowJson),
      citation_count: 3,
      updated_at: '2026-09-20 00:00:02',
    });
    return f;
  }
  it('rejects a prepared operation made stale by later retrieval of an affected row', () => {
    const f = fixture();
    f.before.capturedAtMs = Date.parse('2026-09-20T00:00:01.500Z');
    f.after.capturedAtMs = Date.parse('2026-09-20T00:00:03.500Z');
    f.before.observations[0].rowJson = JSON.stringify({
      ...JSON.parse(f.before.observations[0].rowJson),
      citation_count: 0,
      updated_at: null,
    });
    const proposal = JSON.parse(f.job.proposalJson);
    proposal.resources[0].beforeHash = createHash('sha256')
      .update(f.before.observations[0].rowJson)
      .digest('hex');
    f.job.proposalJson = JSON.stringify(proposal);
    f.job.proposalHash = createHash('sha256').update(f.job.proposalJson).digest('hex');
    f.after.observations[0].rowJson = JSON.stringify({
      ...JSON.parse(f.before.observations[0].rowJson),
      citation_count: 1,
      updated_at: '2026-09-20 00:00:02',
    });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'already stale',
    );
  });
  it('records legitimate measured read-side usage while retaining exact incident content', () => {
    const f = retrievedFixture();
    expect(
      assertPackedProviderRepairState(f.before, f.after, identity, 'prepared').retrievalChanges,
    ).toEqual([
      {
        id: identity.incidentId,
        beforeCount: 2,
        afterCount: 3,
        beforeUpdatedAt: '2026-09-20 00:00:00',
        afterUpdatedAt: '2026-09-20 00:00:02',
      },
    ]);
  });
  it.each([
    { citation_count: 2 },
    { citation_count: 1 },
    { citation_count: 2.5 },
    { updated_at: '2026-09-19 23:59:59' },
    { updated_at: '2026-09-20 00:00:04' },
    { updated_at: 'invalid' },
  ])('rejects unmeasured or nonmonotonic citation metadata %j', (change) => {
    const f = retrievedFixture();
    f.after.observations[1].rowJson = JSON.stringify({
      ...JSON.parse(f.after.observations[1].rowJson),
      ...change,
    });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'Retrieval metadata',
    );
  });
  it('requires explicit observed time bounds and forbids a timestamp moving backward', () => {
    const f = retrievedFixture();
    delete f.before.capturedAtMs;
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'Retrieval metadata',
    );
    f.before.capturedAtMs = Date.parse('2026-09-20T00:00:01.500Z');
    f.before.observations[1].rowJson = JSON.stringify({
      ...JSON.parse(f.before.observations[1].rowJson),
      updated_at: '2026-09-20 00:00:03',
    });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'Retrieval metadata',
    );
  });
  it.each([
    'narrative',
    'source',
    'confirmation_state',
    'invalid_at',
    'title',
  ])('never hides %s edits behind legitimate citation updates', (field) => {
    const f = retrievedFixture();
    f.after.observations[1].rowJson = JSON.stringify({
      ...JSON.parse(f.after.observations[1].rowJson),
      [field]: 'changed',
    });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'incident evidence changed',
    );
  });
  it('rejects added or dropped original observation identities', () => {
    const f = fixture();
    f.after.observations.push({ id: 'O-added', rowJson: '{"id":"O-added"}' });
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'population changed',
    );
    f.after.observations = f.after.observations.filter((row) => row.id !== identity.incidentId);
    expect(() => assertPackedProviderRepairState(f.before, f.after, identity, 'prepared')).toThrow(
      'retained observation',
    );
  });
  function staleReplanFixture() {
    const f = fixture();
    f.repair();
    const oldProposal = {
      ...JSON.parse(f.job.proposalJson),
      id: 'stale-proposal',
      identity: { ...JSON.parse(f.job.proposalJson).identity, idempotencyKey: 'stale-proposal' },
    };
    const proposalJson = JSON.stringify(oldProposal);
    const prior = {
      id: 'stale-job',
      status: 'failed',
      proposalJson,
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      resultJson: null,
    };
    const outcome = {
      id: 'stale-job:1',
      jobId: prior.id,
      proposalId: oldProposal.id,
      proposalHash: prior.proposalHash,
      identity: oldProposal.identity,
      status: 'failed',
      errorCode: 'E_REPAIR_STALE',
    };
    prior.resultJson = JSON.stringify(outcome);
    f.after.jobs.unshift(prior);
    f.after.metadata.push({
      key: 'knowledge_repair_attempt:stale-job:1',
      valueJson: prior.resultJson,
    });
    const commands = [
      {
        arguments: [
          'doctor',
          'knowledge',
          '--apply',
          prior.id,
          '--actor',
          identity.actor,
          '--proposal-id',
          oldProposal.id,
        ],
        exitCode: 6,
        stdout: JSON.stringify({
          success: false,
          error: { details: { attemptFailure: { attempt: outcome } } },
        }),
      },
      {
        arguments: [
          'doctor',
          'knowledge',
          '--apply',
          f.job.id,
          '--actor',
          identity.actor,
          '--proposal-id',
          f.receipt.id,
        ],
        exitCode: 0,
        stdout: JSON.stringify({ success: true, data: f.receipt }),
      },
    ];
    return { ...f, prior, commands };
  }
  it('authenticates a failed stale attempt followed by one scoped committed replan', () => {
    const f = staleReplanFixture();
    expect(
      assertPackedProviderRepairState(f.before, f.after, identity, 'repaired', f.commands)
        .receiptId,
    ).toBe(f.receipt.id);
    f.rollback();
    expect(
      assertPackedProviderRepairState(f.before, f.after, identity, 'rolled-back', f.commands)
        .rollbackReceiptId,
    ).toBe('recovery-authentic');
  });
  it.each([
    'missing-command',
    'wrong-actor',
    'wrong-proposal',
    'forged-outcome',
    'extra-commit',
    'other-operation',
  ])('rejects unproven stale-replan history: %s', (kind) => {
    const f = staleReplanFixture();
    if (kind === 'missing-command') f.commands.shift();
    if (kind === 'wrong-actor') f.commands[0].arguments[5] = 'another-actor';
    if (kind === 'wrong-proposal') f.commands[1].arguments[7] = 'another-proposal';
    if (kind === 'forged-outcome') f.after.metadata.at(-1).valueJson = '{}';
    if (kind === 'extra-commit') f.after.jobs.push({ ...f.job, id: 'extra-committed-job' });
    if (kind === 'other-operation') {
      const proposal = {
        ...JSON.parse(f.job.proposalJson),
        action: { operation: 'unrelated.mutation' },
      };
      const proposalJson = JSON.stringify(proposal);
      f.after.jobs.push({
        ...f.job,
        id: 'other-operation-job',
        proposalJson,
        proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      });
    }
    expect(() =>
      assertPackedProviderRepairState(f.before, f.after, identity, 'repaired', f.commands),
    ).toThrow();
  });
  it('requires separate durable rollback evidence and preserves the original receipt', () => {
    const f = fixture();
    f.repair();
    const originalReceipt = f.after.metadata[0].valueJson;
    f.rollback();
    expect(
      assertPackedProviderRepairState(f.before, f.after, identity, 'rolled-back'),
    ).toMatchObject({ receiptId: 'proposal-authentic', rollbackReceiptId: 'recovery-authentic' });
    expect(f.after.metadata[0].valueJson).toBe(originalReceipt);
    expect(() =>
      assertPackedProviderRepairState(f.before, f.after, identity, 'repaired'),
    ).toThrow();
    f.after.jobs.pop();
    expect(() =>
      assertPackedProviderRepairState(f.before, f.after, identity, 'rolled-back'),
    ).toThrow('separate authentic recovery');
  });
  it('requires actual stale failure, preserved edited data and durable failed attempt evidence', () => {
    const f = fixture();
    const before = structuredClone(f.after);
    const command = {
      arguments: [
        'doctor',
        'knowledge',
        '--apply',
        f.job.id,
        '--actor',
        identity.actor,
        '--proposal-id',
        'proposal-authentic',
      ],
      exitCode: 6,
      stdout: JSON.stringify({
        success: false,
        error: { details: { attemptFailure: { attempt: { errorCode: 'E_REPAIR_STALE' } } } },
      }),
    };
    f.job.status = 'failed';
    f.after.metadata.push({
      key: 'knowledge_repair_attempt:authentic',
      valueJson: JSON.stringify({
        jobId: f.job.id,
        identity: { actor: identity.actor, projectId: identity.projectId },
        proposalId: 'proposal-authentic',
        proposalHash: f.job.proposalHash,
        errorCode: 'E_REPAIR_STALE',
        status: 'failed',
      }),
    });
    f.job.resultJson = f.after.metadata[0].valueJson;
    expect(() =>
      assertPackedProviderStaleRejection(before, f.after, f.job.id, command),
    ).not.toThrow();
    expect(() =>
      assertPackedProviderStaleRejection(before, f.after, f.job.id, { ...command, exitCode: 0 }),
    ).toThrow('unsuccessful apply');
    expect(() =>
      assertPackedProviderStaleRejection(before, f.after, f.job.id, {
        ...command,
        stdout: '{"success":true}',
      }),
    ).toThrow('stale-resource failure');
    f.after.observations[0].rowJson = '{}';
    expect(() => assertPackedProviderStaleRejection(before, f.after, f.job.id, command)).toThrow(
      'intervening evidence',
    );
  });
  it('rejects stale-error prose without a corresponding persisted failed attempt', () => {
    const f = fixture();
    const before = structuredClone(f.after);
    f.job.status = 'failed';
    const command = {
      arguments: [
        'doctor',
        'knowledge',
        '--apply',
        f.job.id,
        '--actor',
        identity.actor,
        '--proposal-id',
        'proposal-authentic',
      ],
      exitCode: 6,
      stdout: JSON.stringify({
        success: false,
        error: { details: { attemptFailure: { attempt: { errorCode: 'E_REPAIR_STALE' } } } },
      }),
    };
    expect(() => assertPackedProviderStaleRejection(before, f.after, f.job.id, command)).toThrow(
      'durable failed attempt',
    );
  });
  it('does not accept restored data alone as proof that guarded rollback executed', () => {
    const f = fixture();
    f.repair();
    f.after.observations[0].rowJson = f.before.observations[0].rowJson;
    expect(() =>
      assertPackedProviderRepairState(f.before, f.after, identity, 'rolled-back'),
    ).toThrow('separate authentic recovery');
  });
});
