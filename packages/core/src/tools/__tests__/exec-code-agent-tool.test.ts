/**
 * Tests for the `execute_code` agent tool (T11946 · M7 · epic T11456).
 *
 * FULLY MOCKED — no real Gondolin VM, no QEMU, no `/dev/kvm`, no real subprocess.
 * The execution env is supplied through an INJECTED fake selector that returns a
 * fake {@link PiExecutionEnv}, so every assertion runs in-process with the optional
 * `@earendil-works/gondolin` package ABSENT (the CI / most-developer-machines path).
 *
 * Covers:
 *   - AC1 registered via the self-registering marker (not inline) + part of the
 *     built-in catalog;
 *   - AC2 resolves a PiExecutionEnv through `resolveExecutionEnv` and runs the
 *     snippet via `env.exec` (selector IS called, output IS captured), with
 *     gondolin ABSENT (the in-process path);
 *   - availability mirrors browser_* — hidden unless `capabilities.codeExec === true`;
 *   - egress verbs (gh / git push / npm publish / cleo) denied BEFORE `env.exec`;
 *   - Zod schema validation (bad language / missing code → invalid-args);
 *   - the dispatch engine's availability + timeout gating honored unchanged.
 *
 * @task T11946
 * @epic T11456
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it, vi } from 'vitest';
import type { PiExecutionEnv } from '../../llm/pi/pi-execution-env.js';
import type {
  ResolveExecutionEnvOptions,
  ResolveExecutionEnvSeams,
} from '../../llm/pi/resolve-execution-env.js';
import { AgentToolRegistry } from '../agent-registry.js';
import { registerBuiltinAgentTools } from '../builtin-agent-tools.js';
import { ToolCallBudget, ToolDispatchEngine } from '../dispatch.js';
import {
  buildExecCommand,
  codeExecAvailable,
  EXEC_CODE_LANGUAGES,
  type ExecCodeResult,
  type ExecutionEnvResolver,
  registerExecCodeAgentTool,
} from '../exec-code-agent-tool.js';
import { createToolGuard } from '../guard.js';

// ===========================================================================
// Test doubles
// ===========================================================================

/** A captured `exec` call: the command line + the options the env received. */
interface ExecCall {
  readonly command: string;
  readonly timeout: number | undefined;
}

/**
 * Build a fake {@link PiExecutionEnv} that records every `exec` call and returns a
 * canned process result. NO real VM / QEMU / subprocess — only the `exec` +
 * `cleanup` members the tool touches are meaningful; the rest are inert stubs.
 */
function fakeEnv(canned: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** When set, `exec` returns a typed Result.err instead of a process result. */
  err?: { code: string; message: string };
}): { env: PiExecutionEnv; execCalls: ExecCall[]; cleanups: number } {
  const execCalls: ExecCall[] = [];
  const state = { cleanups: 0 };
  const env: PiExecutionEnv = {
    cwd: () => '/workspace',
    absolutePath: (p) => p,
    joinPath: (...s) => s.join('/'),
    readTextFile: async () => ({ ok: true, value: '' }),
    readTextLines: async () => ({ ok: true, value: [] }),
    readBinaryFile: async () => ({ ok: true, value: new Uint8Array() }),
    writeFile: async () => ({ ok: true, value: undefined }),
    appendFile: async () => ({ ok: true, value: undefined }),
    fileInfo: async () => ({ ok: true, value: { isFile: true, isDirectory: false } }),
    listDir: async () => ({ ok: true, value: [] }),
    canonicalPath: async () => ({ ok: true, value: '/workspace' }),
    exists: async () => ({ ok: true, value: true }),
    createDir: async () => ({ ok: true, value: undefined }),
    remove: async () => ({ ok: true, value: undefined }),
    createTempDir: async () => ({ ok: true, value: '/workspace' }),
    createTempFile: async () => ({ ok: true, value: '/workspace' }),
    exec: async (command, options) => {
      execCalls.push({ command, timeout: options?.timeout });
      if (canned.err !== undefined) {
        return { ok: false, error: canned.err };
      }
      return {
        ok: true,
        value: {
          stdout: canned.stdout ?? '',
          stderr: canned.stderr ?? '',
          exitCode: canned.exitCode ?? 0,
        },
      };
    },
    cleanup: async () => {
      state.cleanups += 1;
    },
  };
  return {
    env,
    execCalls,
    get cleanups() {
      return state.cleanups;
    },
  } as { env: PiExecutionEnv; execCalls: ExecCall[]; cleanups: number };
}

/** A guarded surface stub — the tool resolves its OWN env, so this is never used. */
const noopGuardedSurface = {} as GuardedToolSurface;

// ===========================================================================
// AC1 — registration via the self-registering marker
// ===========================================================================

