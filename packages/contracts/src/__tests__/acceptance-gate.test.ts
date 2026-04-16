/**
 * Round-trip Zod parse tests for `AcceptanceGate` variants and `AcceptanceGateResult`.
 *
 * Each test constructs a valid input object for one gate variant, parses it
 * through the corresponding Zod schema, and asserts that the parsed output
 * matches the input shape exactly. This guarantees the schema accepts all
 * valid gate shapes without transformation loss.
 *
 * @epic T760
 * @task T779
 * @task T780
 */

import { describe, expect, it } from 'vitest';
import type { AcceptanceGate, AcceptanceGateResult, FileAssertion } from '../acceptance-gate.js';
import {
  acceptanceArraySchema,
  acceptanceGateResultSchema,
  acceptanceGateSchema,
  commandGateSchema,
  fileAssertionSchema,
  fileGateSchema,
  httpGateSchema,
  lintGateSchema,
  manualGateSchema,
  testGateSchema,
} from '../acceptance-gate-schema.js';
import type { AcceptanceItem } from '../index.js';

// ─── TestGate ────────────────────────────────────────────────────────────────

describe('TestGate schema', () => {
  it('round-trips a minimal test gate', () => {
    const input = {
      kind: 'test' as const,
      command: 'pnpm test',
      expect: 'pass' as const,
      description: 'Test suite must pass with zero failures',
    };
    const result = testGateSchema.parse(input);
    expect(result.kind).toBe('test');
    expect(result.command).toBe('pnpm test');
    expect(result.expect).toBe('pass');
    expect(result.description).toBe('Test suite must pass with zero failures');
  });

  it('round-trips a full test gate with all optional fields', () => {
    const input = {
      kind: 'test' as const,
      command: 'node',
      args: ['--test', 'tests/*.test.mjs'],
      expect: 'exit0' as const,
      minCount: 3,
      cwd: 'packages/core',
      env: { NODE_ENV: 'test' },
      req: 'TEST-01',
      description: 'Core tests must run',
      advisory: false,
      timeoutMs: 60_000,
    };
    const result = testGateSchema.parse(input);
    expect(result.req).toBe('TEST-01');
    expect(result.minCount).toBe(3);
    expect(result.args).toEqual(['--test', 'tests/*.test.mjs']);
    expect(result.env).toEqual({ NODE_ENV: 'test' });
  });

  it('accepts "exit0" as expect value', () => {
    const result = testGateSchema.parse({
      kind: 'test',
      command: 'pnpm build',
      expect: 'exit0',
      description: 'Build must exit cleanly',
    });
    expect(result.expect).toBe('exit0');
  });

  it('rejects an invalid expect value', () => {
    const parse = () =>
      testGateSchema.parse({
        kind: 'test',
        command: 'pnpm test',
        expect: 'succeed',
        description: 'Test',
      });
    expect(parse).toThrow();
  });

  it('rejects empty command', () => {
    const parse = () =>
      testGateSchema.parse({ kind: 'test', command: '', expect: 'pass', description: 'Test' });
    expect(parse).toThrow();
  });
});

// ─── FileGate ────────────────────────────────────────────────────────────────

describe('FileGate schema', () => {
  it('round-trips a gate with exists + nonEmpty assertions', () => {
    const input = {
      kind: 'file' as const,
      path: 'src/store.js',
      assertions: [{ type: 'exists' as const }, { type: 'nonEmpty' as const }],
      description: 'store.js must exist and be non-empty',
    };
    const result = fileGateSchema.parse(input);
    expect(result.kind).toBe('file');
    expect(result.path).toBe('src/store.js');
    expect(result.assertions).toHaveLength(2);
  });

  it('round-trips a gate with all FileAssertion variants', () => {
    const assertions: FileAssertion[] = [
      { type: 'exists' },
      { type: 'absent' },
      { type: 'nonEmpty' },
      { type: 'minBytes', value: 200 },
      { type: 'maxBytes', value: 10_000 },
      { type: 'contains', value: 'localStorage.setItem' },
      { type: 'matches', regex: 'work.*25', flags: 'm' },
      { type: 'sha256', value: 'a'.repeat(64) },
    ];
    const input = {
      kind: 'file' as const,
      path: 'src/timer.js',
      assertions,
      description: 'Timer file matches all criteria',
    };
    const result = fileGateSchema.parse(input);
    expect(result.assertions).toHaveLength(8);
    const matchAssertion = result.assertions.find((a) => a.type === 'matches');
    expect(matchAssertion).toBeDefined();
    if (matchAssertion?.type === 'matches') {
      expect(matchAssertion.flags).toBe('m');
    }
  });

  it('rejects empty assertions array', () => {
    const parse = () =>
      fileGateSchema.parse({
        kind: 'file',
        path: 'src/x.ts',
        assertions: [],
        description: 'bad gate',
      });
    expect(parse).toThrow();
  });
});

