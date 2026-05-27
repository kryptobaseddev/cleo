/**
 * Tests for `--field <jsonpointer>` flag (T9929 / Saga T9855 / E9).
 *
 * Verifies that:
 *  - `--field /data/title` extracts a nested string and prints it raw.
 *  - `--field /data/0/id` extracts an array element's scalar.
 *  - `--field /nonexistent` exits 4 with `E_FIELD_NOT_FOUND`.
 *  - `--field /` returns the whole envelope (RFC 6901 + CLI alias).
 *  - Booleans and numbers serialize via `JSON.stringify`.
 *  - Objects/arrays serialize as indented JSON.
 *  - The legacy fuzzy-field-name form (`--field title`) is unaffected.
 *
 * Mirrors the mock pattern in `../cli-output-flags.test.ts` so the
 * test does not require an end-to-end CLI spawn.
 *
 * @task T9929
 * @epic T9919
 * @saga T9855
 */

import { extractByJsonPointer, isJsonPointer, serializePointerValue } from '@cleocode/core';
import type { FieldExtractionResolution, FlagResolution } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the format-context and field-context modules — keeps the test
// hermetic against the global singleton state set during real CLI runs.
vi.mock('../../format-context.js', () => ({
  getFormatContext: vi.fn(),
  setFormatContext: vi.fn(),
  isJsonFormat: vi.fn(),
  isHumanFormat: vi.fn(),
  isQuiet: vi.fn(),
}));

vi.mock('../../field-context.js', () => ({
  getFieldContext: vi.fn(),
  setFieldContext: vi.fn(),
  resolveFieldContext: vi.fn(),
}));

import { getFieldContext } from '../../field-context.js';
import { getFormatContext } from '../../format-context.js';
import { cliOutput } from '../../renderers/index.js';

// ---------------------------------------------------------------------------
// Pure-function tests for the projection helpers — these don't require
// any CLI plumbing and lock the RFC 6901 grammar in place.
// ---------------------------------------------------------------------------

describe('extractByJsonPointer (RFC 6901)', () => {
  const env = {
    success: true,
    data: {
      task: { id: 'T123', title: 'Fix the thing', priority: 1, blocked: false },
      items: [{ id: 'T1' }, { id: 'T2' }],
      'a/b': 'slash-escaped-key',
      'a~b': 'tilde-escaped-key',
    },
    meta: { operation: 'tasks.show' },
  } as const;

  it('returns the whole document for empty pointer (strict RFC 6901)', () => {
    expect(extractByJsonPointer(env, '')).toBe(env);
  });

  it('returns the whole document for "/" (CLI convenience alias)', () => {
    expect(extractByJsonPointer(env, '/')).toBe(env);
  });

  it('extracts a nested string scalar', () => {
    expect(extractByJsonPointer(env, '/data/task/title')).toBe('Fix the thing');
  });

  it('extracts a nested number scalar', () => {
    expect(extractByJsonPointer(env, '/data/task/priority')).toBe(1);
  });

  it('extracts a nested boolean scalar', () => {
    expect(extractByJsonPointer(env, '/data/task/blocked')).toBe(false);
  });

  it('extracts an array element by numeric index', () => {
    expect(extractByJsonPointer(env, '/data/items/0/id')).toBe('T1');
    expect(extractByJsonPointer(env, '/data/items/1/id')).toBe('T2');
  });

  it('decodes ~1 to "/" per RFC 6901 §4', () => {
    expect(extractByJsonPointer(env, '/data/a~1b')).toBe('slash-escaped-key');
  });

  it('decodes ~0 to "~" per RFC 6901 §4', () => {
    expect(extractByJsonPointer(env, '/data/a~0b')).toBe('tilde-escaped-key');
  });

  it('returns undefined for a missing property', () => {
    expect(extractByJsonPointer(env, '/data/task/missing')).toBeUndefined();
  });

  it('returns undefined for an out-of-range array index', () => {
    expect(extractByJsonPointer(env, '/data/items/99/id')).toBeUndefined();
  });

  it('returns undefined for the array "-" indicator (write-only token)', () => {
    expect(extractByJsonPointer(env, '/data/items/-')).toBeUndefined();
  });

  it('returns undefined for a non-numeric token on an array', () => {
    expect(extractByJsonPointer(env, '/data/items/foo')).toBeUndefined();
  });

  it('returns undefined when descending into a primitive', () => {
    expect(extractByJsonPointer(env, '/data/task/title/anything')).toBeUndefined();
  });

  it('returns undefined for a malformed pointer with no leading slash', () => {
    expect(extractByJsonPointer(env, 'data/task/title')).toBeUndefined();
  });
});