describe('execute_code — registration (AC1)', () => {
  it('exports a self-registering marker that registers execute_code', async () => {
    const mod = await import('../exec-code-agent-tool.js');
    expect(typeof mod.registerAgentTools).toBe('function');
    const registry = new AgentToolRegistry();
    mod.registerAgentTools(registry);
    expect(registry.get('execute_code')).toBeDefined();
  });

  it('is part of the built-in catalog with the right class/toolset', async () => {
    const registry = new AgentToolRegistry();
    registerBuiltinAgentTools(registry);
    await registry.init({ skipBuiltins: true });
    const tool = registry.get('execute_code');
    expect(tool).toBeDefined();
    expect(tool?.class).toBe('shell');
    expect(tool?.toolset).toBe('agent');
    expect(tool?.stateless).toBe(true);
    // The tool lands in the `agent` toolset bucket (AC4).
    expect(registry.byToolset('agent').some((t) => t.name === 'execute_code')).toBe(true);
  });
});

// ===========================================================================
// AC — availability mirrors browser_* (hidden unless capabilities.codeExec)
// ===========================================================================

describe('execute_code — availability gating', () => {
  it('codeExecAvailable is false unless capabilities.codeExec === true', () => {
    expect(codeExecAvailable({})).toBe(false);
    expect(codeExecAvailable({ capabilities: {} })).toBe(false);
    expect(codeExecAvailable({ capabilities: { codeExec: false } })).toBe(false);
    expect(codeExecAvailable({ capabilities: { codeExec: true } })).toBe(true);
  });

  it('is registered but hidden by available() until the capability is advertised', async () => {
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry);
    await registry.init({ skipBuiltins: true });
    // Registered (visible in list) ...
    expect(registry.list().some((t) => t.name === 'execute_code')).toBe(true);
    // ... but NOT available without the capability ...
    expect(registry.available({}).some((t) => t.name === 'execute_code')).toBe(false);
    // ... and available once the host opts code-exec in.
    expect(
      registry
        .available({ capabilities: { codeExec: true } })
        .some((t) => t.name === 'execute_code'),
    ).toBe(true);
  });
});

// ===========================================================================
// AC2 — resolves a PiExecutionEnv via the selector + runs via env.exec
// ===========================================================================