describe('FileAssertion schema', () => {
  it('parses "exists" assertion', () => {
    const result = fileAssertionSchema.parse({ type: 'exists' });
    expect(result.type).toBe('exists');
  });

  it('parses "absent" assertion', () => {
    const result = fileAssertionSchema.parse({ type: 'absent' });
    expect(result.type).toBe('absent');
  });

  it('parses "contains" assertion', () => {
    const result = fileAssertionSchema.parse({ type: 'contains', value: 'localStorage' });
    expect(result.type).toBe('contains');
    if (result.type === 'contains') expect(result.value).toBe('localStorage');
  });

  it('parses "matches" assertion with flags', () => {
    const result = fileAssertionSchema.parse({ type: 'matches', regex: 'foo.*bar', flags: 'gi' });
    expect(result.type).toBe('matches');
    if (result.type === 'matches') {
      expect(result.regex).toBe('foo.*bar');
      expect(result.flags).toBe('gi');
    }
  });

  it('rejects unknown assertion type', () => {
    expect(() => fileAssertionSchema.parse({ type: 'unknown' })).toThrow();
  });
});

// ─── CommandGate ─────────────────────────────────────────────────────────────

describe('CommandGate schema', () => {
  it('round-trips a minimal command gate', () => {
    const input = {
      kind: 'command' as const,
      cmd: 'cleo doctor',
      description: 'cleo doctor must exit 0',
    };
    const result = commandGateSchema.parse(input);
    expect(result.kind).toBe('command');
    expect(result.cmd).toBe('cleo doctor');
    // exitCode defaults to undefined (not set in schema default)
    expect(result.exitCode).toBeUndefined();
  });

  it('round-trips a command gate with all optional fields', () => {
    const input = {
      kind: 'command' as const,
      cmd: 'git',
      args: ['status', '--short'],
      exitCode: 0,
      stdoutMatches: '^M ',
      stderrMatches: '',
      cwd: '.',
      env: { GIT_TERMINAL_PROMPT: '0' },
      description: 'working tree must have staged changes',
      req: 'GIT-01',
    };
    const result = commandGateSchema.parse(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutMatches).toBe('^M ');
    expect(result.args).toEqual(['status', '--short']);
  });
});

// ─── LintGate ────────────────────────────────────────────────────────────────

describe('LintGate schema', () => {
  it('round-trips biome gate', () => {
    const input = {
      kind: 'lint' as const,
      tool: 'biome' as const,
      expect: 'clean' as const,
      description: 'Source passes biome check clean',
    };
    const result = lintGateSchema.parse(input);
    expect(result.kind).toBe('lint');
    expect(result.tool).toBe('biome');
    expect(result.expect).toBe('clean');
  });

  it('accepts all lint tool values', () => {
    const tools = ['biome', 'eslint', 'tsc', 'prettier', 'rustc', 'clippy'] as const;
    for (const tool of tools) {
      const result = lintGateSchema.parse({
        kind: 'lint',
        tool,
        expect: 'noErrors',
        description: `${tool} gate`,
      });
      expect(result.tool).toBe(tool);
    }
  });

  it('rejects unknown lint tool', () => {
    expect(() =>
      lintGateSchema.parse({
        kind: 'lint',
        tool: 'rubocop',
        expect: 'clean',
        description: 'bad',
      }),
    ).toThrow();
  });
});

// ─── HttpGate ────────────────────────────────────────────────────────────────

