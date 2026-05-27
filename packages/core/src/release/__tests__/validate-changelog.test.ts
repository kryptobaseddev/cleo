/**
 * Tests for `cleo release validate-changelog <version>` — the canonical
 * CHANGELOG.md header validator that replaces the brittle inline
 * `grep -qF "## [${VERSION}]"` step in `.github/workflows/release.yml`.
 *
 * Background: during the v2026.5.94 hotfix-2 ship the aggregator emitted
 * `## [vVERSION]` (with v) while the workflow grep expected `## [VERSION]`
 * (no v) per ADR-028 §2.5. A pure CLEO verb removes the shell-quoting +
 * format-drift risk by normalising version inputs (`v2026.5.94`,
 * `2026.5.94`, `2026.5.94 ` — all accepted) and asserting the canonical
 * header shape directly.
 *
 * @task T9937
 * @saga T9862
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateChangelog } from '../validate-changelog.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-validate-changelog-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('validateChangelog', () => {
  it('accepts canonical `## [VERSION]` header (no v-prefix)', async () => {
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [2026.5.94] (2026-05-21)\n\nNotes.\n',
      'utf-8',
    );

    const result = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    expect(result.valid).toBe(true);
    expect(result.normalizedVersion).toBe('2026.5.94');
    expect(result.headerFound).toBe('## [2026.5.94]');
    expect(result.changelogPath).toBe(changelogPath);
    expect(result.reason).toBeUndefined();
  });

  it('accepts a v-prefixed input by normalising before matching', async () => {
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [2026.5.94] (2026-05-21)\n\nNotes.\n',
      'utf-8',
    );

    const result = await validateChangelog({
      version: 'v2026.5.94',
      projectRoot: testDir,
    });

    expect(result.valid).toBe(true);
    expect(result.normalizedVersion).toBe('2026.5.94');
  });

  it('rejects when CHANGELOG.md is missing the canonical header', async () => {
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [2026.5.93] (2026-05-20)\n\nOld notes.\n',
      'utf-8',
    );

    const result = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    expect(result.valid).toBe(false);
    expect(result.normalizedVersion).toBe('2026.5.94');
    expect(result.headerFound).toBeNull();
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('## [2026.5.94]');
  });

  it('rejects when CHANGELOG.md is missing on disk', async () => {
    const result = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/not found|does not exist/i);
  });

  it('matches header even when followed by `(date)` suffix or trailing text', async () => {
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [2026.5.94] (2026-05-21) — hotfix\n\nNotes.\n',
      'utf-8',
    );

    const result = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    expect(result.valid).toBe(true);
  });

  it('returns the same verdict as the legacy grep -qF check when header is present', async () => {
    // Canonical header — both checks should agree (true)
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [2026.5.94] (2026-05-21)\n\nNotes.\n',
      'utf-8',
    );

    const cleoResult = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    // Emulate `grep -qF "## [${VERSION}]" CHANGELOG.md` against the same file.
    const { readFile } = await import('node:fs/promises');
    const fileText = await readFile(changelogPath, 'utf-8');
    const grepWouldMatch = fileText.includes('## [2026.5.94]');

    expect(cleoResult.valid).toBe(grepWouldMatch);
    expect(cleoResult.valid).toBe(true);
  });

  it('returns the same verdict as the legacy grep -qF check when header is missing', async () => {
    const changelogPath = join(testDir, 'CHANGELOG.md');
    await writeFile(changelogPath, '# Changelog\n\n## [2026.5.93] (2026-05-20)\n\nOld.\n', 'utf-8');

    const cleoResult = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
    });

    const { readFile } = await import('node:fs/promises');
    const fileText = await readFile(changelogPath, 'utf-8');
    const grepWouldMatch = fileText.includes('## [2026.5.94]');

    expect(cleoResult.valid).toBe(grepWouldMatch);
    expect(cleoResult.valid).toBe(false);
  });

  it('honours an explicit `changelogPath` override', async () => {
    const customPath = join(testDir, 'NOTES.md');
    await writeFile(customPath, '## [2026.5.94] (2026-05-21)\n', 'utf-8');

    const result = await validateChangelog({
      version: '2026.5.94',
      projectRoot: testDir,
      changelogPath: customPath,
    });

    expect(result.valid).toBe(true);
    expect(result.changelogPath).toBe(customPath);
  });
});
