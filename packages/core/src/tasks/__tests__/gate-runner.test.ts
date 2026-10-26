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

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import {
  captureGateInputsHash,
  createTaskGateReceipt,
  outputReportsFailure,
  resolveGateTimeoutMs,
  revalidateTaskGateResults,
  runGates,
  runTaskGates,
  TYPED_GATE_BOOKKEEPING_MS,
  typedGateAdmissionMs,
} from '../gate-runner.js';
import { admissionCapacityBytes } from '../heavy-tool-env.js';
import { acquireGlobalSlot } from '../tool-semaphore.js';

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
    // T12308: the error must now say what would satisfy it. The message this
    // replaced named no flag, no shape and no alternative, so the only move it
    // suggested was deleting `minCount` — dropping the guarantee rather than
    // meeting it.
    expect(result?.errorMessage).toMatch(/reporter|--json/);
  });
});

/**
 * A silent, long-running target must be observed to its real exit (T12718).
 *
 * `cleo verify --run` recorded PASS in 46 ms for a gate whose command was
 * `node -e "setTimeout(()=>process.exit(0),6000)"`. The command string was
 * split on whitespace, so node received the double quotes as part of its
 * `-e` argument, evaluated a string-literal expression and exited 0 at once.
 * The exit-1 twin passed the same way. These gates are written exactly as a
 * task author writes them: a single command string, no `args`.
 */
describe('quoted command strings run the command the author wrote (T12718)', () => {
  // Single-quoted so an interpreter path containing spaces stays one word.
  const node = `'${process.execPath}'`;
  const SLEEP_MS = 2000;

  it('fails a silent target that sleeps and then exits 1', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'silent sleep then exit 1',
          command: `${node} -e "setTimeout(()=>process.exit(1),${SLEEP_MS})"`,
          expect: 'exit0',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('fail');
    expect(result?.execution?.exitCode).toBe(1);
    expect(result?.durationMs).toBeGreaterThanOrEqual(SLEEP_MS);
  });

  // The quoted-path cases above also fail the old whitespace split for a
  // path-quoting reason (ENOENT on `'…/node'`). This one is the reported bug
  // verbatim: a plain interpreter path, where the old split launched node,
  // handed it `"setTimeout(...)"` as a string literal, and passed in ms.
  it.skipIf(/\s/.test(process.execPath))(
    'fails an UNQUOTED interpreter path that sleeps and then exits 1',
    async () => {
      const [result] = await runGates(
        [
          {
            kind: 'test',
            description: 'unquoted interpreter, silent sleep then exit 1',
            command: `${process.execPath} -e "setTimeout(()=>process.exit(1),${SLEEP_MS})"`,
            expect: 'exit0',
          },
        ],
        { projectRoot },
      );
      expect(result?.result).toBe('fail');
      expect(result?.durationMs).toBeGreaterThanOrEqual(SLEEP_MS);
    },
  );

  it('passes the exit-0 twin only after the target has actually run', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'silent sleep then exit 0',
          command: `${node} -e 'setTimeout(()=>process.exit(0),${SLEEP_MS})'`,
          expect: 'exit0',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('pass');
    expect(result?.execution?.exitCode).toBe(0);
    expect(result?.durationMs).toBeGreaterThanOrEqual(SLEEP_MS);
  });

  it('refuses shell operators it cannot honour instead of passing them as arguments', async () => {
    // Without a shell, `&&` would reach `echo` as a literal word: `echo` exits 0
    // and the `exit 1` the author wrote never runs.
    const [result] = await runGates(
      [{ kind: 'test', description: 'shell chain', command: 'echo ok && exit 1', expect: 'exit0' }],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/shell/i);
  });

  it('refuses an unterminated quote', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'open quote',
          command: `${node} -e "process.exit(0)`,
          expect: 'exit0',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/quote/i);
  });
});

/**
 * `minCount` was declarable and unsatisfiable (T12308).
 *
 * The contract accepted it, `cleo req add` stored it, and the runner rejected
 * every positive value outright — so a task could carry a gate that no number
 * of passing tests could turn green. `testCountReportSchema` had existed in
 * `@cleocode/contracts` the whole time, written for exactly this, and was
 * never wired to the runner.
 *
 * Provenance is the reason a separately supplied report still does not count:
 * a JSON file named by the task could have come from any run of any code. Only
 * the bytes THIS invocation emitted are bound to it.
 */
