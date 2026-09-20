/**
 * Gate runner tests — comprehensive coverage per gate kind.
 *
 * Tests `runGates()` from packages/core/src/tasks/gate-runner.ts
 * ensuring each gate type (test, file, command, lint, http, manual)
 * works correctly with contract validation.
 *
 * @task T784
 * @epic T768
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AcceptanceGate,
  AcRow,
  CommandGate,
  FileGate,
  HttpGate,
  LintGate,
  ManualGate,
  Task,
  TestGate,
} from '@cleocode/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _forceSystemdRunAvailable } from '../../resources/spawn-wrapper.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { acItemToText, acTextHash, buildFreshAcRows } from '../ac-table.js';
import { revalidateTaskGateResults, runGates, runTaskGates } from '../gate-runner.js';

// ─── Setup ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-gate-runner-'));
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'gate-fixture' }));
  await mkdir(join(projectRoot, '.cleo'));
  await writeFile(
    join(projectRoot, '.cleo/project-info.json'),
    JSON.stringify({
      projectId: 'gate-fixture',
      projectHash: 'gate-fixture-path',
    }),
  );
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

// ─── Gate Kind Tests ────────────────────────────────────────────────────────

describe('gate-runner — test gate', () => {
  it('accepts a test gate with passing exit code', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'sample-test — validates passing test gate',
        command: 'echo',
        args: ['hello'],
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'pass',
    });
  });

  it('rejects a test gate with failing exit code', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'failing-test — validates failing test gate',
        command: 'false',
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'test',
      result: 'fail',
    });
    // Gate-runner emits `errorMessage` on fail (not free-text failureReason)
    expect(results[0].errorMessage).toBeDefined();
  });
});

describe('gate-runner — file gate', () => {
  it('validates file existence', async () => {
    // Verify the actual file created in the isolated gate project
    const existingFile = join(projectRoot, 'package.json');

    const gates: FileGate[] = [
      {
        kind: 'file',
        description: 'package-json-exists — validates file gate pass',
        path: existingFile,
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'pass',
    });
  });

  it('rejects when file does not exist', async () => {
    const gates: FileGate[] = [
      {
        kind: 'file',
        description: 'nonexistent — validates file gate fail',
        path: '/tmp/this-does-not-exist-12345.txt',
        assertions: [{ type: 'exists' }],
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'file',
      result: 'fail',
    });
  });
});

describe('gate-runner — command gate', () => {
  it('passes with successful command', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'echo-test — validates command execution',
        cmd: 'echo',
        args: ['test output'],
        exitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'pass',
    });
  });

  it('fails with unexpected exit code', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'false-command — validates exit-code rejection',
        cmd: 'false',
        exitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'command',
      result: 'fail',
    });
  });
});

describe('gate-runner — lint gate', () => {
  it('returns an incomplete observation when the requested lint tool cannot start', async () => {
    // This test verifies that lint gates handle missing tools gracefully
    const gates: LintGate[] = [
      {
        kind: 'lint',
        description: 'biome-format — validates lint gate',
        tool: 'biome',
        args: ['check', '.'],
        expect: 'clean',
      },
    ];

    const results = await runGates(gates, { projectRoot, env: { PATH: projectRoot } });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'lint',
    });
    expect(results[0]).toMatchObject({
      result: 'error',
      execution: { started: false, exitCode: null },
    });
  });
});

describe('gate-runner — http gate', () => {
  it('skips http gate when network unavailable', async () => {
    const gates: HttpGate[] = [
      {
        kind: 'http',
        description: 'health-check — validates http gate',
        url: 'http://127.0.0.1:99999/health',
        status: 200,
        timeoutMs: 1000,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'http',
    });
    // Should fail or skip depending on network configuration
    expect(['fail', 'skipped', 'warn', 'error']).toContain(results[0].result);
  });
});

describe('gate-runner — manual gate', () => {
  it('returns skipped for manual gates by default', async () => {
    const gates: ManualGate[] = [
      {
        kind: 'manual',
        description: 'manual-review — validates manual gate',
        prompt: 'Please review the implementation',
      },
    ];

    const results = await runGates(gates, { projectRoot, skipManual: true });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'manual',
      result: 'skipped',
    });
  });

  it('returns skipped for manual gates without skipManual flag', async () => {
    const gates: ManualGate[] = [
      {
        kind: 'manual',
        description: 'manual-review-2 — validates manual gate with accept',
        prompt: 'Please review',
      },
    ];

    const results = await runGates(gates, { projectRoot, skipManual: false });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'manual',
      result: 'skipped',
    });
  });
});

describe('gate-runner — multi-gate execution', () => {
  it('runs multiple gates sequentially', async () => {
    const gates: AcceptanceGate[] = [
      {
        kind: 'test' as const,
        description: 'test-1 — multi-gate test gate',
        command: 'echo',
        args: ['test1'],
        expect: 'exit0' as const,
      },
      {
        kind: 'command' as const,
        description: 'cmd-1 — multi-gate command gate',
        cmd: 'echo',
        args: ['cmd1'],
        exitCode: 0,
      },
      {
        kind: 'manual' as const,
        description: 'manual-1 — multi-gate manual gate',
        prompt: 'Review test',
      },
    ];

    const results = await runGates(gates, { projectRoot, skipManual: true });

    expect(results).toHaveLength(3);
    expect(results[0].result).toBe('pass');
    expect(results[1].result).toBe('pass');
    expect(results[2].result).toBe('skipped');
  });

  it('includes metadata in results', async () => {
    const gates: TestGate[] = [
      {
        kind: 'test',
        description: 'metadata-test — validates result metadata shape',
        command: 'echo',
        args: ['hello'],
        expect: 'exit0',
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    const result = results[0];

    // AcceptanceGateResult contract shape (v2026.4.72):
    // index, req, kind, result, durationMs, details, checkedAt, checkedBy
    expect(result).toHaveProperty('kind');
    expect(result).toHaveProperty('index');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('checkedAt');
    expect(result).toHaveProperty('durationMs');
  });
});

describe('gate-runner — integration with contract types', () => {
  it('validates all gate kinds together', async () => {
    const gates: AcceptanceGate[] = [
      {
        kind: 'test' as const,
        description: 'test-1 — integration test gate',
        command: 'echo',
        args: ['test'],
        expect: 'exit0' as const,
      },
      {
        kind: 'command' as const,
        description: 'cmd-1 — integration command gate',
        cmd: 'echo',
        args: ['cmd'],
        exitCode: 0,
      },
      {
        kind: 'manual' as const,
        description: 'manual-1 — integration manual gate',
        prompt: 'Review manual',
      },
    ];

    const results = await runGates(gates, { projectRoot, skipManual: true });

    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r) => r.result)).toBe(true);
  });
});

describe('gate-runner — a killed gate is not a failed gate (gh#1270)', () => {
  it('records a timed-out gate as error, never fail', async () => {
    // The defect: a gate killed by its own timeout was recorded as `fail`.
    // An agent then reports a red that never happened and redoes or abandons
    // work that actually succeeded. Reported twice in the field:
    // "Agents twice reported a gate as FAILED when it had only been killed —
    // a false red is as costly as a false green."
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'sleep — never finishes within its budget',
        cmd: 'sleep',
        args: ['30'],
        exitCode: 0,
        timeoutMs: 300,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results).toHaveLength(1);
    expect(results[0]?.result).toBe('error');
    // The precise assertion: it must not be reportable as a verdict.
    expect(results[0]?.result).not.toBe('fail');
    expect(results[0]?.result).not.toBe('pass');
  }, 20_000);

  it('says plainly that the gate did not finish', async () => {
    // The message is what an agent reads before deciding whether to redo work.
    const results = await runGates(
      [
        {
          kind: 'command',
          description: 'sleep — never finishes within its budget',
          cmd: 'sleep',
          args: ['30'],
          exitCode: 0,
          timeoutMs: 300,
        } satisfies CommandGate,
      ],
      { projectRoot },
    );

    expect(results[0]?.errorMessage).toMatch(/did not finish/i);
    expect(results[0]?.errorMessage).toMatch(/NOT a failure/i);
  }, 20_000);

  it('does not downgrade a killed advisory gate to warn', async () => {
    // `advisory` softens a VERDICT. A killed gate has no verdict to soften, and
    // 'warn' reads as "we looked and it was nearly fine" — the opposite of
    // "we never finished looking".
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'sleep — advisory gate that never finishes',
        cmd: 'sleep',
        args: ['30'],
        exitCode: 0,
        timeoutMs: 300,
        advisory: true,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results[0]?.result).toBe('error');
    expect(results[0]?.result).not.toBe('warn');
  }, 20_000);

  it('still reports a real failure as fail — the fix must not hide verdicts', async () => {
    const gates: CommandGate[] = [
      {
        kind: 'command',
        description: 'false-command — a gate that genuinely fails',
        cmd: 'false',
        exitCode: 0,
      },
    ];

    const results = await runGates(gates, { projectRoot });

    expect(results[0]?.result).toBe('fail');
  });
});

describe('gate runner target verdict and shared execution (T12292)', () => {
  it('does not pass a missing executable merely because exit1 was expected', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'command',
          description: 'missing target',
          cmd: '/no-such-cleo-gate-executable',
          exitCode: 1,
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toContain('ENOENT');
  });

  it('uses actual nonzero target exit codes without inventing exit1', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'command',
          description: 'actual exit7',
          cmd: process.execPath,
          args: ['-e', 'process.exit(7)'],
          exitCode: 7,
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('pass');
  });

  it('retains a missing harness as an unmet test requirement', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'missing harness',
          command: process.execPath,
          args: [join(projectRoot, 'missing-harness.mjs')],
          expect: 'exit0',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('fail');
    expect(result?.evidence).toContain('MODULE_NOT_FOUND');
  });

  it('does not silently accept an unmeasured minimum test count', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'zero tests cannot prove minimum',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          expect: 'exit0',
          minCount: 5,
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/count/i);
  });
});

describe('gate runner immutable lifetime and bounded evidence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _forceSystemdRunAvailable(undefined);
  });

  function execution(options: Parameters<typeof createOperationExecutionContext>[1] = {}) {
    return createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'gate-test',
        operation: 'tasks.verify',
        idempotencyKey: 'gate-fixture-check',
      },
      options,
    );
  }

  it('does not renew the shared deadline for subsequent gates', async () => {
    _forceSystemdRunAvailable(false);
    const context = execution({ budgetMs: 150 });
    const marker = join(projectRoot, 'late-deadline-marker');
    try {
      const results = await runGates(
        [
          {
            kind: 'command',
            description: 'slow first',
            cmd: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            timeoutMs: 1800000,
          },
          {
            kind: 'command',
            description: 'must not start',
            cmd: process.execPath,
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'late')`],
            timeoutMs: 1800000,
          },
        ],
        { projectRoot, execution: context },
      );
      expect(results.map((result) => result.result)).toEqual(['error', 'error']);
      expect(results[0]?.execution?.stopped).toBe('deadline');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      context.close();
    }
  });

  it('rejects a project override outside the captured operation before execution', async () => {
    const context = execution();
    try {
      await expect(
        runGates(
          [
            {
              kind: 'command',
              description: 'wrong project',
              cmd: process.execPath,
              args: ['-e', 'process.exit(0)'],
            },
          ],
          { projectRoot: join(projectRoot, 'other'), execution: context },
        ),
      ).rejects.toThrow(/project.*captured/i);
    } finally {
      context.close();
    }
  });

  it('retains cancellation as interruption and prevents later gates', async () => {
    _forceSystemdRunAvailable(false);
    const controller = new AbortController();
    const context = execution({ budgetMs: 2000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('fixture cancellation')), 100);
    try {
      const results = await runGates(
        [
          {
            kind: 'command',
            description: 'cancel first',
            cmd: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
          },
          { kind: 'manual', description: 'later', prompt: 'later manual' },
        ],
        { projectRoot, execution: context },
      );
      expect(results.map((result) => result.result)).toEqual(['error', 'error']);
      expect(results[0]?.execution?.stopped).toBe('cancelled');
    } finally {
      clearTimeout(timer);
      context.close();
    }
  });

  it('charges aggregate admission before the next gate starts', async () => {
    const context = execution({ resources: { maxItems: 1 } });
    try {
      const results = await runGates(
        [
          { kind: 'manual', description: 'first', prompt: 'first' },
          { kind: 'manual', description: 'second', prompt: 'second' },
        ],
        { projectRoot, execution: context },
      );
      expect(results.map((result) => result.result)).toEqual(['skipped', 'error']);
      expect(results[1]?.errorMessage).toMatch(/resource|item/i);
    } finally {
      context.close();
    }
  });

  it('captures exact argv, environment, cwd and requirement before caller edits', async () => {
    _forceSystemdRunAvailable(false);
    const gate: CommandGate = {
      kind: 'command',
      description: 'captured gate',
      req: 'PARTNER-EXACT',
      cmd: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.GATE_VALUE,arg:process.argv[1]}))',
        'quoted | ü',
      ],
    };
    const env = { GATE_VALUE: 'original' };
    const pending = runGates([gate], { projectRoot, env });
    gate.req = 'MUTATED';
    gate.args = ['-e', 'process.exit(9)'];
    env.GATE_VALUE = 'changed';
    const [result] = await pending;
    expect(result).toMatchObject({ req: 'PARTNER-EXACT', result: 'pass' });
    expect(JSON.parse(result?.execution?.stdout ?? '{}')).toEqual({
      cwd: projectRoot,
      value: 'original',
      arg: 'quoted | ü',
    });
  });

  it('rejects output truncation rather than accepting a prefix as proof', async () => {
    _forceSystemdRunAvailable(false);
    const [result] = await runGates(
      [
        {
          kind: 'command',
          description: 'oversized output',
          cmd: process.execPath,
          args: ['-e', "process.stdout.write('x'.repeat(2048))"],
        },
      ],
      { projectRoot, maxOutputBytes: 32 },
    );
    expect(result).toMatchObject({
      result: 'error',
      execution: { stopped: 'output-limit', outputTruncated: true },
    });
  });

  it('fails resource admission truthfully when requested native limits cannot be established', async () => {
    _forceSystemdRunAvailable(false);
    const [result] = await runGates(
      [
        {
          kind: 'command',
          description: 'bounded only',
          cmd: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      ],
      { projectRoot, memoryMaxMb: 4096, tasksMax: 256 },
    );
    expect(result).toMatchObject({
      result: 'error',
      execution: { started: false, stopped: 'resource-limit' },
    });
  });

  it('does not convert a file read diagnostic into empty successful content', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'file',
          description: 'directory is not content',
          path: projectRoot,
          assertions: [{ type: 'contains', value: '' }],
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/EISDIR/);
  });

  it('enforces file byte bounds for hashes as well as text predicates', async () => {
    const path = join(projectRoot, 'oversized.bin');
    await writeFile(path, Buffer.alloc(100, 1));
    const [result] = await runGates(
      [
        {
          kind: 'file',
          description: 'bounded digest',
          path,
          assertions: [{ type: 'sha256', value: 'a'.repeat(64) }],
        },
      ],
      { projectRoot, maxOutputBytes: 10 },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/byte limit/);
  });

  it('retains HTTP failure and oversized bodies as incomplete observations', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('fixture network failure'))
        .mockResolvedValueOnce(new Response('x'.repeat(100))),
    );
    const gate: HttpGate = {
      kind: 'http',
      description: 'bounded response',
      url: 'https://fixture.invalid',
      status: 200,
    };
    const [failed] = await runGates([gate], { projectRoot });
    expect(failed?.result).toBe('error');
    const [oversized] = await runGates([gate], { projectRoot, maxOutputBytes: 10 });
    expect(oversized?.result).toBe('error');
    expect(oversized?.errorMessage).toMatch(/byte limit/);
  });
});

describe('task-bound explicit gate verification (T12292)', () => {
  function admitted() {
    return createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'bound-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 'bound-attempt',
      },
      { budgetMs: 2000 },
    );
  }
  function taskAndRows(script: string) {
    const task: Task = {
      id: 'T122',
      title: 'Bound verification',
      description: 'Actual task-specific process verification fixture',
      status: 'active',
      type: 'task',
      priority: 'medium',
      createdAt: '2026-09-20T00:00:00.000Z',
      files: [script],
      acceptance: [
        'Literal | text',
        {
          kind: 'test',
          command: process.execPath,
          args: [script, '--task', 'T122'],
          expect: 'exit0',
          req: 'PARTNER-122',
          description: 'Actual harness must run',
          timeoutMs: 1800000,
        },
      ],
    };
    const rows: AcRow[] = buildFreshAcRows(task.id, task.acceptance).map((row) => ({
      ...row,
      kind: row.kind ?? 'text',
      sourceKey: row.sourceKey ?? '',
      projection: row.projection ?? 'legacy',
      targetTaskId: row.targetTaskId ?? null,
      contentHash: row.contentHash ?? null,
      createdAt: task.createdAt,
      updatedAt: null,
    }));
    return { task, rows };
  }
  beforeEach(() => _forceSystemdRunAvailable(false));
  afterEach(() => _forceSystemdRunAvailable(undefined));

  it('binds actual untracked harness bytes, original mixed index and captured lifetime', async () => {
    const script = 'bound-pass.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    try {
      const results = await runTaskGates(task, rows, { execution });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        index: 1,
        req: 'PARTNER-122',
        result: 'pass',
        checkedBy: 'bound-agent',
        binding: {
          taskId: task.id,
          criterionId: rows[1]!.id,
          deadlineAt: execution.deadlineAt,
          identity: execution.identity,
          artifacts: [{ path: join(projectRoot, script), bytes: 16 }],
        },
      });
      expect(results[0]!.binding!.invocation!.args).toEqual([script, '--task', 'T122']);
      expect(results[0]!.binding!.artifacts[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        revalidateTaskGateResults(task, rows, results, { execution }),
      ).resolves.toBeUndefined();
      await writeFile(join(projectRoot, script), 'process.exit(1);');
      await expect(revalidateTaskGateResults(task, rows, results, { execution })).rejects.toThrow(
        'input bytes changed',
      );
    } finally {
      execution.close();
    }
  });

  it('records a missing real harness as unmet with explicit absent input', async () => {
    const { task, rows } = taskAndRows('missing-bound-harness.mjs');
    const execution = admitted();
    try {
      const results = await runTaskGates(task, rows, { execution });
      expect(results[0]).toMatchObject({
        result: 'fail',
        binding: { artifacts: [{ sha256: null, bytes: null }] },
      });
      await expect(revalidateTaskGateResults(task, rows, results, { execution })).rejects.toThrow(
        'lacks a passing',
      );
    } finally {
      execution.close();
    }
  });

  it('does not launch with incoherent JSON/AC rows, missing context or mismatched project', async () => {
    const { task, rows } = taskAndRows('must-not-run.mjs');
    const execution = admitted();
    try {
      await expect(runTaskGates(task, [], { execution })).rejects.toThrow(
        'inconsistent acceptance',
      );
      await expect(runTaskGates(task, rows, {})).rejects.toThrow('explicitly admitted');
      await expect(
        runTaskGates(task, rows, { execution, projectRoot: dirname(projectRoot) }),
      ).rejects.toThrow();
    } finally {
      execution.close();
    }
  });

  it('rejects changed gate payload, current environment, owner and duplicate or unbound proof', async () => {
    const script = 'bound-freshness.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    try {
      const options = { execution, env: { PATH: process.env.PATH, PROOF_ENV: 'original' } };
      const results = await runTaskGates(task, rows, options);
      await expect(
        revalidateTaskGateResults(task, rows, results, {
          ...options,
          env: { ...options.env, PROOF_ENV: 'changed' },
        }),
      ).rejects.toThrow('environment changed');
      await expect(
        revalidateTaskGateResults(task, rows, [...results, ...results], options),
      ).rejects.toThrow('unique verified');
      await expect(
        revalidateTaskGateResults(
          task,
          rows,
          results.map((r) => ({ ...r, binding: undefined })),
          options,
        ),
      ).rejects.toThrow('passing bound');
      await expect(
        revalidateTaskGateResults({ ...task, id: 'T999' }, rows, results, options),
      ).rejects.toThrow('inconsistent acceptance');
      const edited = structuredClone(task);
      const gate = edited.acceptance![1]!;
      if (typeof gate === 'string') throw new Error('Expected typed criterion');
      gate.description = 'changed gate description';
      const revisedRows = rows.map((row, index) =>
        index === 1
          ? {
              ...row,
              text: acItemToText(gate),
              contentHash: acTextHash(acItemToText(gate)),
            }
          : row,
      );
      await expect(
        revalidateTaskGateResults(edited, revisedRows, results, options),
      ).rejects.toThrow('stale or belongs');
      await expect(revalidateTaskGateResults(edited, rows, results, options)).rejects.toThrow(
        'inconsistent acceptance',
      );
    } finally {
      execution.close();
    }
  });

  it('refuses a harness that changes its input bytes during execution', async () => {
    const script = 'bound-self-edit.mjs';
    await writeFile(
      join(projectRoot, script),
      "import {writeFileSync} from 'node:fs'; writeFileSync(new URL(import.meta.url), 'process.exit(0);');",
    );
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    try {
      const results = await runTaskGates(task, rows, { execution });
      expect(results[0]).toMatchObject({
        result: 'error',
        errorMessage: 'Verification inputs changed during execution',
      });
    } finally {
      execution.close();
    }
  });
  it('rejects authentic runner output with no task binding instead of treating exit0 as completion proof', async () => {
    const script = 'bound-original-runner.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    const gate = task.acceptance![1]!;
    if (typeof gate === 'string') throw new Error('Expected gate');
    try {
      const raw = await runGates([gate], { execution });
      expect(raw[0]!.result).toBe('pass');
      expect(raw[0]!.binding).toBeUndefined();
      await expect(
        revalidateTaskGateResults(
          task,
          rows,
          raw.map((r) => ({ ...r, index: 1 })),
          { execution },
        ),
      ).rejects.toThrow('passing bound');
    } finally {
      execution.close();
    }
  });

  it('refuses path escape, oversized inputs and expired admission before executing the harness', async () => {
    const script = 'bound-budget.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    try {
      await expect(
        runTaskGates({ ...task, files: ['../outside'] }, rows, { execution }),
      ).rejects.toThrow('escapes');
    } finally {
      execution.close();
    }
    const expired = createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'bound-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 'expired',
      },
      { budgetMs: 0 },
    );
    try {
      await expect(runTaskGates(task, rows, { execution: expired })).rejects.toThrow();
    } finally {
      expired.close();
    }
    const bounded = createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'bound-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 'byte-bound',
      },
      { resources: { maxBytes: 4 } },
    );
    try {
      await expect(runTaskGates(task, rows, { execution: bounded })).rejects.toThrow('byte limit');
    } finally {
      bounded.close();
    }
  });
  it('refuses an escaping executable cwd even with no declared file inputs', async () => {
    const { task, rows } = taskAndRows('cwd-gate.mjs');
    const execution = admitted();
    const gate = task.acceptance![1]!;
    if (typeof gate === 'string' || gate.kind !== 'test') throw new Error('Expected test gate');
    gate.cwd = '..';
    gate.command = 'echo';
    gate.args = ['must-not-run'];
    task.files = [];
    const revisedRows = rows.map((row, index) =>
      index === 1
        ? { ...row, text: acItemToText(gate), contentHash: acTextHash(acItemToText(gate)) }
        : row,
    );
    try {
      await expect(runTaskGates(task, revisedRows, { execution })).rejects.toThrow(
        'working directory escapes',
      );
    } finally {
      execution.close();
    }
  });
});