describe('HttpGate schema', () => {
  it('round-trips a minimal http gate', () => {
    const input = {
      kind: 'http' as const,
      url: 'http://localhost:8080/',
      status: 200,
      description: 'App health endpoint must return 200',
    };
    const result = httpGateSchema.parse(input);
    expect(result.kind).toBe('http');
    expect(result.url).toBe('http://localhost:8080/');
    expect(result.status).toBe(200);
  });

  it('round-trips a full http gate with all optional fields', () => {
    const input = {
      kind: 'http' as const,
      url: 'http://127.0.0.1:8123/',
      method: 'GET' as const,
      status: 200,
      bodyMatches: '<title>[^<]*Pomodoro',
      headers: { Accept: 'text/html' },
      startCommand: 'npx serve -p 8123 .',
      startupDelayMs: 2000,
      description: 'Static app HTML shell returned',
      req: 'SMOKE-01',
    };
    const result = httpGateSchema.parse(input);
    expect(result.startupDelayMs).toBe(2000);
    expect(result.bodyMatches).toBe('<title>[^<]*Pomodoro');
  });

  it('rejects an invalid URL', () => {
    expect(() =>
      httpGateSchema.parse({
        kind: 'http',
        url: 'not-a-url',
        status: 200,
        description: 'bad',
      }),
    ).toThrow();
  });
});

// ─── ManualGate ──────────────────────────────────────────────────────────────

describe('ManualGate schema', () => {
  it('round-trips a minimal manual gate', () => {
    const input = {
      kind: 'manual' as const,
      prompt: 'Does the dark theme toggle work correctly?',
      description: 'Dark/light/auto theme cycle is visually usable',
    };
    const result = manualGateSchema.parse(input);
    expect(result.kind).toBe('manual');
    expect(result.prompt).toBe('Does the dark theme toggle work correctly?');
    expect(result.verdicts).toBeUndefined();
  });

  it('round-trips a manual gate with custom verdicts', () => {
    const input = {
      kind: 'manual' as const,
      prompt: 'Does the visual design match the mockup?',
      verdicts: ['pass', 'fail', 'warn'] as const,
      description: 'Visual design review',
      req: 'UX-01',
      advisory: true,
    };
    const result = manualGateSchema.parse(input);
    expect(result.verdicts).toEqual(['pass', 'fail', 'warn']);
    expect(result.advisory).toBe(true);
  });
});

// ─── acceptanceGateSchema (discriminated union) ───────────────────────────────

describe('acceptanceGateSchema (discriminated union)', () => {
  it('routes test gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'test',
      command: 'pnpm test',
      expect: 'pass',
      description: 'Tests must pass',
    });
    expect(result.kind).toBe('test');
    // TypeScript narrowing: kind is 'test' so command is available
    if (result.kind === 'test') {
      expect(result.command).toBe('pnpm test');
    }
  });

  it('routes file gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'file',
      path: 'README.md',
      assertions: [{ type: 'exists' }],
      description: 'README must exist',
    });
    expect(result.kind).toBe('file');
  });

  it('routes command gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'command',
      cmd: 'pnpm doctor',
      description: 'doctor must succeed',
    });
    expect(result.kind).toBe('command');
  });

  it('routes lint gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'lint',
      tool: 'tsc',
      expect: 'clean',
      description: 'TypeScript must compile clean',
    });
    expect(result.kind).toBe('lint');
  });

  it('routes http gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'http',
      url: 'https://example.com/',
      status: 200,
      description: 'example.com must return 200',
    });
    expect(result.kind).toBe('http');
  });

  it('routes manual gate by kind', () => {
    const result = acceptanceGateSchema.parse({
      kind: 'manual',
      prompt: 'Does it look right?',
      description: 'Visual QA check',
    });
    expect(result.kind).toBe('manual');
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      acceptanceGateSchema.parse({
        kind: 'unknown',
        description: 'bad gate',
      }),
    ).toThrow();
  });

  it('rejects missing description', () => {
    expect(() => acceptanceGateSchema.parse({ kind: 'manual', prompt: 'test' })).toThrow();
  });

  it('type-checks inferred type is assignable to AcceptanceGate', () => {
    const raw = {
      kind: 'lint' as const,
      tool: 'biome' as const,
      expect: 'clean' as const,
      description: 'biome clean',
    };
    const parsed = acceptanceGateSchema.parse(raw);
    // This assignment verifies the inferred schema type is structurally
    // compatible with the canonical TypeScript AcceptanceGate interface.
    const gate: AcceptanceGate = parsed;
    expect(gate.kind).toBe('lint');
  });
});

// ─── AcceptanceGateResult schema ──────────────────────────────────────────────