describe('minimum test count from a structured report (T12308)', () => {
  /** A valid Vitest/Jest JSON report with `passing` passing assertions. */
  function reportSource(passing: number, options: { noise?: boolean } = {}): string {
    const assertions = Array.from({ length: passing }, (_, i) => ({
      fullName: `case ${i}`,
      status: 'passed',
    }));
    const report = {
      numTotalTests: passing,
      numPassedTests: passing,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      success: true,
      testResults: [{ name: 'suite.test.ts', status: 'passed', assertionResults: assertions }],
    };
    const prefix = options.noise === true ? "process.stdout.write('RUN  v4.1.4\\n\\n');" : '';
    return `${prefix}process.stdout.write(JSON.stringify(${JSON.stringify(report)}));`;
  }

  function gate(minCount: number, source: string): AcceptanceGate {
    return {
      kind: 'test',
      description: `at least ${minCount} passing tests`,
      command: process.execPath,
      args: ['-e', source],
      expect: 'exit0',
      minCount,
    };
  }

  it('passes when the run reports at least the required number of passing tests', async () => {
    const [result] = await runGates([gate(3, reportSource(3))], { projectRoot });
    expect(result?.result).toBe('pass');
    expect(result?.errorMessage).toBeUndefined();
  });

  it('fails — not errors — when the count is short, and says both numbers', async () => {
    const [result] = await runGates([gate(5, reportSource(3))], { projectRoot });
    expect(result?.result).toBe('fail');
    expect(result?.errorMessage).toContain('3');
    expect(result?.errorMessage).toContain('5');
  });

  it('finds the report after the runner\u2019s progress output', async () => {
    // Real runners prefix the JSON document with progress lines, so requiring
    // stdout to BE the document would reject every genuine vitest invocation.
    const [result] = await runGates([gate(3, reportSource(3, { noise: true }))], { projectRoot });
    expect(result?.result).toBe('pass');
  });

  it('rejects a report whose summary contradicts its own assertions', async () => {
    const lying = `process.stdout.write(JSON.stringify(${JSON.stringify({
      numTotalTests: 99,
      numPassedTests: 99,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      success: true,
      testResults: [
        {
          name: 's.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'a', status: 'passed' }],
        },
      ],
    })}));`;
    const [result] = await runGates([gate(50, lying)], { projectRoot });
    expect(result?.result).toBe('error');
  });

  it('leaves gates without minCount on the plain exit-code path', async () => {
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'exit code only',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          expect: 'exit0',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('pass');
  });
});

/**
 * A structured report decides the verdict; the text heuristic never reads a
 * test NAME (T13752). VidaPeps saw an 11/11 passing vitest-shaped run fail
 * because a test was named "...activation failure diagnostics...".
 */
