/**
 * Install verification tests for the ct-master-tac plugin (T431).
 *
 * Lives in packages/core/src/__tests__ so the root vitest config picks it up.
 * Verifies SKILL.md frontmatter, manifest.json correctness, bundled file presence,
 * and idempotent install semantics via a mock helper.
 *
 * @task T431
 * @epic T382
 * @umbrella T377
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
/** Resolve from packages/core/src/__tests__/ up to repo root, then into skills */
const repoRoot = resolve(dirname(thisFile), '..', '..', '..', '..');
const skillRoot = join(repoRoot, 'packages', 'skills', 'skills', 'ct-master-tac');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract raw YAML frontmatter between the first pair of --- delimiters. */
function extractFrontmatter(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  return match ? match[1] : null;
}

/** Minimal frontmatter key extractor — no external deps required. */
function parseFrontmatterKeys(fm: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line.trimEnd());
    if (m) {
      result[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

interface InstallResult {
  copiedFiles: string[];
  skippedFiles: string[];
}

/**
 * Mock install helper — simulates copying bundled files to target paths.
 * Files already in `alreadyInstalled` are skipped (idempotency).
 */
function mockInstall(manifestFiles: string[], alreadyInstalled: Set<string>): InstallResult {
  const copiedFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const f of manifestFiles) {
    if (alreadyInstalled.has(f)) {
      skippedFiles.push(f);
    } else {
      copiedFiles.push(f);
    }
  }
  return { copiedFiles, skippedFiles };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ct-master-tac plugin install verification (T431)', () => {
  describe('plugin directory exists', () => {
    it('ct-master-tac directory exists under packages/skills/skills/', () => {
      expect(existsSync(skillRoot)).toBe(true);
    });

    it('SKILL.md exists', () => {
      expect(existsSync(join(skillRoot, 'SKILL.md'))).toBe(true);
    });

    it('manifest.json exists', () => {
      expect(existsSync(join(skillRoot, 'manifest.json'))).toBe(true);
    });
  });

  describe('SKILL.md frontmatter', () => {
    it('has valid frontmatter with required fields', () => {
      const content = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
      const fm = extractFrontmatter(content);
      expect(fm).not.toBeNull();
      const keys = parseFrontmatterKeys(fm!);
      expect(keys['name']).toBe('ct-master-tac');
      expect(keys['version']).toBeTruthy();
      expect(keys['tier']).toBeTruthy();
    });
  });

  describe('manifest.json', () => {
    it('parses as valid JSON with required keys', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      expect(manifest['name']).toBe('ct-master-tac');
      expect(Array.isArray(manifest['files'])).toBe(true);
    });

    it('references 13 bundled files (12 protocols + 1 team)', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      expect(manifest.files).toHaveLength(13);
    });
  });

  describe('bundled files', () => {
    it('all manifest files exist on disk', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const missing = manifest.files.filter((f) => !existsSync(join(skillRoot, f)));
      expect(missing).toEqual([]);
    });

    it('all protocol files contain CANT frontmatter (kind: protocol)', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const bad = manifest.files
        .filter((f) => f.startsWith('bundled/protocols/'))
        .filter((f) => {
          const content = readFileSync(join(skillRoot, f), 'utf-8');
          return !content.includes('kind: protocol');
        });
      expect(bad).toEqual([]);
    });

    it('bundle contains exactly 12 protocol files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const protocols = manifest.files.filter((f) => f.startsWith('bundled/protocols/'));
      expect(protocols).toHaveLength(12);
    });
  });

  describe('idempotent install', () => {
    it('first install copies all 13 files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const result = mockInstall(manifest.files, new Set<string>());
      expect(result.copiedFiles).toHaveLength(13);
      expect(result.skippedFiles).toHaveLength(0);
    });

    it('second install is a no-op (all files already present)', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const already = new Set<string>(manifest.files);
      const result = mockInstall(manifest.files, already);
      expect(result.copiedFiles).toHaveLength(0);
      expect(result.skippedFiles).toHaveLength(13);
    });

    it('partial install copies only missing files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const already = new Set<string>(manifest.files.slice(0, 10));
      const result = mockInstall(manifest.files, already);
      expect(result.copiedFiles).toHaveLength(3);
      expect(result.skippedFiles).toHaveLength(10);
    });
  });
});
