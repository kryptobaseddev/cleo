/**
 * Tests for the SSoT template registry — T9877.
 *
 * @task T9877
 * @epic T9874
 * @saga T9855
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TemplateManifestEntrySchema } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getInstalledStatus,
  getTemplateById,
  getTemplateManifest,
  getTemplatesByKind,
} from '../registry.js';

describe('template registry (T9877)', () => {
  it('getTemplateManifest() returns a non-empty array', () => {
    const entries = getTemplateManifest();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every entry validates against templateManifestEntrySchema', () => {
    for (const entry of getTemplateManifest()) {
      // Will throw on schema violation, failing the test loudly.
      TemplateManifestEntrySchema.parse(entry);
    }
  });

  it('entry ids are unique', () => {
    const ids = getTemplateManifest().map((entry) => entry.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('getTemplateById() returns undefined for an unknown id', () => {
    expect(getTemplateById('definitely-not-a-real-template-id')).toBeUndefined();
  });

  it('getTemplateById() returns the matching entry for a known id', () => {
    const all = getTemplateManifest();
    const sample = all[0];
    expect(sample).toBeDefined();
    if (sample === undefined) return;
    const result = getTemplateById(sample.id);
    expect(result).toEqual(sample);
  });

  it('getTemplatesByKind("workflow") returns only workflow entries', () => {
    const workflows = getTemplatesByKind('workflow');
    expect(workflows.length).toBeGreaterThan(0);
    for (const entry of workflows) {
      expect(entry.kind).toBe('workflow');
    }
  });

  it('getTemplatesByKind() for an unused kind returns an empty array', () => {
    // Pick a kind unlikely to have entries — at the time of writing every
    // listed kind has at least one. If a future entry uses a brand-new
    // discriminator this just collapses the assertion to length === 0.
    const result = getTemplatesByKind('agent');
    for (const entry of result) {
      expect(entry.kind).toBe('agent');
    }
  });

  describe('getInstalledStatus()', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-tplreg-'));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('reports installed:false against an empty project root', () => {
      const first = getTemplateManifest()[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const status = getInstalledStatus(first.id, tmpRoot);
      expect(status.installed).toBe(false);
      expect(status.path).toBe(join(tmpRoot, first.installPath));
    });

    it('reports installed:true after writing the install target', () => {
      const first = getTemplateManifest()[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const target = join(tmpRoot, first.installPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'fixture', 'utf-8');
      const status = getInstalledStatus(first.id, tmpRoot);
      expect(status.installed).toBe(true);
      expect(status.path).toBe(target);
    });

    it('throws on a relative projectRoot', () => {
      const first = getTemplateManifest()[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      expect(() => getInstalledStatus(first.id, 'relative/path')).toThrow(/absolute/);
    });

    it('throws on an unknown template id', () => {
      expect(() => getInstalledStatus('nope-not-a-real-id', tmpRoot)).toThrow(
        /unknown template id/,
      );
    });
  });
});
