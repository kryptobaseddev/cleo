/**
 * Tests for changelog-writer.ts
 * @task T5579
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChangelogBlocks, writeChangelogSection } from '../changelog-writer.js';

// ── parseChangelogBlocks ──────────────────────────────────────────────

describe('parseChangelogBlocks', () => {
  it('returns empty array and unchanged content when no custom blocks present', () => {
    const content = '## Some content\n\n- item 1\n- item 2\n';
    const { customBlocks, strippedContent } = parseChangelogBlocks(content);
    expect(customBlocks).toEqual([]);
    expect(strippedContent).toBe(content);
  });

  it('extracts a single [custom-log] block and strips tags from strippedContent', () => {
    const content = 'Before\n[custom-log]\nHello world\n[/custom-log]\nAfter';
    const { customBlocks, strippedContent } = parseChangelogBlocks(content);
    expect(customBlocks).toHaveLength(1);
    expect(customBlocks[0]).toBe('Hello world');
    expect(strippedContent).not.toContain('[custom-log]');
    expect(strippedContent).not.toContain('[/custom-log]');
    expect(strippedContent).not.toContain('Hello world');
  });

  it('extracts multiple [custom-log] blocks into separate array items', () => {
    const content =
      '[custom-log]\nBlock one\n[/custom-log]\nMiddle\n[custom-log]\nBlock two\n[/custom-log]';
    const { customBlocks } = parseChangelogBlocks(content);
    expect(customBlocks).toHaveLength(2);
    expect(customBlocks[0]).toBe('Block one');
    expect(customBlocks[1]).toBe('Block two');
  });

  it('treats malformed/unclosed tag as no block and does not crash', () => {
    const content = '[custom-log]\nUnclosed block without end tag';
    const { customBlocks, strippedContent } = parseChangelogBlocks(content);
    expect(customBlocks).toEqual([]);
    // strippedContent should equal original since no complete block found
    expect(strippedContent).toBe(content);
  });

  it('is case-insensitive for tags', () => {
    const content = '[CUSTOM-LOG]\nUpper case\n[/CUSTOM-LOG]';
    const { customBlocks } = parseChangelogBlocks(content);
    expect(customBlocks).toHaveLength(1);
    expect(customBlocks[0]).toBe('Upper case');
  });
});

// ── writeChangelogSection ─────────────────────────────────────────────

describe('writeChangelogSection', () => {
  let tmpDir: string;
  let changelogPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `changelog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    changelogPath = join(tmpDir, 'CHANGELOG.md');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates file with new section when CHANGELOG.md does not exist', async () => {
    await writeChangelogSection('v1.0.0', '### Features\n- new thing', [], changelogPath);
    expect(existsSync(changelogPath)).toBe(true);
    const content = readFileSync(changelogPath, 'utf8');
    expect(content).toContain('## [v1.0.0]');
    expect(content).toContain('### Features');
    expect(content).toContain('- new thing');
  });

  it('prepends new section when CHANGELOG has a different version', async () => {
    const existing = '# CHANGELOG\n\n## [v0.9.0] (2026-01-01)\n\n- old thing\n\n---\n';
    writeFileSync(changelogPath, existing);

    await writeChangelogSection('v1.0.0', '### Features\n- new thing', [], changelogPath);
    const content = readFileSync(changelogPath, 'utf8');

    // New section should appear before old section
    const newIdx = content.indexOf('## [v1.0.0]');
    const oldIdx = content.indexOf('## [v0.9.0]');
    expect(newIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('replaces existing section with same version in-place', async () => {
    const existing =
      '# CHANGELOG\n\n## [v1.0.0] (2026-01-01)\n\n- old content\n\n---\n\n## [v0.9.0] (2025-12-01)\n\n- previous\n\n---\n';
    writeFileSync(changelogPath, existing);

    await writeChangelogSection('v1.0.0', '- updated content', [], changelogPath);
    const content = readFileSync(changelogPath, 'utf8');

    expect(content).toContain('- updated content');
    expect(content).not.toContain('- old content');
    // Old version should still be present
    expect(content).toContain('## [v0.9.0]');
  });

  it('appends custom block content in output without tags', async () => {
    await writeChangelogSection(
      'v1.0.0',
      '### Features\n- feature A',
      ['Important migration note'],
      changelogPath,
    );
    const content = readFileSync(changelogPath, 'utf8');
    expect(content).toContain('Important migration note');
    expect(content).not.toContain('[custom-log]');
    expect(content).not.toContain('[/custom-log]');
  });

  it('preserves existing [custom-log] blocks in section on re-generation', async () => {
    // Write initial version with a custom-log block
    const existing =
      '## [v1.0.0] (2026-01-01)\n\n- old generated\n\n[custom-log]\nKeep me\n[/custom-log]\n\n---\n';
    writeFileSync(changelogPath, existing);

    // Re-generate with no explicit custom blocks
    await writeChangelogSection('v1.0.0', '- new generated', [], changelogPath);
    const content = readFileSync(changelogPath, 'utf8');

    expect(content).toContain('- new generated');
    expect(content).toContain('Keep me');
    expect(content).not.toContain('- old generated');
  });
});