describe('isJsonPointer', () => {
  it.each([
    ['', true],
    ['/', true],
    ['/data/title', true],
    ['/data/items/0', true],
    ['title', false],
    ['data.title', false],
    ['data/title', false],
  ])('isJsonPointer(%p) === %p', (input, expected) => {
    expect(isJsonPointer(input)).toBe(expected);
  });
});

describe('serializePointerValue', () => {
  it('returns strings raw (no quotes)', () => {
    expect(serializePointerValue('hello')).toBe('hello');
  });

  it('returns numbers via JSON.stringify', () => {
    expect(serializePointerValue(42)).toBe('42');
    expect(serializePointerValue(0.5)).toBe('0.5');
  });

  it('returns booleans via JSON.stringify', () => {
    expect(serializePointerValue(true)).toBe('true');
    expect(serializePointerValue(false)).toBe('false');
  });

  it('returns null as the literal "null"', () => {
    expect(serializePointerValue(null)).toBe('null');
  });

  it('returns objects as indented JSON', () => {
    expect(serializePointerValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('returns arrays as indented JSON', () => {
    expect(serializePointerValue([1, 2])).toBe('[\n  1,\n  2\n]');
  });

  it('throws on undefined (callers must guard)', () => {
    expect(() => serializePointerValue(undefined)).toThrow(/undefined/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end `cliOutput` integration with --field /pointer
// ---------------------------------------------------------------------------

describe('cliOutput --field <jsonpointer>', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Throw on process.exit so we can assert exit-code intent without
    // actually terminating the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);

    vi.mocked(getFormatContext).mockReturnValue({
      format: 'json',
      source: 'default',
      quiet: false,
    } satisfies FlagResolution);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('cleo show T123 --field /data/title prints the title string only', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/title',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ id: 'T123', title: 'Fix the thing' }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('Fix the thing\n');
  });

  it('cleo show T123 --field /nonexistent exits 4 with E_FIELD_NOT_FOUND', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/nonexistent',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    expect(() => cliOutput({ id: 'T123', title: 'x' }, { command: 'show' })).toThrow('__exit__:4');

    // `cliError` in JSON mode (the test default) emits a LAFS error
    // envelope to stdout. Assert the canonical code so consumers can grep
    // `"codeName":"E_FIELD_NOT_FOUND"` from the JSON stream.
    const stdoutText = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(stdoutText).toContain('E_FIELD_NOT_FOUND');
  });

  it('cleo list --field /data/0/id prints the first task id', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/0/id',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput(
      [
        { id: 'T1', title: 'first' },
        { id: 'T2', title: 'second' },
      ],
      { command: 'list' },
    );

    expect(stdoutSpy).toHaveBeenCalledWith('T1\n');
  });

  it('--field / returns the whole envelope as indented JSON', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ id: 'T1' }, { command: 'show', operation: 'tasks.show' });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0]?.[0] as string;
    // Indented JSON ends with a newline appended by cliOutput.
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written.trimEnd());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ id: 'T1' });
    expect(parsed.meta.operation).toBe('tasks.show');
  });

  it('boolean scalars serialize correctly', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/verification/gates/implemented',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ verification: { gates: { implemented: true } } }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('true\n');
  });

  it('number scalars serialize correctly', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/count',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ count: 42 }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('42\n');
  });

  it('object values serialize as indented JSON', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/metadata',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ metadata: { key: 'value', n: 1 } }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('{\n  "key": "value",\n  "n": 1\n}\n');
  });

  it('null scalars serialize as the literal "null"', () => {
    vi.mocked(getFieldContext).mockReturnValue({
      field: '/data/owner',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ owner: null }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('null\n');
  });

  it('legacy fuzzy-field-name form (no leading slash) is unaffected', () => {
    // Sanity check: passing a bare field name routes through the legacy
    // extractor (which finds `title` one level down in `{ task: {…} }`).
    // If the JSON-pointer path mistakenly intercepted this it would emit
    // `E_FIELD_NOT_FOUND` because no top-level "title" key exists.
    vi.mocked(getFieldContext).mockReturnValue({
      field: 'title',
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
    } as FieldExtractionResolution);

    cliOutput({ task: { id: 'T1', title: 'legacy' } }, { command: 'show' });

    expect(stdoutSpy).toHaveBeenCalledWith('legacy\n');
  });
});
