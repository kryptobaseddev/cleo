import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HookInvocation,
  ProjectHookDefinition,
  ProjectHooksManifest,
} from '@cleocode/contracts/project-hooks.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectHookExecutor,
  executeProjectHooks,
  readLastProjectHookExecution,
} from '../project-runner.js';
import {
  activateProjectHooks,
  disableProjectHooks,
  inspectProjectHooks,
  resolveProjectHookContext,
} from '../project-state.js';
import { HooksV1UnreleasedError } from '../release-gate.js';

// The hooks-v1 gate (T13557) is open for these tests unless one closes it.
const gate = vi.hoisted(() => ({ released: true }));
vi.mock('../release-gate.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../release-gate.js')>();
  return { ...mod, hooksV1Released: () => gate.released };
});

describe('activated project checks through actual child processes', () => {
  let root: string;
  let invocation: HookInvocation;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'cleo-project hook-')));
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, '.cleo'));
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await manifest();
    const context = resolveProjectHookContext(root);
    invocation = {
      schemaVersion: 1,
      projectRoot: root,
      gitCommonDir: context.gitCommonDir,
      source: 'git',
      event: 'pre-push',
    };
  });
  afterEach(async () => {
    gate.released = true;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  describe('while hooks-v1 is unreleased (T13557)', () => {
    it('refuses activation by name and writes no receipt', async () => {
      gate.released = false;
      await expect(activateProjectHooks(root)).rejects.toBeInstanceOf(HooksV1UnreleasedError);
      await expect(activateProjectHooks(root)).rejects.toMatchObject({
        code: 'E_HOOKS_V1_UNRELEASED',
      });
      gate.released = true;
      expect((await inspectProjectHooks(root)).activation).toBe('disabled');
    });

    it('never runs a matching receipt made earlier: skip locally, a blocking failure in CI, and no handler spawns', async () => {
      await writeFile(
        join(root, 'handler.mjs'),
        `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(root, 'ran'))},'1');process.stdout.write(JSON.stringify({status:'pass'}));`,
      );
      await activateProjectHooks(root);
      gate.released = false;
      const inspection = await inspectProjectHooks(root);
      expect(inspection.activation).toBe('unreleased');
      expect(inspection.diagnostics).toContain('HOOKS_V1_UNRELEASED');
      expect((await executeProjectHooks(invocation))[0]).toMatchObject({
        status: 'skip',
        blocks: false,
        code: 'HOOKS_V1_UNRELEASED',
      });
      expect(
        (
          await executeProjectHooks(
            { ...invocation, source: 'ci', event: 'check' },
            'migration-check',
          )
        )[0],
      ).toMatchObject({
        status: 'infrastructure-error',
        blocks: true,
        code: 'HOOKS_V1_UNRELEASED',
      });
      const worktreeExecutor = createProjectHookExecutor(root);
      expect((await worktreeExecutor.execute(invocation))[0]).toMatchObject({
        code: 'HOOKS_V1_UNRELEASED',
      });
      await expect(readFile(join(root, 'ran'), 'utf8')).rejects.toThrow();
      // Disable stays available while unreleased.
      await disableProjectHooks(root);
      expect((await inspectProjectHooks(root)).activation).toBe('disabled');
    });

    it('runs the same receipt once released', async () => {
      await activateProjectHooks(root);
      expect((await executeProjectHooks(invocation))[0]).toMatchObject({
        status: 'pass',
        blocks: false,
      });
    });
  });

  async function manifest(patch: Partial<ProjectHookDefinition> = {}): Promise<void> {
    const hook: ProjectHookDefinition = {
      id: 'migration-check',
      owner: 'project',
      bindings: [{ source: 'git', event: 'pre-push' }],
      executable: 'node',
      handler: 'handler.mjs',
      args: [],
      dependencies: [],
      timeoutMs: 30000,
      checkerErrorPolicy: 'warn',
      ...patch,
    };
    const source: ProjectHooksManifest = { schemaVersion: 1, hooks: [hook] };
    await writeFile(join(root, '.cleo/hooks.json'), JSON.stringify(source));
  }

  it('resolves the active checkout independently of ambient Git repository variables', () => {
    vi.stubEnv('GIT_DIR', '/nonexistent/foreign-repository');
    vi.stubEnv('GIT_WORK_TREE', '/nonexistent/foreign-checkout');
    expect(resolveProjectHookContext(root).projectRoot).toBe(root);
  });

  it('runs checker Git operations in the active checkout despite ambient repository variables', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      `import{execFileSync}from'node:child_process';const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();process.stdout.write(JSON.stringify({status:root===${JSON.stringify(root)}?'pass':'block'}));`,
    );
    await activateProjectHooks(root);
    vi.stubEnv('GIT_DIR', '/nonexistent/foreign-repository');
    vi.stubEnv('GIT_WORK_TREE', '/nonexistent/foreign-checkout');
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'pass',
      blocks: false,
    });
  });

  it('is disabled by default, including when tracked configuration requests execution', async () => {
    await writeFile(join(root, '.cleo/config.json'), '{"hooks":{"project":{"enabled":true}}}');
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'skip',
      blocks: false,
      code: 'HOOK_DISABLED',
    });
    const inspection = await inspectProjectHooks(root);
    expect(inspection.nativeProjectTrust).toBe('unverified');
    expect(inspection.nativeHookTrust).toBe('unverified');
    expect(inspection.resolvedHooks[0]).toMatchObject({
      id: 'migration-check',
      owner: 'project',
      sourceDefinition: join(root, '.cleo/hooks.json'),
      sourceTracked: false,
      handlerPath: join(root, 'handler.mjs'),
      diagnostics: [],
    });
  });
  it('activation works from a nested checkout without harness environment variables', async () => {
    const nested = join(root, 'nested package');
    await mkdir(nested);
    await activateProjectHooks(nested);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'pass',
      blocks: false,
    });
    const state = resolveProjectHookContext(root);
    expect(
      execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).not.toContain('activation');
    expect(await readFile(join(state.stateDir, 'activation.json'), 'utf8')).toContain(
      'manifestHash',
    );
  });
  it('oversized definitions fail open locally and hold CI without executing a checker', async () => {
    await writeFile(join(root, '.cleo/hooks.json'), ' '.repeat(262145));
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'infrastructure-error',
      blocks: false,
    });
    expect((await executeProjectHooks({ ...invocation, source: 'ci' }))[0]).toMatchObject({
      status: 'infrastructure-error',
      blocks: true,
    });
  });
  it('changed handler content fails closed in Git until explicitly reactivated (T13742)', async () => {
    await activateProjectHooks(root);
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"block"}));',
    );
    expect(await executeProjectHooks(invocation)).toMatchObject([
      {
        id: 'migration-check',
        status: 'block',
        blocks: true,
        code: 'HOOK_REACTIVATION_REQUIRED',
        message: expect.stringContaining('cleo hook sync --activate'),
      },
    ]);
    // Agent checks stay advisory: the drift is reported, never enforced.
    expect(
      (await executeProjectHooks({ ...invocation, source: 'agent' }, 'migration-check'))[0],
    ).toMatchObject({ status: 'warn', blocks: false, code: 'HOOK_REACTIVATION_REQUIRED' });
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'block',
      blocks: true,
      code: 'HOOK_BLOCK',
    });
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'pass',
      blocks: false,
    });
    await disableProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0].status).toBe('skip');
  });
  it('drift that deletes or rebinds the hook still refuses the push (T13742 F1-A)', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"block"}));',
    );
    await activateProjectHooks(root);
    await rm(join(root, '.cleo/hooks.json'));
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ]);
    await manifest({ bindings: [{ source: 'git', event: 'pre-commit' }] });
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ]);
    // A malformed manifest cannot shed the approved hook either.
    await writeFile(join(root, '.cleo/hooks.json'), 'invalid-json');
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ]);
    expect(
      await executeProjectHooks({ ...invocation, source: 'worktree', event: 'post-start' }),
    ).toEqual([]);
  });
  it('drift refuses only bound events: worktree start passes, the push is refused (T13742)', async () => {
    await activateProjectHooks(root);
    await writeFile(join(root, 'handler.mjs'), 'process.exit(4);');
    expect(
      await executeProjectHooks({ ...invocation, source: 'worktree', event: 'post-start' }),
    ).toEqual([]);
    expect(
      await executeProjectHooks({ ...invocation, source: 'agent', event: 'PreToolUse' }),
    ).toEqual([]);
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ]);
  });
  it('a legacy activation without stored bindings refuses every non-agent event on drift', async () => {
    await activateProjectHooks(root);
    const file = join(resolveProjectHookContext(root).stateDir, 'activation.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      activation: { bindings?: Record<string, unknown> };
    };
    delete state.activation.bindings;
    await writeFile(file, JSON.stringify(state));
    expect((await inspectProjectHooks(root)).activation).toBe('active');
    await rm(join(root, '.cleo/hooks.json'));
    expect(
      await executeProjectHooks({ ...invocation, source: 'worktree', event: 'post-start' }),
    ).toMatchObject([{ id: 'cleo.project-hooks', status: 'block', blocks: true }]);
    expect(
      await executeProjectHooks({ ...invocation, source: 'agent', event: 'PreToolUse' }),
    ).toMatchObject([{ status: 'warn', blocks: false, code: 'HOOK_REACTIVATION_REQUIRED' }]);
  });
  it('a deleted or replaced project input refuses the push; a missing PATH runtime allows (T13742 F1-E)', async () => {
    await writeFile(join(root, 'dependency.mjs'), 'export const version=1;');
    await manifest({ dependencies: ['dependency.mjs'] });
    await activateProjectHooks(root);
    const refused = [
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ];
    await rm(join(root, 'handler.mjs'));
    expect(await executeProjectHooks(invocation)).toMatchObject(refused);
    await mkdir(join(root, 'handler.mjs'));
    expect(await executeProjectHooks(invocation)).toMatchObject(refused);
    await rm(join(root, 'handler.mjs'), { recursive: true });
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await rm(join(root, 'dependency.mjs'));
    expect(await executeProjectHooks(invocation)).toMatchObject(refused);
    // Unrelated events still run no hooks.
    expect(
      await executeProjectHooks({ ...invocation, source: 'worktree', event: 'post-start' }),
    ).toEqual([]);
    await writeFile(join(root, 'dependency.mjs'), 'export const version=1;');
    await activateProjectHooks(root);
    vi.stubEnv('PATH', '/nonexistent');
    try {
      expect((await executeProjectHooks(invocation))[0]).toMatchObject({
        status: 'infrastructure-error',
        blocks: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('an earlier checker deleting a later handler refuses the push (T13742 F1-E)', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'import{rmSync}from"node:fs";rmSync("later.mjs");process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await writeFile(
      join(root, 'later.mjs'),
      'process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    const source = JSON.parse(
      await readFile(join(root, '.cleo/hooks.json'), 'utf8'),
    ) as ProjectHooksManifest;
    source.hooks.push({ ...source.hooks[0], id: 'later-check', handler: 'later.mjs' });
    await writeFile(join(root, '.cleo/hooks.json'), JSON.stringify(source));
    await activateProjectHooks(root);
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
      { id: 'later-check', status: 'block', blocks: true, code: 'HOOK_REACTIVATION_REQUIRED' },
    ]);
  });
  // Activation, drift and a refused run can exceed the 5 s default under machine load.
  it('corrupted approved bindings fail closed like a legacy activation (T13742)', async () => {
    await activateProjectHooks(root);
    const file = join(resolveProjectHookContext(root).stateDir, 'activation.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      activation: { bindings: Record<string, unknown> };
    };
    state.activation.bindings = {};
    await writeFile(file, JSON.stringify(state));
    await writeFile(join(root, 'handler.mjs'), 'process.exit(5);');
    expect(
      await executeProjectHooks({ ...invocation, source: 'worktree', event: 'post-start' }),
    ).toMatchObject([{ id: 'cleo.project-hooks', status: 'block', blocks: true }]);
  }, 20000);
  it('a legacy activation plus a deleted handler refuses the push (T13742 F1-F)', async () => {
    await activateProjectHooks(root);
    const file = join(resolveProjectHookContext(root).stateDir, 'activation.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      activation: { bindings?: Record<string, unknown>; bindingsHash?: string };
    };
    delete state.activation.bindings;
    delete state.activation.bindingsHash;
    await writeFile(file, JSON.stringify(state));
    await rm(join(root, 'handler.mjs'));
    expect(await executeProjectHooks(invocation)).toMatchObject([
      {
        id: 'cleo.project-hooks',
        status: 'block',
        blocks: true,
        code: 'HOOK_REACTIVATION_REQUIRED',
      },
    ]);
  });
  it('a direct check of an unknown hook ID fails during drift (T13742 F1-C)', async () => {
    await activateProjectHooks(root);
    await writeFile(join(root, 'handler.mjs'), 'process.stdout.write("{}");');
    expect(
      await executeProjectHooks({ ...invocation, source: 'direct', event: 'check' }, 'unknown-id'),
    ).toMatchObject([{ id: 'unknown-id', status: 'block', blocks: true }]);
  });
  it('declared dependencies and implicit lockfiles invalidate approval', async () => {
    await writeFile(join(root, 'dependency.mjs'), 'export const version=1;');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await manifest({ dependencies: ['dependency.mjs'] });
    await activateProjectHooks(root);
    await writeFile(join(root, 'dependency.mjs'), 'export const version=2;');
    expect((await inspectProjectHooks(root)).activation).toBe('drifted');
    await activateProjectHooks(root);
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 10');
    expect((await inspectProjectHooks(root)).activation).toBe('drifted');
  });
  it('project blocks are advisory in agents and authoritative in Git', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"block",message:"secret-input"}));',
    );
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0].blocks).toBe(true);
    expect(
      (await executeProjectHooks({ ...invocation, source: 'agent' }, 'migration-check'))[0],
    ).toMatchObject({ status: 'block', blocks: false });
    const receipt = await readLastProjectHookExecution(root);
    expect(JSON.stringify(receipt)).not.toContain('secret-input');
    expect(JSON.stringify(receipt)).not.toContain('toolInput');
  });
  it('T13818: retains native agent receipts after a Git push records its own result', async () => {
    await manifest({
      bindings: [
        { source: 'agent', event: 'PreToolUse' },
        { source: 'git', event: 'pre-push' },
        { source: 'agent', event: 'Stop' },
      ],
    });
    await writeFile(
      join(root, 'handler.mjs'),
      'process.stdout.write(JSON.stringify({status:"block",message:"secret-input"}));',
    );
    await activateProjectHooks(root);
    await executeProjectHooks({
      ...invocation,
      source: 'agent',
      event: 'PreToolUse',
      nativeSession: { sessionId: 'session-a', harness: 'codex' },
    });
    await executeProjectHooks(invocation);
    expect(await readLastProjectHookExecution(root)).toMatchObject({
      source: 'git',
      event: 'pre-push',
    });
    const agent = await readLastProjectHookExecution(root, {
      source: 'agent',
      event: 'PreToolUse',
    });
    expect(agent).toMatchObject({
      source: 'agent',
      event: 'PreToolUse',
      sessionId: 'session-a',
      harness: 'codex',
    });
    expect(
      await readLastProjectHookExecution(root, { source: 'agent', event: 'Stop' }),
    ).toBeUndefined();
    await executeProjectHooks({ ...invocation, source: 'agent', event: 'Stop' });
    expect(
      await readLastProjectHookExecution(root, { source: 'agent', event: 'PreToolUse' }),
    ).toEqual(agent);
    expect(
      await readLastProjectHookExecution(root, { source: 'agent', event: 'Stop' }),
    ).toMatchObject({ source: 'agent', event: 'Stop' });
    expect(JSON.stringify(agent)).not.toContain('toolInput');
    expect(JSON.stringify(agent)).not.toContain('secret-input');
  });
  it.each([
    'warn',
    'block',
  ] as const)('malformed and nonzero checker responses follow %s policy', async (policy) => {
    await manifest({ checkerErrorPolicy: policy });
    await writeFile(join(root, 'handler.mjs'), 'process.stdout.write("not json");');
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'checker-error',
      blocks: policy === 'block',
      code: 'HOOK_INVALID_VERDICT',
    });
    await writeFile(join(root, 'handler.mjs'), 'process.exit(7);');
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'checker-error',
      blocks: policy === 'block',
      exitCode: 7,
    });
  });
  it('distinguishes timeout and signal and bounds output', async () => {
    await manifest({ timeoutMs: 100, checkerErrorPolicy: 'block' });
    await writeFile(join(root, 'handler.mjs'), 'setInterval(()=>{},1000);');
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'timeout',
      blocks: true,
    });
    await manifest({ timeoutMs: 2000, checkerErrorPolicy: 'block' });
    await writeFile(join(root, 'handler.mjs'), 'process.kill(process.pid,"SIGTERM");');
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'checker-error',
      code: 'HOOK_SIGNAL',
      signal: 'SIGTERM',
    });
    await writeFile(join(root, 'handler.mjs'), 'process.stdout.write("x".repeat(70000));');
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'checker-error',
      code: 'HOOK_OUTPUT_TOO_LARGE',
    });
  });
  it('binds executable content even when size and modification time are restored', async () => {
    const executable = join(root, 'runner.sh');
    await writeFile(executable, `#!/bin/sh\nprintf '{"status":"pass"}'`);
    await chmod(executable, 0o755);
    await manifest({ executable: './runner.sh' });
    await activateProjectHooks(root);
    const before = await stat(executable);
    await writeFile(executable, `#!/bin/sh\nprintf '{"status":"warn"}'`);
    await utimes(executable, before.atime, before.mtime);
    expect((await stat(executable)).size).toBe(before.size);
    expect((await inspectProjectHooks(root)).activation).toBe('drifted');
  });
  it('cancels hash and checker work without applying project error policy locally', async () => {
    await manifest({ checkerErrorPolicy: 'block' });
    await writeFile(join(root, 'handler.mjs'), 'setInterval(()=>{},1000);');
    await activateProjectHooks(root);
    const controller = new AbortController();
    const execution = executeProjectHooks(invocation, undefined, undefined, controller.signal);
    controller.abort();
    expect((await execution)[0]).toMatchObject({ status: 'infrastructure-error', blocks: false });
  });
  it('fails open on CLEO faults locally, but fails required CI checks', async () => {
    await writeFile(join(root, '.cleo/hooks.json'), 'invalid-json');
    expect((await executeProjectHooks(invocation))[0]).toMatchObject({
      status: 'infrastructure-error',
      blocks: false,
    });
    expect((await executeProjectHooks({ ...invocation, source: 'ci' }))[0]).toMatchObject({
      status: 'infrastructure-error',
      blocks: true,
    });
  });
  it.skipIf(process.platform === 'win32')(
    'allows launcher faults locally even with blocking checker policy, but fails CI',
    async () => {
      const executable = join(root, 'unavailable-launcher');
      await writeFile(executable, '#!/nonexistent/cleo-hook-interpreter\n');
      await chmod(executable, 0o755);
      await manifest({
        executable: './unavailable-launcher',
        checkerErrorPolicy: 'block',
        bindings: [
          { source: 'git', event: 'pre-push' },
          { source: 'ci', event: 'check' },
        ],
      });
      await activateProjectHooks(root);
      expect((await executeProjectHooks(invocation))[0]).toMatchObject({
        status: 'infrastructure-error',
        blocks: false,
        code: 'HOOK_EXECUTION_FAILED',
      });
      expect(
        (await executeProjectHooks({ ...invocation, source: 'ci', event: 'check' }))[0],
      ).toMatchObject({
        status: 'infrastructure-error',
        blocks: true,
        code: 'HOOK_EXECUTION_FAILED',
      });
    },
  );
  it('rejects symlink escapes, duplicate IDs and reserved identities', async () => {
    await symlink(process.execPath, join(root, 'outside.mjs'));
    await manifest({ handler: 'outside.mjs' });
    await expect(activateProjectHooks(root)).rejects.toThrow('HOOK_PATH_ESCAPE');
    await manifest({ id: 'cleo.overwrite' });
    await expect(activateProjectHooks(root)).rejects.toThrow();
    await manifest();
    const source = JSON.parse(
      await readFile(join(root, '.cleo/hooks.json'), 'utf8'),
    ) as ProjectHooksManifest;
    source.hooks.push(source.hooks[0]);
    await writeFile(join(root, '.cleo/hooks.json'), JSON.stringify(source));
    await expect(activateProjectHooks(root)).rejects.toThrow('Duplicate hook ID');
  });
  it('replays exact pushed refs without using HEAD or inferring shell commands', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'let s="";for await(const c of process.stdin)s+=c;const i=JSON.parse(s);process.stdout.write(JSON.stringify({status:i.refs[0].localOid==="b".repeat(40)?"pass":"block"}));',
    );
    await activateProjectHooks(root);
    const refs = [
      {
        localRef: 'refs/heads/other',
        localOid: 'b'.repeat(40),
        remoteRef: 'refs/heads/review',
        remoteOid: '0'.repeat(40),
      },
    ];
    expect((await executeProjectHooks({ ...invocation, refs }))[0].status).toBe('pass');
    expect(await executeProjectHooks({ ...invocation, event: 'ordinary-command' })).toEqual([]);
  });
  it('executes definitions in manifest order, preserving every result', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'import{appendFileSync}from"node:fs";appendFileSync("order.txt",process.argv[2]);process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await manifest({ args: ['first'] });
    const source = JSON.parse(
      await readFile(join(root, '.cleo/hooks.json'), 'utf8'),
    ) as ProjectHooksManifest;
    source.hooks.push({ ...source.hooks[0], id: 'second-check', args: ['second'] });
    await writeFile(join(root, '.cleo/hooks.json'), JSON.stringify(source));
    await activateProjectHooks(root);
    expect((await executeProjectHooks(invocation)).map((outcome) => outcome.id)).toEqual([
      'migration-check',
      'second-check',
    ]);
    expect(await readFile(join(root, 'order.txt'), 'utf8')).toBe('firstsecond');
  });
  it('refuses later code changed by an earlier checker in the same invocation', async () => {
    await writeFile(
      join(root, 'handler.mjs'),
      'import{writeFileSync}from"node:fs";writeFileSync("later.mjs", `process.stdout.write(JSON.stringify({status:"pass"}));`);process.stdout.write(JSON.stringify({status:"pass"}));',
    );
    await writeFile(
      join(root, 'later.mjs'),
      'process.stdout.write(JSON.stringify({status:"block"}));',
    );
    const source = JSON.parse(
      await readFile(join(root, '.cleo/hooks.json'), 'utf8'),
    ) as ProjectHooksManifest;
    source.hooks.push({ ...source.hooks[0], id: 'later-check', handler: 'later.mjs' });
    await writeFile(join(root, '.cleo/hooks.json'), JSON.stringify(source));
    await activateProjectHooks(root);
    expect(await executeProjectHooks(invocation)).toMatchObject([
      { id: 'migration-check', status: 'pass' },
      { id: 'later-check', code: 'HOOK_REACTIVATION_REQUIRED', blocks: true },
    ]);
  });
  it('a drifted source also refuses hooks only the linked checkout binds (T13742 F1-B)', async () => {
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', root, 'add', '.cleo/hooks.json', 'handler.mjs']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'test(T13742): linked checkout']);
    await activateProjectHooks(root);
    const checkout = `${root}-wt-only`;
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', checkout, 'HEAD'], {
      stdio: 'ignore',
    });
    try {
      const source = JSON.parse(
        await readFile(join(checkout, '.cleo/hooks.json'), 'utf8'),
      ) as ProjectHooksManifest;
      source.hooks.push({
        ...source.hooks[0],
        id: 'worktree-only',
        bindings: [{ source: 'worktree', event: 'post-start' }],
      });
      await writeFile(join(checkout, '.cleo/hooks.json'), JSON.stringify(source));
      await writeFile(join(root, 'handler.mjs'), 'process.exit(3);');
      const context = resolveProjectHookContext(checkout);
      expect(
        await createProjectHookExecutor(root).execute({
          schemaVersion: 1,
          projectRoot: checkout,
          gitCommonDir: context.gitCommonDir,
          source: 'worktree',
          event: 'post-start',
        }),
      ).toMatchObject([{ id: 'worktree-only', status: 'block', blocks: true }]);
    } finally {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', checkout]);
    }
  });
  it('a handler deleted in the linked checkout refuses worktree start (T13742 F1-E)', async () => {
    await manifest({ bindings: [{ source: 'worktree', event: 'post-start' }] });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', root, 'add', '.cleo/hooks.json', 'handler.mjs']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'test(T13742): deleted linked handler']);
    await activateProjectHooks(root);
    const checkout = `${root}-deleted`;
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', checkout, 'HEAD'], {
      stdio: 'ignore',
    });
    try {
      await rm(join(checkout, 'handler.mjs'));
      const context = resolveProjectHookContext(checkout);
      expect(
        await createProjectHookExecutor(root).execute({
          schemaVersion: 1,
          projectRoot: checkout,
          gitCommonDir: context.gitCommonDir,
          source: 'worktree',
          event: 'post-start',
        }),
      ).toMatchObject([{ id: 'migration-check', status: 'block', blocks: true }]);
    } finally {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', checkout]);
    }
  });
  it('inherits approval into an identical linked checkout and rejects changed code', async () => {
    await manifest({ bindings: [{ source: 'worktree', event: 'post-start' }] });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
    execFileSync('git', ['-C', root, 'add', '.cleo/hooks.json', 'handler.mjs']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'test(T13345): identical worktree']);
    await activateProjectHooks(root);
    const checkout = `${root}-checkout`;
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', checkout, 'HEAD'], {
      stdio: 'ignore',
    });
    try {
      const context = resolveProjectHookContext(checkout);
      const request: HookInvocation = {
        schemaVersion: 1,
        projectRoot: checkout,
        gitCommonDir: context.gitCommonDir,
        source: 'worktree',
        event: 'post-start',
      };
      const executor = createProjectHookExecutor(root);
      expect((await executor.execute(request))[0].status).toBe('pass');
      await writeFile(join(checkout, 'handler.mjs'), 'process.exit(9);');
      expect((await executor.execute(request))[0]).toMatchObject({
        id: 'migration-check',
        status: 'block',
        blocks: true,
        code: 'HOOK_REACTIVATION_REQUIRED',
      });
    } finally {
      execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', checkout]);
    }
  });
});
