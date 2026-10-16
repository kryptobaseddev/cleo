/**
 * A bundle never carries a store's restore or genesis marker (T13370). The
 * genesis snapshot of the main brain is taken while its own `cleo.db.restoring`
 * marker is held; carried in the bundle, the marker landed beside the store a
 * second device restored and refused every open there (`E_STORE_GENESIS`)
 * until it aged out, so the device could never join `home:<user>`.
 *
 * @task T13370
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_HOME_RULES, PROJECT_SECTION_RULES, scanSection } from '../portable-bundle-scan.js';
import { RESTORE_MARKER_SUFFIX } from '../restore-marker.js';

describe('section scans exclude restore and genesis markers', () => {
  it.each([
    ['global home', GLOBAL_HOME_RULES],
    ['project .cleo', PROJECT_SECTION_RULES],
  ] as const)('%s: the marker is excluded and never exported', (_name, rules) => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-scan-marker-'));
    mkdirSync(root, { recursive: true });
    const marker = `cleo.db${RESTORE_MARKER_SUFFIX}`;
    writeFileSync(join(root, marker), '{"pid":1,"kind":"genesis"}\n');
    writeFileSync(join(root, 'config.json'), '{}');

    const scan = scanSection(root, rules);
    const exported = [...scan.files, ...scan.sqlite, ...scan.secrets.map((s) => s.relPath)];

    expect(exported).not.toContain(marker);
    expect(exported).toContain('config.json');
    expect(scan.excluded.find((e) => e.relPath === marker)?.reason).toMatch(/marker/);
  });
});

describe('section scans carry the docs byte surfaces (T13704)', () => {
  it('project .cleo walk captures .cleo/blobs and .cleo/attachments — the cloud vault bundle restores doc bytes on a fresh device', () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-scan-docs-bytes-'));
    mkdirSync(join(root, 'blobs', 'blobs'), { recursive: true });
    writeFileSync(join(root, 'blobs', 'blobs', 'a'.repeat(64)), 'blob bytes');
    writeFileSync(join(root, 'blobs', 'manifest.db'), 'SQLite format 3\0not-really');
    mkdirSync(join(root, 'attachments', 'sha256', 'ab'), { recursive: true });
    writeFileSync(
      join(root, 'attachments', 'sha256', 'ab', `${'c'.repeat(62)}.md`),
      'legacy bytes',
    );

    const scan = scanSection(root, PROJECT_SECTION_RULES);
    const exported = [...scan.files, ...scan.sqlite, ...scan.secrets.map((s) => s.relPath)];

    expect(exported).toContain(`blobs/blobs/${'a'.repeat(64)}`);
    expect(exported).toContain(`attachments/sha256/ab/${'c'.repeat(62)}.md`);
    // The manifest goes through the SQLite VACUUM path (it starts with the
    // SQLite magic above), so it is captured as a database, not a raw file.
    expect(exported).toContain('blobs/manifest.db');
    // And nothing about either surface shows up in the exclusion report.
    expect(scan.excluded.filter((e) => e.relPath.startsWith('blobs'))).toEqual([]);
    expect(scan.excluded.filter((e) => e.relPath.startsWith('attachments'))).toEqual([]);
  });
});
