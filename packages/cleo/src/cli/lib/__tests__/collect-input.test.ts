/**
 * Unit tests for collect-input.ts (T9916 — Saga T9855 / E7.3).
 *
 * Covers the four-channel precedence ladder, JSON parse-error envelopes,
 * filesystem error propagation, and stdin draining semantics.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectMutateInput,
  readStdinJson,
  type StdinLike,
  wrapParseError,
} from '../collect-input.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a piped (non-TTY) stdin double from a string.
 */
function pipedStdin(payload: string): StdinLike {
  const stream = Readable.from([Buffer.from(payload, 'utf8')]) as StdinLike;
  stream.isTTY = false;
  return stream;
}

/**
 * Build a TTY (interactive) stdin double — no piped data.
 */
function ttyStdin(): StdinLike {
  const stream = Readable.from([]) as StdinLike;
  stream.isTTY = true;
  return stream;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'collect-input-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('collectMutateInput — precedence', () => {
  it('--params wins over --file, stdin, and positional', async () => {
    const filePath = join(tmpDir, 'wins.json');
    await writeFile(filePath, JSON.stringify({ from: 'file' }), 'utf8');
    const result = await collectMutateInput(
      {
        params: JSON.stringify({ from: 'params' }),
        file: filePath,
        positional: ['from-positional'],
      },
      pipedStdin(JSON.stringify({ from: 'stdin' })),
    );
    expect(result).toEqual({ from: 'params' });
  });

  it('--file wins over stdin and positional when --params absent', async () => {
    const filePath = join(tmpDir, 'wins.json');
    await writeFile(filePath, JSON.stringify({ from: 'file' }), 'utf8');
    const result = await collectMutateInput(
      { file: filePath, positional: ['from-positional'] },
      pipedStdin(JSON.stringify({ from: 'stdin' })),
    );
    expect(result).toEqual({ from: 'file' });
  });

  it('stdin wins over positional when --params and --file absent', async () => {
    const result = await collectMutateInput(
      { positional: ['from-positional'] },
      pipedStdin(JSON.stringify({ from: 'stdin' })),
    );
    expect(result).toEqual({ from: 'stdin' });
  });

  it('positional returned as-is when no other source provided', async () => {
    const result = await collectMutateInput({ positional: ['a', 'b', 'c'] }, ttyStdin());
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined when stdin is TTY and no other source provided', async () => {
    const result = await collectMutateInput({}, ttyStdin());
    expect(result).toBeUndefined();
  });

  it('returns undefined when positional is empty array on a TTY stdin', async () => {
    const result = await collectMutateInput({ positional: [] }, ttyStdin());
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JSON parse errors
// ---------------------------------------------------------------------------

describe('collectMutateInput — JSON parse errors', () => {
  it('throws with --params source label and snippet on bad JSON', async () => {
    const bad = '{"title": "broken'; // missing closing quote + brace
    await expect(collectMutateInput({ params: bad }, ttyStdin())).rejects.toThrow(
      /Invalid JSON in --params:/,
    );
    await expect(collectMutateInput({ params: bad }, ttyStdin())).rejects.toThrow(
      /got: \{"title": "broken/,
    );
  });

  it('throws with --file <path> source label and snippet on bad JSON', async () => {
    const filePath = join(tmpDir, 'bad.json');
    await writeFile(filePath, '{not-json', 'utf8');
    await expect(collectMutateInput({ file: filePath }, ttyStdin())).rejects.toThrow(
      new RegExp(`Invalid JSON in --file ${filePath.replace(/[.\\/]/g, '\\$&')}`),
    );
    await expect(collectMutateInput({ file: filePath }, ttyStdin())).rejects.toThrow(
      /got: \{not-json/,
    );
  });

  it('propagates ENOENT-style errors for missing --file path', async () => {
    const missing = join(tmpDir, 'does-not-exist.json');
    await expect(collectMutateInput({ file: missing }, ttyStdin())).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });

  it('throws with stdin source label on bad piped JSON', async () => {
    await expect(collectMutateInput({}, pipedStdin('{not-json'))).rejects.toThrow(
      /Invalid JSON in stdin:/,
    );
  });
});

// ---------------------------------------------------------------------------
// Stdin draining
// ---------------------------------------------------------------------------

describe('readStdinJson', () => {
  it('parses a simple piped JSON object', async () => {
    const result = await readStdinJson(pipedStdin('{"a":1}'));
    expect(result).toEqual({ a: 1 });
  });

  it('reads a 10KB stdin payload without truncation', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ idx: i, pad: 'x'.repeat(8) }));
    const payload = JSON.stringify(items);
    expect(payload.length).toBeGreaterThan(10_000);
    const result = (await readStdinJson(pipedStdin(payload))) as Array<{ idx: number }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1000);
    expect(result[0]).toEqual({ idx: 0, pad: 'xxxxxxxx' });
    expect(result[999]).toEqual({ idx: 999, pad: 'xxxxxxxx' });
  });

  it('rejects with descriptive error on invalid JSON', async () => {
    await expect(readStdinJson(pipedStdin('not-json'))).rejects.toThrow(/Invalid JSON in stdin:/);
  });

  it('rejects when stream emits an error event', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('boom from stream'));
      },
    });
    await expect(readStdinJson(stream)).rejects.toThrow(/boom from stream/);
  });
});

// ---------------------------------------------------------------------------
// wrapParseError
// ---------------------------------------------------------------------------

describe('wrapParseError', () => {
  it('includes source label, parse message, and full input when short', () => {
    const err = wrapParseError(
      '{"a":}',
      new SyntaxError('Unexpected token } in JSON at position 5'),
      '--params',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Invalid JSON in --params:');
    expect(err.message).toContain('Unexpected token');
    expect(err.message).toContain('got: {"a":}');
  });

  it('truncates long input with ellipsis', () => {
    const long = 'x'.repeat(500);
    const err = wrapParseError(long, new SyntaxError('bad'), 'stdin');
    expect(err.message).toContain('Invalid JSON in stdin:');
    expect(err.message).toContain('…');
    // Snippet is clamped, but the message MUST NOT include the full 500-char body.
    expect(err.message.length).toBeLessThan(500);
  });
});