describe('acceptanceGateResultSchema', () => {
  it('round-trips a pass result', () => {
    const input = {
      index: 0,
      req: 'TEST-01',
      kind: 'test' as const,
      result: 'pass' as const,
      durationMs: 3142,
      evidence: 'ok 7/7 tests',
      checkedAt: '2026-04-16T05:12:03.441Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(input);
    expect(parsed.result).toBe('pass');
    expect(parsed.durationMs).toBe(3142);
    expect(parsed.req).toBe('TEST-01');
  });

  it('round-trips a fail result with errorMessage', () => {
    const input = {
      index: 2,
      kind: 'file' as const,
      result: 'fail' as const,
      durationMs: 4,
      evidence: 'assertion 3 of 3 did not match',
      errorMessage: 'File src/timer.js missing cadence setting',
      checkedAt: '2026-04-16T05:12:05.000Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(input);
    expect(parsed.result).toBe('fail');
    expect(parsed.errorMessage).toBe('File src/timer.js missing cadence setting');
  });

  it('round-trips a skipped result (--skip-manual)', () => {
    const input = {
      index: 6,
      req: 'UX-01',
      kind: 'manual' as const,
      result: 'skipped' as const,
      durationMs: 0,
      evidence: '--skip-manual active',
      checkedAt: '2026-04-16T05:12:03.000Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(input);
    expect(parsed.result).toBe('skipped');
  });

  it('round-trips an error result', () => {
    const input = {
      index: 1,
      kind: 'command' as const,
      result: 'error' as const,
      durationMs: 12,
      errorMessage: 'spawn ENOENT: command not found',
      checkedAt: '2026-04-16T05:12:06.000Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(input);
    expect(parsed.result).toBe('error');
  });

  it('round-trips a warn result (advisory gate)', () => {
    const input = {
      index: 4,
      kind: 'lint' as const,
      result: 'warn' as const,
      durationMs: 800,
      checkedAt: '2026-04-16T05:12:07.000Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(input);
    expect(parsed.result).toBe('warn');
  });

  it('rejects an invalid checkedAt (non-datetime)', () => {
    expect(() =>
      acceptanceGateResultSchema.parse({
        index: 0,
        kind: 'test',
        result: 'pass',
        durationMs: 100,
        checkedAt: 'not-a-date',
        checkedBy: 'agent',
      }),
    ).toThrow();
  });

  it('type-checks inferred result is assignable to AcceptanceGateResult', () => {
    const raw = {
      index: 0,
      kind: 'test' as const,
      result: 'pass' as const,
      durationMs: 100,
      checkedAt: '2026-04-16T00:00:00.000Z',
      checkedBy: 'cleo-verify',
    };
    const parsed = acceptanceGateResultSchema.parse(raw);
    // Structural compatibility check with the canonical interface.
    const typed: AcceptanceGateResult = parsed;
    expect(typed.index).toBe(0);
  });
});

// ─── Mixed acceptance array (T780) ───────────────────────────────────────────

describe('acceptanceArraySchema — mixed (string | AcceptanceGate)[] (T780)', () => {
  it('round-trips a mixed array with legacy strings and a typed gate', () => {
    const mixedInput: AcceptanceItem[] = [
      'legacy string 1',
      {
        kind: 'test',
        command: 'npm test',
        expect: 'pass',
        description: 'All unit tests must pass with zero failures',
      },
      'legacy string 2',
    ];

    const parsed = acceptanceArraySchema.parse(mixedInput);

    // Assert the array length is preserved
    expect(parsed).toHaveLength(3);

    // First element: plain string passes through unchanged
    expect(parsed[0]).toBe('legacy string 1');

    // Second element: typed gate validated and round-tripped correctly
    const gate = parsed[1];
    expect(typeof gate).toBe('object');
    if (typeof gate === 'object' && gate !== null && 'kind' in gate) {
      expect(gate.kind).toBe('test');
      if (gate.kind === 'test') {
        expect(gate.command).toBe('npm test');
        expect(gate.expect).toBe('pass');
        expect(gate.description).toBe('All unit tests must pass with zero failures');
      }
    }

    // Third element: plain string passes through unchanged
    expect(parsed[2]).toBe('legacy string 2');

    // Verify full round-trip equality
    expect(parsed[0]).toEqual(mixedInput[0]);
    expect(parsed[1]).toEqual(mixedInput[1]);
    expect(parsed[2]).toEqual(mixedInput[2]);
  });

  it('accepts an array of only legacy strings', () => {
    const stringsOnly = ['Must pass linting', 'Must pass tests', 'Must build without errors'];
    const parsed = acceptanceArraySchema.parse(stringsOnly);
    expect(parsed).toEqual(stringsOnly);
  });

  it('accepts an array of only typed gates', () => {
    const gatesOnly: AcceptanceItem[] = [
      {
        kind: 'lint',
        tool: 'biome',
        expect: 'clean',
        description: 'Biome must report zero issues',
      },
      { kind: 'test', command: 'pnpm test', expect: 'pass', description: 'Test suite must pass' },
    ];
    const parsed = acceptanceArraySchema.parse(gatesOnly);
    expect(parsed).toHaveLength(2);
    const first = parsed[0];
    if (typeof first === 'object' && first !== null && 'kind' in first) {
      expect(first.kind).toBe('lint');
    }
  });

  it('rejects an empty array (T800 — require at least 1 criterion)', () => {
    expect(() => acceptanceArraySchema.parse([])).toThrow(/at least one acceptance criterion/i);
  });

  it('rejects an element with an invalid gate kind', () => {
    // An object with an unknown 'kind' cannot be parsed as a gate and is
    // not a plain string — the union fails on both branches.
    expect(() =>
      acceptanceArraySchema.parse([{ kind: 'unknown-gate', description: 'bad' }]),
    ).toThrow();
  });

  it('rejects empty string in array (T800 — strings must be non-empty)', () => {
    const result = acceptanceArraySchema.safeParse(['valid', '', 'another']);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod returns an array of errors; check that the error messages are present
      const errorMessage = result.error.toString();
      expect(errorMessage).toMatch(/non-empty|too_small/i);
    }
  });

  it('rejects whitespace-only string in array (T800 — strings must be non-empty after trim)', () => {
    const result = acceptanceArraySchema.safeParse(['valid', '   ', 'another']);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.toString();
      expect(errorMessage).toMatch(/non-empty|too_small/i);
    }
  });

  it('rejects malformed gate object (T800 — missing required kind field)', () => {
    const result = acceptanceArraySchema.safeParse([
      'valid',
      { description: 'missing kind field', missing: 'kind' },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorMessage = result.error.toString();
      // The error should indicate that the object is neither a string nor a valid gate
      expect(errorMessage).toMatch(/invalid.*union|Invalid input/i);
    }
  });

  it('rejects duplicate req: IDs across gates (T800 — GSD-style REQ-IDs must be unique)', () => {
    expect(() =>
      acceptanceArraySchema.parse([
        {
          kind: 'test',
          command: 'pnpm test',
          expect: 'pass',
          description: 'Tests pass',
          req: 'TEST-01',
        },
        {
          kind: 'file',
          path: 'README.md',
          assertions: [{ type: 'exists' }],
          description: 'README exists',
          req: 'TEST-01',
        },
      ]),
    ).toThrow(/duplicate req/i);
  });

  it('accepts mixed array with unique req: IDs (T800)', () => {
    const parsed = acceptanceArraySchema.parse([
      'legacy string criterion',
      {
        kind: 'test',
        command: 'pnpm test',
        expect: 'pass',
        description: 'Tests pass',
        req: 'TEST-01',
      },
      {
        kind: 'file',
        path: 'README.md',
        assertions: [{ type: 'exists' }],
        description: 'README exists',
        req: 'README-01',
      },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toBe('legacy string criterion');
  });

  it('accepts gates with no req: field (T800)', () => {
    const parsed = acceptanceArraySchema.parse([
      {
        kind: 'test',
        command: 'pnpm test',
        expect: 'pass',
        description: 'Tests pass',
      },
      {
        kind: 'file',
        path: 'README.md',
        assertions: [{ type: 'exists' }],
        description: 'README exists',
      },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('accepts multiple gates with same req when not all have req (T800 — no duplicates when undefined)', () => {
    // Multiple undefined req values should be allowed
    const parsed = acceptanceArraySchema.parse([
      {
        kind: 'test',
        command: 'pnpm test',
        expect: 'pass',
        description: 'Tests pass',
      },
      {
        kind: 'file',
        path: 'README.md',
        assertions: [{ type: 'exists' }],
        description: 'README exists',
      },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('type-checks: parsed result is assignable to AcceptanceItem[]', () => {
    const input: AcceptanceItem[] = [
      'free text',
      { kind: 'manual', prompt: 'Does it look right?', description: 'Visual check' },
    ];
    const parsed = acceptanceArraySchema.parse(input);
    // Compile-time structural check: parsed type must be assignable to AcceptanceItem[]
    const typed: AcceptanceItem[] = parsed;
    expect(typed).toHaveLength(2);
  });
});