describe('execute_code — execution via the selector (AC2, gondolin absent)', () => {
  it('calls the injected selector and captures env.exec stdout/stderr/exit', async () => {
    const { env, execCalls } = fakeEnv({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    const resolveCalls: ResolveExecutionEnvOptions[] = [];
    const resolveEnv: ExecutionEnvResolver = async (
      opts: ResolveExecutionEnvOptions,
      _seams?: ResolveExecutionEnvSeams,
    ) => {
      resolveCalls.push(opts);
      return env;
    };

    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    await registry.init({ skipBuiltins: true });

    const exec = registry.getExecutable('execute_code');
    expect(exec).toBeDefined();
    const result = (await exec?.(
      { language: 'python', code: "print('hello')" },
      noopGuardedSurface,
    )) as ExecCodeResult;

    // The SELECTOR was called (the tool reused resolveExecutionEnv) ...
    expect(resolveCalls).toHaveLength(1);
    // ... preferring the gondolin backend by default (degrades to in-process when
    // the package / kvm / qemu is absent — which the fake selector simulates) ...
    expect(resolveCalls[0]?.backend).toBe('gondolin');
    // ... and the snippet ran via env.exec with a well-formed command line ...
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.command).toBe(`python -c 'print('\\''hello'\\'')'`);
    // ... and the captured output is surfaced.
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    expect(result.language).toBe('python');
    expect(result.backend).toBe('gondolin');
  });

  it('forwards timeoutMs to env.exec and tears the env down (cleanup) once', async () => {
    const fake = fakeEnv({ stdout: 'ok', exitCode: 0 });
    const resolveEnv: ExecutionEnvResolver = async () => fake.env;
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    await registry.init({ skipBuiltins: true });

    await registry.getExecutable('execute_code')?.(
      { language: 'node', code: 'console.log(1)', timeoutMs: 5000 },
      noopGuardedSurface,
    );
    expect(fake.execCalls[0]?.timeout).toBe(5000);
    expect(fake.execCalls[0]?.command).toBe(`node -e 'console.log(1)'`);
    expect(fake.cleanups).toBe(1);
  });

  it('surfaces a typed Result.err from env.exec as a non-ok run (never throws)', async () => {
    const { env } = fakeEnv({ err: { code: 'E_PI_EXEC_FAILED', message: 'spawn ENOENT' } });
    const resolveEnv: ExecutionEnvResolver = async () => env;
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    await registry.init({ skipBuiltins: true });

    const result = (await registry.getExecutable('execute_code')?.(
      { language: 'bash', code: 'echo hi' },
      noopGuardedSurface,
    )) as ExecCodeResult;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_PI_EXEC_FAILED');
  });
});

// ===========================================================================
// AC2 — egress denylist honored BEFORE env.exec
// ===========================================================================

describe('execute_code — egress denylist (AC2)', () => {
  it.each([
    ['gh', 'gh pr create'],
    ['git push', 'git push origin main'],
    ['npm publish', 'npm publish'],
    ['cleo', 'cleo complete T1'],
    ['git remote', 'git remote add x y'],
  ])('denies %s before resolving / running the env', async (_label, snippet) => {
    const { env, execCalls } = fakeEnv({ stdout: '', exitCode: 0 });
    let resolveCalled = false;
    const resolveEnv: ExecutionEnvResolver = async () => {
      resolveCalled = true;
      return env;
    };
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    await registry.init({ skipBuiltins: true });

    const result = (await registry.getExecutable('execute_code')?.(
      { language: 'bash', code: snippet },
      noopGuardedSurface,
    )) as ExecCodeResult;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_EXEC_CODE_EGRESS_DENIED');
    // The egress verb is rejected BEFORE the env is resolved or exec is called.
    expect(resolveCalled).toBe(false);
    expect(execCalls).toHaveLength(0);
  });

  it('allows a non-egress git read verb (git status)', async () => {
    const { env, execCalls } = fakeEnv({ stdout: 'clean', exitCode: 0 });
    const resolveEnv: ExecutionEnvResolver = async () => env;
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    await registry.init({ skipBuiltins: true });

    const result = (await registry.getExecutable('execute_code')?.(
      { language: 'bash', code: 'git status' },
      noopGuardedSurface,
    )) as ExecCodeResult;
    expect(result.ok).toBe(true);
    expect(execCalls).toHaveLength(1);
  });
});

// ===========================================================================
// buildExecCommand — per-language shaping
// ===========================================================================

describe('buildExecCommand', () => {
  it('shapes each language to its inline-code flag with single-quoted code', () => {
    expect(buildExecCommand('python', 'x=1')).toBe(`python -c 'x=1'`);
    expect(buildExecCommand('node', 'x')).toBe(`node -e 'x'`);
    expect(buildExecCommand('bash', 'echo hi')).toBe(`bash -c 'echo hi'`);
    expect(buildExecCommand('sh', 'echo hi')).toBe(`sh -c 'echo hi'`);
  });

  it('escapes embedded single quotes safely', () => {
    expect(buildExecCommand('bash', `echo 'a'`)).toBe(`bash -c 'echo '\\''a'\\'''`);
  });

  it('covers every supported language', () => {
    for (const lang of EXEC_CODE_LANGUAGES) {
      expect(buildExecCommand(lang, 'noop')).toContain('noop');
    }
  });
});

// ===========================================================================
// Dispatch engine integration — frozen engine unchanged
// ===========================================================================

describe('execute_code — through the frozen ToolDispatchEngine', () => {
  function engineFor(
    resolveEnv: ExecutionEnvResolver,
    opts?: { codeExec?: boolean; budget?: ToolCallBudget },
  ) {
    const registry = new AgentToolRegistry();
    registerExecCodeAgentTool(registry, { resolveEnv });
    return registry.init({ skipBuiltins: true }).then(
      () =>
        new ToolDispatchEngine({
          registry,
          tools: createToolGuard({ mode: 'enforce' }),
          availability: opts?.codeExec === false ? {} : { capabilities: { codeExec: true } },
          ...(opts?.budget ? { budget: opts.budget } : {}),
        }),
    );
  }

  it('dispatches a valid call to a captured success result', async () => {
    const { env } = fakeEnv({ stdout: '42\n', exitCode: 0 });
    const engine = await engineFor(async () => env);
    const res = await engine.dispatch({
      id: 'c1',
      name: 'execute_code',
      arguments: { language: 'python', code: 'print(42)' },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.name).toBe('execute_code');
      expect(res.display).toContain('42');
    }
  });

  it('is guard-denied when the codeExec capability is absent', async () => {
    const { env } = fakeEnv({ stdout: '', exitCode: 0 });
    const engine = await engineFor(async () => env, { codeExec: false });
    const res = await engine.dispatch({
      id: 'c2',
      name: 'execute_code',
      arguments: { language: 'python', code: 'print(1)' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('guard-denied');
  });

  it('rejects invalid arguments (bad language) as invalid-args', async () => {
    const { env } = fakeEnv({ stdout: '', exitCode: 0 });
    const engine = await engineFor(async () => env);
    const res = await engine.dispatch({
      id: 'c3',
      name: 'execute_code',
      arguments: { language: 'ruby', code: 'puts 1' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('rejects a missing code argument as invalid-args', async () => {
    const { env } = fakeEnv({ stdout: '', exitCode: 0 });
    const engine = await engineFor(async () => env);
    const res = await engine.dispatch({
      id: 'c4',
      name: 'execute_code',
      arguments: { language: 'python' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it("honors the dispatch engine's per-call timeout (slow env.exec → timeout)", async () => {
    const slowEnv = fakeEnv({ stdout: 'late', exitCode: 0 });
    // Make exec hang past the per-call timeout.
    const env: PiExecutionEnv = {
      ...slowEnv.env,
      exec: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true as const, value: { stdout: 'late', stderr: '', exitCode: 0 } };
      }),
    };
    const engine = await engineFor(async () => env, {
      budget: new ToolCallBudget({ perCallTimeoutMs: 20 }),
    });
    const res = await engine.dispatch({
      id: 'c5',
      name: 'execute_code',
      arguments: { language: 'python', code: 'slow' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('timeout');
  });
});
