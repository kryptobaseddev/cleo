/**
 * Reader for the tracked write-once `.cleo/project-id` (T12325).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPortableProjectId,
  isValidPortableProjectId,
  parsePortableProjectId,
  readPortableProjectId,
} from '../portable-project-id.js';

describe('portable project id', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-portable-id-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips the written format, ignoring the comment header', () => {
    expect(parsePortableProjectId(formatPortableProjectId('c78d09c3a8ee'))).toEqual({
      status: 'valid',
      projectId: 'c78d09c3a8ee',
    });
  });

  it('accepts every id shape CLEO has minted and rejects path-like input', () => {
    expect(isValidPortableProjectId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidPortableProjectId('c78d09c3a8ee')).toBe(true);
    expect(isValidPortableProjectId('../etc/passwd')).toBe(false);
    expect(isValidPortableProjectId('has space')).toBe(false);
  });

  it('distinguishes absent from invalid', () => {
    expect(readPortableProjectId(root)).toEqual({ status: 'absent' });
    mkdirSync(join(root, '.cleo'));
    writeFileSync(join(root, '.cleo', 'project-id'), 'a\nb\n');
    expect(readPortableProjectId(root)).toMatchObject({ status: 'invalid' });
    writeFileSync(join(root, '.cleo', 'project-id'), '\n');
    expect(readPortableProjectId(root)).toMatchObject({ status: 'invalid' });
  });
});
