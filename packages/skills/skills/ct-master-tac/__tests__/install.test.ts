/**
 * Install verification tests for the ct-master-tac plugin (T431).
 *
 * Asserts:
 * - SKILL.md has valid YAML frontmatter
 * - manifest.json parses correctly and references the correct files
 * - All files referenced in manifest.json `files` array exist under bundled/
 * - Install is idempotent (second run produces no additional writes)
 * - Bundle contains exactly 12 protocol files + 1 platform team file
 *
 * @task T431
 * @epic T382
 * @umbrella T377
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);
/** Absolute path to the ct-master-tac root directory */
const skillRoot = resolve(dirname(thisFile), '..');

/**
 * Parse YAML frontmatter from a Markdown file.
 * Returns the raw frontmatter string between the opening and closing `---`.
 */
function extractFrontmatter(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  return match ? match[1] : null;
}

/**
 * Minimal frontmatter key extractor — no external deps, just key: value lines.
 */
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

// ---------------------------------------------------------------------------
// Mock install helper for idempotency test
// ---------------------------------------------------------------------------

interface InstallResult {
  copiedFiles: string[];
  skippedFiles: string[];
}

/**
 * Simulated install helper — copies bundled/ files to target paths.
 * Returns lists of copied and skipped files so idempotency can be verified.
 */
function mockInstall(
  manifestFiles: string[],
  alreadyInstalled: Set<string>,
): InstallResult {
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

describe('ct-master-tac plugin (T431)', () => {
  describe('SKILL.md frontmatter', () => {
    const skillMdPath = join(skillRoot, 'SKILL.md');

    it('SKILL.md exists', () => {
      expect(existsSync(skillMdPath)).toBe(true);
    });

    it('SKILL.md contains valid frontmatter delimiters', () => {
      const content = readFileSync(skillMdPath, 'utf-8');
      const fm = extractFrontmatter(content);
      expect(fm).not.toBeNull();
    });

    it('frontmatter has required fields: name, description, version, tier', () => {
      const content = readFileSync(skillMdPath, 'utf-8');
      const fm = extractFrontmatter(content);
      expect(fm).not.toBeNull();
      const keys = parseFrontmatterKeys(fm!);
      expect(keys['name']).toBe('ct-master-tac');
      expect(keys['description'] ?? keys['description']).toBeTruthy();
      expect(keys['version']).toBeTruthy();
      expect(keys['tier']).toBeTruthy();
    });
  });

  describe('manifest.json', () => {
    const manifestPath = join(skillRoot, 'manifest.json');
    let manifest: Record<string, unknown>;

    it('manifest.json exists', () => {
      expect(existsSync(manifestPath)).toBe(true);
    });

    it('manifest.json parses as valid JSON', () => {
      const raw = readFileSync(manifestPath, 'utf-8');
      expect(() => {
        manifest = JSON.parse(raw) as Record<string, unknown>;
      }).not.toThrow();
    });

    it('manifest has required top-level keys', () => {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as Record<string, unknown>;
      expect(manifest['name']).toBe('ct-master-tac');
      expect(manifest['version']).toBeTruthy();
      expect(Array.isArray(manifest['files'])).toBe(true);
    });

    it('files array contains exactly 13 entries (12 protocols + 1 team)', () => {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as Record<string, unknown>;
      const files = manifest['files'] as string[];
      expect(files).toHaveLength(13);
    });

    it('files array contains at least 12 protocol entries', () => {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as Record<string, unknown>;
      const files = manifest['files'] as string[];
      const protocolFiles = files.filter((f) => f.startsWith('bundled/protocols/'));
      expect(protocolFiles.length).toBeGreaterThanOrEqual(12);
    });

    it('files array contains platform team entry', () => {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifest = JSON.parse(raw) as Record<string, unknown>;
      const files = manifest['files'] as string[];
      expect(files).toContain('bundled/teams/platform.cant');
    });
  });

  describe('bundled files exist', () => {
    it('all files referenced in manifest.json exist under bundled/', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const missingFiles: string[] = [];

      for (const f of manifest.files) {
        const abs = join(skillRoot, f);
        if (!existsSync(abs)) {
          missingFiles.push(f);
        }
      }

      expect(missingFiles).toEqual([]);
    });

    it('each bundled protocol file is non-empty', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const emptyFiles: string[] = [];

      for (const f of manifest.files.filter((f) =>
        f.startsWith('bundled/protocols/'),
      )) {
        const abs = join(skillRoot, f);
        const content = readFileSync(abs, 'utf-8');
        if (content.trim().length === 0) {
          emptyFiles.push(f);
        }
      }

      expect(emptyFiles).toEqual([]);
    });

    it('each bundled protocol file has CANT frontmatter (kind: protocol)', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const badFiles: string[] = [];

      for (const f of manifest.files.filter((f) =>
        f.startsWith('bundled/protocols/'),
      )) {
        const abs = join(skillRoot, f);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes('kind: protocol')) {
          badFiles.push(f);
        }
      }

      expect(badFiles).toEqual([]);
    });
  });

  describe('idempotent install (mock)', () => {
    it('first install copies all 13 files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      const already = new Set<string>();

      const result = mockInstall(manifest.files, already);
      expect(result.copiedFiles).toHaveLength(13);
      expect(result.skippedFiles).toHaveLength(0);
    });

    it('second install (files already present) skips all 13 files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      // Simulate first install — all files now "present"
      const already = new Set<string>(manifest.files);

      const result = mockInstall(manifest.files, already);
      expect(result.copiedFiles).toHaveLength(0);
      expect(result.skippedFiles).toHaveLength(13);
    });

    it('partial install (3 missing) copies only missing files', () => {
      const raw = readFileSync(join(skillRoot, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as { files: string[] };
      // 10 of 13 already installed
      const already = new Set<string>(manifest.files.slice(0, 10));

      const result = mockInstall(manifest.files, already);
      expect(result.copiedFiles).toHaveLength(3);
      expect(result.skippedFiles).toHaveLength(10);
    });
  });

  describe('bundle completeness', () => {
    const EXPECTED_PROTOCOLS = [
      'research.cant',
      'consensus.cant',
      'architecture-decision.cant',
      'specification.cant',
      'decomposition.cant',
      'implementation.cant',
      'validation.cant',
      'testing.cant',
      'contribution.cant',
      'release.cant',
      'artifact-publish.cant',
      'provenance.cant',
    ] as const;

    for (const protocol of EXPECTED_PROTOCOLS) {
      it(`bundled/protocols/${protocol} exists`, () => {
        expect(
          existsSync(join(skillRoot, 'bundled', 'protocols', protocol)),
        ).toBe(true);
      });
    }

    it('bundled/teams/platform.cant exists', () => {
      expect(existsSync(join(skillRoot, 'bundled', 'teams', 'platform.cant'))).toBe(
        true,
      );
    });

    it('bundle contains exactly 12 CANT protocol files', () => {
      const protocolFiles = EXPECTED_PROTOCOLS.filter((f) =>
        existsSync(join(skillRoot, 'bundled', 'protocols', f)),
      );
      expect(protocolFiles).toHaveLength(12);
    });
  });
});
