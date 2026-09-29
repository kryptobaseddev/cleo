/**
 * Readers for the tracked identity: `.cleo/project.json` (T12716) and the
 * legacy write-once `.cleo/project-id` (T12325).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPortableProjectId,
  formatProjectManifest,
  isValidPortableProjectId,
  isValidProjectDisplayName,
  parsePortableProjectId,
  parseProjectManifest,
  readPortableProjectId,
  readProjectIdFile,
  readProjectManifest,
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

  it('round-trips project.json with a stable key order and trailing newline', () => {
    const body = formatProjectManifest({ schemaVersion: 1, id: 'c78d09c3a8ee', name: 'cleocode' });
    expect(body).toBe(
      '{\n  "schemaVersion": 1,\n  "id": "c78d09c3a8ee",\n  "name": "cleocode"\n}\n',
    );
    expect(parseProjectManifest(body)).toEqual({
      status: 'valid',
      manifest: { schemaVersion: 1, id: 'c78d09c3a8ee', name: 'cleocode' },
    });
  });

  it('rejects a newer schemaVersion, a bad id, a path-like name and non-objects', () => {
    const bad = [
      '{"schemaVersion":2,"id":"c78d09c3a8ee","name":"x"}',
      '{"schemaVersion":1,"id":"../etc","name":"x"}',
      '{"schemaVersion":1,"id":"c78d09c3a8ee","name":"a/b"}',
      '{"schemaVersion":1,"id":"c78d09c3a8ee","name":""}',
      '[]',
      'not json',
    ];
    for (const body of bad) expect(parseProjectManifest(body)).toMatchObject({ status: 'invalid' });
    // Unknown extra keys are ignored.
    expect(
      parseProjectManifest('{"schemaVersion":1,"id":"c78d09c3a8ee","name":"x","extra":true}'),
    ).toMatchObject({ status: 'valid' });
  });

  it('validates display names as labels, never paths', () => {
    expect(isValidProjectDisplayName('cleo-platform')).toBe(true);
    expect(isValidProjectDisplayName('My Project')).toBe(true);
    expect(isValidProjectDisplayName('~home')).toBe(false);
    expect(isValidProjectDisplayName(' padded ')).toBe(false);
    expect(isValidProjectDisplayName('a\\b')).toBe(false);
    expect(isValidProjectDisplayName('x'.repeat(121))).toBe(false);
  });

  it('resolves project.json first, then project-id; a broken project.json never falls through', () => {
    mkdirSync(join(root, '.cleo'));
    writeFileSync(join(root, '.cleo', 'project-id'), formatPortableProjectId('legacy-id'));
    expect(readPortableProjectId(root)).toEqual({
      status: 'valid',
      projectId: 'legacy-id',
      file: 'project-id',
    });
    writeFileSync(
      join(root, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: 'manifest-id', name: 'n' }),
    );
    expect(readPortableProjectId(root)).toEqual({
      status: 'valid',
      projectId: 'manifest-id',
      file: 'project.json',
      name: 'n',
    });
    expect(readProjectIdFile(root)).toMatchObject({ projectId: 'legacy-id' });
    writeFileSync(join(root, '.cleo', 'project.json'), '{');
    expect(readPortableProjectId(root)).toMatchObject({ status: 'invalid', file: 'project.json' });
    expect(readProjectManifest(root)).toMatchObject({ status: 'invalid' });
  });
});