describe('structured counts decide the verdict over the text heuristic (T13752)', () => {
  const names = [
    'surfaces activation failure diagnostics',
    'reports failing gates',
    'throws Error: on a bad input',
  ];
  function fullReport(failed: number): string {
    const assertions = names.map((fullName, i) => ({
      fullName,
      status: i < failed ? 'failed' : 'passed',
    }));
    return JSON.stringify({
      numTotalTests: names.length,
      numPassedTests: names.length - failed,
      numFailedTests: failed,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: failed > 0 ? 0 : 1,
      numFailedTestSuites: failed > 0 ? 1 : 0,
      numPendingTestSuites: 0,
      success: failed === 0,
      testResults: [
        {
          name: 'a.test.ts',
          status: failed > 0 ? 'failed' : 'passed',
          assertionResults: assertions,
        },
      ],
    });
  }
  const run = async (stdout: string) =>
    (
      await runGates(
        [
          {
            kind: 'test',
            description: 'structured verdict',
            command: process.execPath,
            args: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
            expect: 'pass',
          },
        ],
        { projectRoot },
      )
    )[0];

  it('a passing report whose test names say failure passes', async () => {
    const progress = names.map((n) => ` ✓ a.test.ts > ${n}`).join('\n');
    const result = await run(`${progress}\n${fullReport(0)}`);
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it('a report counting a failed test fails on the counts even with exit 0', async () => {
    const result = await run(fullReport(1));
    expect(result?.result).toBe('fail');
    expect(result?.errorMessage).toMatch(/Structured report counts 1 failing/);
  });

  it('with no report, passing-test lines naming failure do not fail the run', async () => {
    const result = await run(
      ' ✓ a.test.ts > reports failing gates\n ✓ a.test.ts > throws Error: on a bad input\n' +
        'ok 3 - surfaces 2 failures\n      Tests  3 passed (3)',
    );
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it.each([
    ['a FAIL line', ' FAIL  a.test.ts > adds\n ✓ a.test.ts > other'],
    ['TAP not ok', 'not ok 1 - adds\n# fail 1'],
  ])('with no report, %s still fails', async (_label, out) => {
    expect(outputReportsFailure(out)).toBe(true);
  });
});

/**
 * A minCount gate runs a non-runner command like any other and reads a count
 * summary from its last stdout line (T13753). VidaPeps: a python wrapper
 * printing `{"numPassedTests":13,...}` recorded exitCode null and no output.
 */
describe('minCount with a non-runner wrapper command (T13753)', () => {
  const wrapper = (line: string, exit = 0) => ({
    kind: 'test' as const,
    description: 'wrapper with minCount',
    command: process.execPath,
    args: [
      '-e',
      `console.log('running wrapped suite'); console.log(${JSON.stringify(line)}); process.exit(${exit})`,
    ],
    expect: 'pass' as const,
    minCount: 8,
  });

  it('passes on a count summary in the last stdout line', async () => {
    const [result] = await runGates(
      [wrapper(JSON.stringify({ numPassedTests: 13, numFailedTests: 0, numTotalTests: 13 }))],
      { projectRoot },
    );
    expect(result?.result, result?.errorMessage).toBe('pass');
    expect(result?.execution?.exitCode).toBe(0);
  });

  it('passes on a summary line after a pretty-printed report (T14061)', async () => {
    const summary = JSON.stringify({
      numPassedTests: 13,
      numFailedTests: 0,
      numTotalTests: 13,
      success: true,
    });
    const gate = {
      ...wrapper(summary),
      args: [
        '-e',
        `console.log(JSON.stringify({ numPassedTests: 13, testResults: [] }, null, 2)); console.log(${JSON.stringify(summary)})`,
      ],
    };
    const [result] = await runGates([gate], { projectRoot });
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it('fails a summary below the minimum', async () => {
    const [result] = await runGates([wrapper(JSON.stringify({ numPassedTests: 5 }))], {
      projectRoot,
    });
    expect(result?.result).toBe('fail');
    expect(result?.errorMessage).toContain('below the required minimum of 8');
  });

  it('an unprovable count is an error that keeps the real run record', async () => {
    const [result] = await runGates([wrapper('13 tests passed')], { projectRoot });
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/minCount 8 cannot be proved/);
    expect(result?.execution?.exitCode).toBe(0);
    expect(result?.execution?.stdout).toContain('running wrapped suite');
  });

  it('a summary contradicting itself proves nothing', async () => {
    const [result] = await runGates(
      [wrapper(JSON.stringify({ numPassedTests: 13, numFailedTests: 0, numTotalTests: 2 }))],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
  });
});

/**
 * A JSON reporter redirected to a file (vitest `outputFile`, VidaPeps T2027:
 * `.vitest/json/output.json`) still yields this run's counts, and only this
 * run's: a report the run did not write is never read (T13782).
 */
describe('minCount reads a JSON report file this run wrote (T13782)', () => {
  const rel = join('.vitest', 'json', 'output.json');
  function report(passing: number, startTime: number): string {
    return JSON.stringify({
      startTime,
      numTotalTests: passing,
      numPassedTests: passing,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      success: true,
      testResults: [
        {
          name: 'a.test.ts',
          status: 'passed',
          assertionResults: Array.from({ length: passing }, (_, i) => ({
            fullName: `t${i}`,
            status: 'passed',
          })),
        },
      ],
    });
  }
  /** A gate whose command writes `body()` (evaluated in the child) to `target`. */
  const gate = (source: string, args: string[] = []) => ({
    kind: 'test' as const,
    description: 'vitest json redirected to a file',
    command: process.execPath,
    args: ['-e', source, ...args],
    expect: 'pass' as const,
    minCount: 3,
  });
  const writer = (target: string, startTime: string) =>
    `const fs=require('node:fs');const p=require('node:path');const t=${target};` +
    `fs.mkdirSync(p.dirname(t),{recursive:true});` +
    `fs.writeFileSync(t, JSON.stringify(Object.assign(${report(3, 0)},{startTime:${startTime}})));`;

  beforeEach(() => rm(join(projectRoot, '.vitest'), { recursive: true, force: true }));

  it('passes on the redirected report the run wrote, with its counts', async () => {
    const [result] = await runGates([gate(writer(JSON.stringify(rel), 'Date.now()'))], {
      projectRoot,
    });
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it('reads the file a --outputFile argument names', async () => {
    const [result] = await runGates(
      [
        gate(writer('process.argv.at(-1).split("=")[1]', 'Date.now()'), [
          '--',
          '--outputFile=out/r.json',
        ]),
      ],
      { projectRoot },
    );
    expect(result?.result, `${result?.errorMessage} ${result?.execution?.stderr}`).toBe('pass');
  });

  it('red: a report left by an earlier run is never read', async () => {
    await mkdir(join(projectRoot, '.vitest', 'json'), { recursive: true });
    await writeFile(join(projectRoot, rel), report(3, Date.now() - 60_000));
    const [result] = await runGates([gate('process.exit(0)')], { projectRoot });
    expect(result?.result).toBe('error');
    expect(result?.errorMessage).toMatch(/minCount 3 cannot be proved/);
  });

  it('red: rewriting the same stale bytes does not make them this run\u2019s', async () => {
    const stale = report(3, Date.now() - 60_000);
    await mkdir(join(projectRoot, '.vitest', 'json'), { recursive: true });
    await writeFile(join(projectRoot, rel), stale);
    const [result] = await runGates(
      [gate(`require('node:fs').writeFileSync(${JSON.stringify(rel)}, ${JSON.stringify(stale)})`)],
      { projectRoot },
    );
    expect(result?.result).toBe('error');
  });

  it('red: a freshly copied report whose run started before this one is refused', async () => {
    const [result] = await runGates([gate(writer(JSON.stringify(rel), 'Date.now() - 60000'))], {
      projectRoot,
    });
    expect(result?.result).toBe('error');
  });

  /**
   * vitest 5 behind `pnpm --filter <pkg> exec`: the report lands under the
   * package (the child's cwd), and vitest names it on stdout (T13874).
   */
  const fromPackage = (dir: string, startTime: string) =>
    `process.chdir(${JSON.stringify(dir)});` +
    writer(`require('node:path').resolve(${JSON.stringify(rel)})`, startTime) +
    `console.log('JSON report written to ' + t);`;

  it('reads the report vitest wrote under the package it ran in (T13874)', async () => {
    const pkg = join(projectRoot, 'lib', 'db');
    await mkdir(pkg, { recursive: true });
    try {
      const [result] = await runGates([gate(fromPackage(pkg, 'Date.now()'))], { projectRoot });
      expect(result?.result, result?.errorMessage).toBe('pass');
    } finally {
      await rm(join(projectRoot, 'lib'), { recursive: true, force: true });
    }
  });

  it('red: an announced report from before the run is refused (T13874)', async () => {
    const pkg = join(projectRoot, 'lib', 'db');
    await mkdir(pkg, { recursive: true });
    try {
      const [result] = await runGates([gate(fromPackage(pkg, 'Date.now() - 60000'))], {
        projectRoot,
      });
      expect(result?.result).toBe('error');
    } finally {
      await rm(join(projectRoot, 'lib'), { recursive: true, force: true });
    }
  });

  it('red: an in-project symlink to a fresh report outside is never read (T13883)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cleo-gate-outside-'));
    const link = join(projectRoot, 'lib', 'db', rel);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(outside, 'output.json'), link);
    try {
      const source =
        writer(JSON.stringify(join(outside, 'output.json')), 'Date.now()') +
        `console.log('JSON report written to ' + ${JSON.stringify(link)});`;
      const [result] = await runGates([gate(source)], { projectRoot });
      expect(result?.result).toBe('error');
    } finally {
      await rm(join(projectRoot, 'lib'), { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('red: an earlier fabricated announcement loses to the last one (T13883)', async () => {
    const pkg = join(projectRoot, 'lib', 'db');
    await mkdir(pkg, { recursive: true });
    const fake = join(projectRoot, 'fake-report.json');
    // The fabricated report proves 3; vitest's own (announced last) proves 1.
    const source =
      writer(JSON.stringify(fake), 'Date.now()') +
      `console.log('JSON report written to ' + ${JSON.stringify(fake)});` +
      `const real=${JSON.stringify(join(pkg, rel))};` +
      `fs.mkdirSync(p.dirname(real),{recursive:true});` +
      `fs.writeFileSync(real, JSON.stringify(Object.assign(${report(1, 0)},{startTime:Date.now()})));` +
      `console.log('JSON report written to ' + real);`;
    try {
      const [result] = await runGates([gate(source)], { projectRoot });
      expect(result?.result).toBe('fail');
    } finally {
      await rm(join(projectRoot, 'lib'), { recursive: true, force: true });
      await rm(fake, { force: true });
    }
  });

  it('red: an announced report outside the project is never read (T13874)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cleo-gate-outside-'));
    try {
      const [result] = await runGates([gate(fromPackage(outside, 'Date.now()'))], { projectRoot });
      expect(result?.result).toBe('error');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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

describe("bun's subcommands are not the script (T13566)", () => {
  let fakeBun: string;
  beforeAll(async () => {
    // A stand-in `bun` that exits 0: the snapshot keys on the interpreter's name.
    fakeBun = join(projectRoot, 'tools', 'bun');
    await mkdir(dirname(fakeBun), { recursive: true });
    await writeFile(fakeBun, '#!/bin/sh\nexit 0\n');
    await chmod(fakeBun, 0o755);
    await mkdir(join(projectRoot, 'test'), { recursive: true });
    await writeFile(join(projectRoot, 'test', 'a.test.ts'), 'export {};\n');
    await writeFile(join(projectRoot, 'test', 'b.test.ts'), 'export {};\n');
    await mkdir(join(projectRoot, 'scripts'), { recursive: true });
    await writeFile(join(projectRoot, 'scripts', 'x.ts'), 'export {};\n');
    await mkdir(join(projectRoot, 'sub'), { recursive: true });
    await writeFile(join(projectRoot, 'sub', 'c.test.ts'), 'export {};\n');
    await writeFile(join(projectRoot, 'bunfig.toml'), '');
  });
  beforeEach(() => _forceSystemdRunAvailable(false));
  afterEach(() => _forceSystemdRunAvailable(undefined));

  async function inputs(args: string[], command = fakeBun): Promise<string[]> {
    return (await artifactsOf(args, command)).map((a) => a.path);
  }

  async function artifactsOf(
    args: string[],
    command = fakeBun,
  ): Promise<Array<{ path: string; sha256: string | null }>> {
    const task: Task = {
      id: 'T166',
      title: 'bun gate',
      description: 'bun subcommand snapshot fixture',
      status: 'active',
      type: 'task',
      priority: 'medium',
      createdAt: '2026-10-11T00:00:00.000Z',
      acceptance: [
        { kind: 'test', command, args, expect: 'exit0', req: 'BUN-1', description: 'bun runs' },
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
    const execution = createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'bun-agent',
        operation: 'check.gate.verify',
        idempotencyKey: `bun-${args.join('-')}`,
      },
      { budgetMs: 10_000 },
    );
    try {
      const [result] = await runTaskGates(task, rows, { execution });
      expect(result?.result, result?.errorMessage).toBe('pass');
      return (result?.binding?.artifacts ?? []).map((a) => ({
        path: a.path.slice(projectRoot.length + 1),
        sha256: a.sha256,
      }));
    } finally {
      execution.close();
    }
  }

  it('bun test <files...> captures both test files, never ./test', async () => {
    const captured = await inputs(['test', 'test/a.test.ts', 'test/b.test.ts']);
    expect(captured).toEqual(expect.arrayContaining(['test/a.test.ts', 'test/b.test.ts']));
    expect(captured).not.toContain('test');
  });

  it('bun run file.ts and a bare bun file.ts capture the script', async () => {
    expect(await inputs(['run', 'scripts/x.ts'])).toContain('scripts/x.ts');
    expect(await inputs(['scripts/x.ts'])).toContain('scripts/x.ts');
    const named = await inputs(['run', 'build']);
    expect(named).not.toContain('run');
    expect(named).not.toContain('build');
  });

  it('other bun subcommands capture nothing: install, add, pm, create (T13574)', async () => {
    for (const args of [
      ['install'],
      ['add', '@scope/pkg'],
      ['pm', 'ls'],
      ['create', 'user/repo', 'dest'],
      ['upgrade'],
    ]) {
      const captured = await inputs(args);
      for (const word of args) expect(captured).not.toContain(word);
      expect(captured.every((path) => !path.startsWith('user/') && path !== 'dest')).toBe(true);
    }
  });

  it('bun -c <file> is the config flag, not inline eval (T13574)', async () => {
    const captured = await inputs(['-c', 'bunfig.toml', 'test', 'test/a.test.ts']);
    expect(captured).toContain('test/a.test.ts');
    // The config file is an input the gate reads (T13574 review), not inline code.
    expect(captured).toContain('bunfig.toml');
  });

  it('bun --cwd dir test resolves files in dir and never captures dir (T13574)', async () => {
    const captured = await inputs(['--cwd', 'sub', 'test', 'c.test.ts']);
    expect(captured).toContain('sub/c.test.ts');
    expect(captured).not.toContain('sub');
    expect(await inputs(['--cwd=sub', 'test', 'c.test.ts'])).toContain('sub/c.test.ts');
  });

  it('bun file-flag values are captured inputs, never the script: an edited preload changes the snapshot (T13574 review)', async () => {
    await mkdir(join(projectRoot, 'setup'), { recursive: true });
    await writeFile(join(projectRoot, 'setup', 'pre.ts'), 'export const v = 1;\n');
    await writeFile(join(projectRoot, 'setup', '.env.test'), 'A=1\n');
    const args = [
      '--preload',
      './setup/pre.ts',
      '--env-file=setup/.env.test',
      '-c',
      'bunfig.toml',
      'test',
      'test/a.test.ts',
    ];
    const before = await artifactsOf(args);
    const preload = before.find((a) => a.path === 'setup/pre.ts');
    expect(preload?.sha256).toEqual(expect.any(String));
    expect(before.map((a) => a.path)).toEqual(
      expect.arrayContaining(['setup/.env.test', 'bunfig.toml', 'test/a.test.ts']),
    );
    await writeFile(join(projectRoot, 'setup', 'pre.ts'), 'export const v = 2;\n');
    const after = await artifactsOf(args);
    expect(after.find((a) => a.path === 'setup/pre.ts')?.sha256).not.toBe(preload?.sha256);
    // --cwd's value is a directory, never an input.
    expect(await inputs(['--cwd', 'sub', 'test', 'c.test.ts'])).not.toContain('sub');
  });

  it('bun x <pkg> and bunx <pkg> never capture the package as a file', async () => {
    const viaX = await inputs(['x', '@scope/tool', 'test/a.test.ts']);
    expect(viaX).toContain('test/a.test.ts');
    expect(viaX).not.toContain('@scope/tool');
    const bunx = join(projectRoot, 'tools', 'bunx');
    await writeFile(bunx, '#!/bin/sh\nexit 0\n');
    await chmod(bunx, 0o755);
    const viaBunx = await inputs(['@scope/tool', 'test/b.test.ts'], bunx);
    expect(viaBunx).toContain('test/b.test.ts');
    expect(viaBunx).not.toContain('@scope/tool');
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

  it('serializes exact receipt bytes and rejects duplicate or mixed verification owners', async () => {
    const script = 'receipt-pass.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows } = taskAndRows(script);
    const execution = admitted();
    try {
      const results = await runTaskGates(task, rows, { execution });
      const expected = {
        verificationId: results[0]!.binding!.verificationId,
        resultHash: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
        operation: 'check.gate.verify',
        passed: true,
      };
      expect(JSON.stringify(createTaskGateReceipt(results, true))).toBe(JSON.stringify(expected));
      expect(createTaskGateReceipt(structuredClone(results), true)).toEqual(expected);
      expect(() => createTaskGateReceipt([], true)).toThrow('bound result batch');
      expect(() => createTaskGateReceipt([...results, ...results], true)).toThrow(
        'unique criterion',
      );
      const second = await runTaskGates(task, rows, { execution });
      expect(() => createTaskGateReceipt([...results, ...second], true)).toThrow('one batch owner');
      expect(createTaskGateReceipt(results, false)).toEqual({ ...expected, passed: false });
      const altered = structuredClone(results);
      altered[0]!.evidence = 'different exact payload';
      expect(createTaskGateReceipt(altered, true).resultHash).not.toBe(expected.resultHash);
    } finally {
      execution.close();
    }
  });

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
      await expect(
        revalidateTaskGateResults(task, rows, results, { execution }, false),
      ).resolves.toBeUndefined();
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
          // T14034: only hashed keys count; PATH is a fixed tool input.
          env: { ...options.env, PATH: `${options.env.PATH}:/changed` },
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

  it('records a refused command as that gate’s error and still runs the other gates (T12718)', async () => {
    // One refused gate used to reject all of runTaskGates, which the verify
    // engine reported as E_GENERAL — discarding the clean gate's verdict.
    const script = 'bound-refusal-sibling.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    const { task, rows: baseRows } = taskAndRows(script);
    const refused: TestGate = {
      kind: 'test',
      command: 'echo ok && exit 1',
      expect: 'exit0',
      req: 'PARTNER-REFUSED',
      description: 'Shell chain the runner cannot honour',
    };
    task.acceptance = [...task.acceptance!, refused];
    const rows: AcRow[] = buildFreshAcRows(task.id, task.acceptance).map((row, index) => ({
      ...baseRows[Math.min(index, baseRows.length - 1)]!,
      ...row,
      kind: row.kind ?? 'text',
      sourceKey: row.sourceKey ?? '',
      projection: row.projection ?? 'legacy',
      targetTaskId: row.targetTaskId ?? null,
      contentHash: row.contentHash ?? null,
    }));
    const execution = admitted();
    try {
      const results = await runTaskGates(task, rows, { execution });
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ index: 1, result: 'pass' });
      expect(results[1]).toMatchObject({ index: 2, result: 'error', checkedBy: 'bound-agent' });
      expect(results[1]!.errorMessage).toMatch(/shell syntax \(&\).*sh -c/);
      expect(results[1]!.binding).toBeDefined();
      expect(results[1]!.binding!.invocation).toBeUndefined();
      // The recorded batch persists: revalidation and the receipt accept it.
      await expect(
        revalidateTaskGateResults(task, rows, results, { execution }, false),
      ).resolves.toBeUndefined();
      expect(createTaskGateReceipt(results, false).passed).toBe(false);
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

  it('a bracketed task file (Next.js app/[id]/page.tsx) is a literal input, and --run and the write path key it alike (T13690)', async () => {
    const script = 'bracket-pass.mjs';
    await writeFile(join(projectRoot, script), 'process.exit(0);');
    await mkdir(join(projectRoot, 'app', '[id]'), { recursive: true });
    await writeFile(join(projectRoot, 'app', '[id]', 'page.tsx'), 'export default 1;\n');
    const base = taskAndRows(script);
    const task: Task = {
      ...base.task,
      files: [script, 'app/[id]/page.tsx', 'app/plain-absent.tsx'],
    };
    const execution = admitted();
    try {
      const [result] = await runTaskGates(task, base.rows, { execution });
      expect(result?.result, result?.errorMessage).toBe('pass');
      const artifacts = result?.binding?.artifacts ?? [];
      const page = artifacts.find((a) => a.path.endsWith(join('app', '[id]', 'page.tsx')));
      expect(page?.sha256).toBe(createHash('sha256').update('export default 1;\n').digest('hex'));
      // A plain declared file that does not exist is recorded as absent.
      expect(artifacts.find((a) => a.path.endsWith('plain-absent.tsx'))?.sha256).toBeNull();
      // The digest `cleo verify --run` caches under equals the one the write path reads.
      const gate = task.acceptance?.find((a) => typeof a !== 'string');
      if (!gate || typeof gate === 'string') throw new Error('expected a typed gate');
      const runHash = await captureGateInputsHash(task, gate, execution);
      const writeHash = createHash('sha256')
        .update(JSON.stringify({ invocation: result?.binding?.invocation ?? null, artifacts }))
        .digest('hex');
      expect(runHash).toBe(writeHash);
      // T13691: an absent glob-looking entry is a mistaken pattern, refused by name.
      const [refused] = await runTaskGates({ ...task, files: [script, 'src/**/*.ts'] }, base.rows, {
        execution,
      });
      expect(refused?.result).toBe('error');
      expect(refused?.errorMessage).toMatch(
        /declared task file src\/\*\*\/\*\.ts does not exist; list explicit paths, task\.files are literal/,
      );
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
      // T13527: an uncapturable input is that gate's own unmet `error`, never run.
      const [escaped] = await runTaskGates({ ...task, files: ['../outside'] }, rows, {
        execution,
      });
      expect(escaped?.result).toBe('error');
      expect(escaped?.errorMessage).toMatch(/inputs could not be captured: .*escapes/);
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
      const [oversized] = await runTaskGates(task, rows, { execution: bounded });
      expect(oversized?.result).toBe('error');
      expect(oversized?.errorMessage).toMatch(/byte limit/);
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
      const [escaping] = await runTaskGates(task, revisedRows, { execution });
      expect(escaping?.result).toBe('error');
      expect(escaping?.errorMessage).toMatch(/working directory escapes/);
    } finally {
      execution.close();
    }
  });
});

describe('typed gate tool deadlines (T12516 · ADR-061)', () => {
  const suite: TestGate = {
    kind: 'test',
    description: 'suite',
    command: 'npm',
    args: ['test'],
    expect: 'exit0',
  };
  const check: CommandGate = { kind: 'command', description: 'check', cmd: 'node', args: [] };
  const manual: ManualGate = { kind: 'manual', description: 'human', prompt: 'look' };

  it('defaults to the ADR-061 tool deadline, not the shared 2 s budget', () => {
    expect(resolveGateTimeoutMs(suite, {})).toBe(1_800_000);
    expect(resolveGateTimeoutMs(check, {})).toBe(300_000);
  });

  it('honours the gate timeout, then CLEO_GATE_TIMEOUT_MS, then CLEO_TOOL_TIMEOUT_<KIND>', () => {
    expect(resolveGateTimeoutMs({ ...suite, timeoutMs: 7 }, { CLEO_GATE_TIMEOUT_MS: '9' })).toBe(7);
    expect(resolveGateTimeoutMs(suite, { CLEO_GATE_TIMEOUT_MS: '9' })).toBe(9);
    expect(resolveGateTimeoutMs(suite, { CLEO_TOOL_TIMEOUT_TEST: '4200' })).toBe(4200);
    expect(() => resolveGateTimeoutMs(suite, { CLEO_TOOL_TIMEOUT_TEST: 'soon' })).toThrow();
  });

  it('admits every tool deadline plus the bookkeeping budget', () => {
    expect(typedGateAdmissionMs([suite, check, manual], {})).toBe(
      1_800_000 + 300_000 + TYPED_GATE_BOOKKEEPING_MS,
    );
    expect(typedGateAdmissionMs([manual], {})).toBe(TYPED_GATE_BOOKKEEPING_MS);
  });

  it('runs a gate slower than 2 s to completion without a caller lifetime', async () => {
    _forceSystemdRunAvailable(false);
    try {
      const [result] = await runGates(
        [
          {
            kind: 'test',
            description: 'slow suite',
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 3000)'],
            expect: 'exit0',
          },
        ],
        { projectRoot },
      );
      expect(result?.result, result?.errorMessage).toBe('pass');
    } finally {
      _forceSystemdRunAvailable(undefined);
    }
  }, 30_000);
});

describe('expect pass reads runner summaries, not the word "fail" (T13511)', () => {
  it.each([
    ['node:test passing', 'ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0'],
    ['TAP passing', '# tests 3\n# pass 3\n# fail 0'],
    ['vitest passing', ' Test Files  2 passed (2)\n      Tests  12 passed (12)'],
    ['jest passing', 'Tests:       12 passed, 12 total\nSnapshots:   0 total'],
    ['mocha style zero', '  3 passing (20ms)\n  0 failing'],
    ['failures: 0', 'Ran 3 tests\nfailures: 0'],
  ])('%s does not report a failure', (_label, out) => {
    expect(outputReportsFailure(out)).toBe(false);
  });

  it.each([
    ['node:test failing', 'ℹ tests 3\nℹ pass 2\nℹ fail 1'],
    ['TAP failing', '# pass 2\n# fail 1'],
    ['vitest failing', ' FAIL  src/a.test.ts > adds\n      Tests  1 failed | 11 passed (12)'],
    ['jest failing', 'FAIL src/a.test.ts\nTests:       1 failed, 11 passed, 12 total'],
    ['mocha failing', '  2 passing\n  1 failing'],
    ['an Error: line', 'Error: boom'],
    ['fail 10 is not fail 0', 'ℹ fail 10'],
    ['T13516: an exit-0 runner printing only a non-zero failed count', 'Tests: 3 failed, 9 passed'],
    ['T13516: 1 failure', 'Ran 4 tests\n1 failure'],
  ])('%s reports a failure', (_label, out) => {
    expect(outputReportsFailure(out)).toBe(true);
  });

  it('a real passing node --test run passes a typed test gate with expect pass', async () => {
    const file = join(projectRoot, 't13511.test.mjs');
    await writeFile(
      file,
      "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 2));\n",
    );
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'node --test passes',
          command: process.execPath,
          args: ['--test', file],
          expect: 'pass',
        },
      ],
      { projectRoot },
    );
    expect(result?.result, result?.errorMessage).toBe('pass');
  });

  it('a real failing node --test run fails it', async () => {
    const file = join(projectRoot, 't13511-fail.test.mjs');
    await writeFile(
      file,
      "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => assert.equal(1 + 1, 3));\n",
    );
    const [result] = await runGates(
      [
        {
          kind: 'test',
          description: 'node --test fails',
          command: process.execPath,
          args: ['--test', file],
          expect: 'pass',
        },
      ],
      { projectRoot },
    );
    expect(result?.result).toBe('fail');
  });
});

describe('typed process gates admit through the machine ledger (T13573)', () => {
  beforeEach(() => _forceSystemdRunAvailable(false));
  afterEach(() => _forceSystemdRunAvailable(undefined));

  it('with a full ledger a typed test gate does not spawn until it is admitted', async () => {
    const marker = join(projectRoot, 't13573-ran');
    await writeFile(
      join(projectRoot, 't13573-gate.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const task: Task = {
      id: 'T173',
      title: 'admitted gate',
      description: 'typed gate admission fixture',
      status: 'active',
      type: 'task',
      priority: 'medium',
      createdAt: '2026-10-12T00:00:00.000Z',
      acceptance: [
        {
          kind: 'test',
          command: process.execPath,
          args: ['t13573-gate.mjs'],
          expect: 'exit0',
          req: 'ADMIT-1',
          description: 'waits for admission',
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
    // Another run holds the whole machine budget.
    const holder = await acquireGlobalSlot('test', {
      footprintBytes: admissionCapacityBytes(),
      label: 'holder',
    });
    const execution = createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'admission-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 't13573-admission',
      },
      { budgetMs: 30_000 },
    );
    try {
      const run = runTaskGates(task, rows, { execution });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
      await holder();
      const [result] = await run;
      expect(result?.result, result?.errorMessage).toBe('pass');
      expect(await readFile(marker, 'utf8')).toBe('ran');
    } finally {
      await holder();
      execution.close();
    }
  }, 30_000);

  it('refuses with the admission reason, never spawning, when the budget stays full past the gate deadline', async () => {
    const marker = join(projectRoot, 't13573-refused');
    await writeFile(
      join(projectRoot, 't13573-refuse.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const task: Task = {
      id: 'T174',
      title: 'refused gate',
      description: 'typed gate admission refusal fixture',
      status: 'active',
      type: 'task',
      priority: 'medium',
      createdAt: '2026-10-12T00:00:00.000Z',
      acceptance: [
        {
          kind: 'test',
          command: process.execPath,
          args: ['t13573-refuse.mjs'],
          expect: 'exit0',
          req: 'ADMIT-2',
          description: 'refused while the budget is full',
          timeoutMs: 1_500,
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
    const holder = await acquireGlobalSlot('test', {
      footprintBytes: admissionCapacityBytes(),
      label: 'holder',
    });
    const execution = createOperationExecutionContext(
      {
        projectId: 'gate-fixture',
        projectRoot,
        actor: 'admission-agent',
        operation: 'check.gate.verify',
        idempotencyKey: 't13573-refusal',
      },
      { budgetMs: 4_000 },
    );
    try {
      const outcome = await runTaskGates(task, rows, { execution }).then(
        ([result]) => result?.errorMessage ?? result?.result ?? '',
        (error: Error) => error.message,
      );
      expect(outcome).toMatch(/Timed out waiting for admission of a 'test' run/);
      await expect(readFile(marker, 'utf8')).rejects.toThrow();
    } finally {
      await holder();
      execution.close();
    }
  }, 30_000);
});
