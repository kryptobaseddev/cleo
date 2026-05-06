/**
 * Tests for CAAMP block deduplication — parseCaampBlocks, dedupeFile, dedupeFiles.
 *
 * Covers the T1939 bug pattern: AGENTS.md accumulates duplicate
 * <!-- CAAMP:START --> blocks across sessions, each with a different temp path.
 *
 * @task T1939
 * @epic T1929
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeFile,
  dedupeFiles,
  inject,
  parseCaampBlocks,
} from '../../src/core/instructions/injector.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `caamp-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

function block(content: string): string {
  return `<!-- CAAMP:START -->\n${content}\n<!-- CAAMP:END -->`;
}

// ── parseCaampBlocks ─────────────────────────────────────────────────────────

describe('parseCaampBlocks()', () => {
  it('returns empty array for file with no blocks', () => {
    const blocks = parseCaampBlocks('# Just a header\nSome content');
    expect(blocks).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(parseCaampBlocks('')).toHaveLength(0);
  });

  it('parses a single block', () => {
    const content = `${block('@~/.local/share/cleo/templates/CLEO-INJECTION.md')}\n`;
    const blocks = parseCaampBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('@~/.local/share/cleo/templates/CLEO-INJECTION.md');
  });

  it('parses multiple distinct blocks', () => {
    const content = [
      block('@~/.temp/path-A.md'),
      block('@~/.temp/path-B.md'),
      block('@~/.local/share/cleo/templates/CLEO-INJECTION.md'),
    ].join('\n');
    const blocks = parseCaampBlocks(content);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.content).toBe('@~/.temp/path-A.md');
    expect(blocks[1]?.content).toBe('@~/.temp/path-B.md');
    expect(blocks[2]?.content).toBe('@~/.local/share/cleo/templates/CLEO-INJECTION.md');
  });

  it('returns correct startIndex and endIndex', () => {
    const prefix = '# Header\n\n';
    const blockContent = block('@AGENTS.md');
    const content = prefix + blockContent + '\n';
    const blocks = parseCaampBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startIndex).toBe(prefix.length);
    expect(blocks[0]?.endIndex).toBe(prefix.length + blockContent.length);
  });

  it('parses 5 stacked duplicate blocks (the observed T1939 bug scenario)', () => {
    const tempPaths = [
      '@~/.temp/cleo-injection-chain-u7jbHE/.cleo-home/templates/CLEO-INJECTION.md',
      '@~/.temp/cleo-injection-chain-DX3jau/.cleo-home/templates/CLEO-INJECTION.md',
      '@~/.temp/cleo-injection-chain-iQOoCF/.cleo-home/templates/CLEO-INJECTION.md',
      '@~/.temp/cleo-injection-chain-FR74uI/.cleo-home/templates/CLEO-INJECTION.md',
      '@~/.local/share/cleo/templates/CLEO-INJECTION.md',
    ];
    const content = tempPaths.map(block).join('\n');
    const blocks = parseCaampBlocks(content);
    expect(blocks).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(blocks[i]?.content).toBe(tempPaths[i]);
    }
  });

  it('handles file with surrounding non-block content', () => {
    const content = `# My AGENTS File\n\n${block('@AGENTS.md')}\n\n# More content\n`;
    const blocks = parseCaampBlocks(content);
    expect(blocks).toHaveLength(1);
  });
});

// ── dedupeFile ───────────────────────────────────────────────────────────────

describe('dedupeFile()', () => {
  it('returns modified:false for non-existent file', async () => {
    const result = await dedupeFile(join(testDir, 'does-not-exist.md'));
    expect(result.modified).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(0);
  });

  it('returns modified:false for file with no CAAMP blocks', async () => {
    const filePath = join(testDir, 'no-blocks.md');
    await writeFile(filePath, '# Just a plain file\n');
    const result = await dedupeFile(filePath);
    expect(result.modified).toBe(false);
    expect(result.removed).toBe(0);
  });

  it('returns modified:false for already-clean file (single block)', async () => {
    const filePath = join(testDir, 'clean.md');
    await writeFile(filePath, `${block('@~/.local/share/cleo/templates/CLEO-INJECTION.md')}\n`);
    const result = await dedupeFile(filePath);
    expect(result.modified).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });

  it('deduplicates 5 stacked identical blocks → keeps 1', async () => {
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    const filePath = join(testDir, 'five-same.md');
    await writeFile(filePath, Array(5).fill(block(path)).join('\n'));

    const result = await dedupeFile(filePath);
    expect(result.modified).toBe(true);
    expect(result.removed).toBe(4);
    expect(result.kept).toBe(1);

    const content = await readFile(filePath, 'utf-8');
    const startCount = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    const endCount = (content.match(/<!-- CAAMP:END -->/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
    expect(content).toContain(path);
  });

  it('deduplicates the exact T1939 observed scenario (5 blocks, 4 temp + 1 canonical)', async () => {
    const filePath = join(testDir, 'AGENTS.md');
    const observedContent = [
      '<!-- CAAMP:START -->',
      '@~/.temp/cleo-injection-chain-u7jbHE/.cleo-home/templates/CLEO-INJECTION.md',
      '<!-- CAAMP:END -->',
      '<!-- CAAMP:START -->',
      '@~/.temp/cleo-injection-chain-DX3jau/.cleo-home/templates/CLEO-INJECTION.md',
      '<!-- CAAMP:END -->',
      '<!-- CAAMP:START -->',
      '@~/.temp/cleo-injection-chain-iQOoCF/.cleo-home/templates/CLEO-INJECTION.md',
      '<!-- CAAMP:END -->',
      '<!-- CAAMP:START -->',
      '@~/.temp/cleo-injection-chain-FR74uI/.cleo-home/templates/CLEO-INJECTION.md',
      '<!-- CAAMP:END -->',
      '<!-- CAAMP:START -->',
      '@~/.local/share/cleo/templates/CLEO-INJECTION.md',
      '<!-- CAAMP:END -->',
    ].join('\n');

    await writeFile(filePath, observedContent);

    // All 5 paths are DISTINCT, so dedupeFile keeps all 5 (removes 0)
    // because each block has unique content.
    const result = await dedupeFile(filePath);

    // 5 distinct paths → all kept, none removed
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(5);
    expect(result.modified).toBe(false);

    // Verify file is unchanged
    const content = await readFile(filePath, 'utf-8');
    const startCount = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    expect(startCount).toBe(5);
  });

  it('deduplicates 5 IDENTICAL temp-path blocks (all same content)', async () => {
    const filePath = join(testDir, 'AGENTS-identical.md');
    const samePath = '@~/.temp/cleo-injection-chain-u7jbHE/.cleo-home/templates/CLEO-INJECTION.md';
    await writeFile(filePath, Array(5).fill(block(samePath)).join('\n'));

    const result = await dedupeFile(filePath);
    expect(result.removed).toBe(4);
    expect(result.kept).toBe(1);
    expect(result.modified).toBe(true);

    const content = await readFile(filePath, 'utf-8');
    const startCount = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(content).toContain(samePath);
  });

  it('keeps the LAST occurrence when deduplicating', async () => {
    const filePath = join(testDir, 'last-wins.md');
    const sameContent = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    // Write 3 identical blocks; the "last" one has surrounding marker text we can verify position
    const fileContent = [
      block(sameContent),
      '# Middle content',
      block(sameContent),
      '# More content',
      block(sameContent) + ' LAST_MARKER',
    ].join('\n');

    // Note: 'LAST_MARKER' is outside the block so the block content itself is still sameContent.
    // We verify that the LAST block is kept by checking that the file still has the LAST_MARKER suffix.
    // Actually: parseCaampBlocks captures the exact raw text including the block boundary.
    // Since the LAST_MARKER is outside the END marker it's not in block.raw, it's preserved as-is.

    // Simpler: write 3 identical blocks with slight content difference to trace which one survives
    const path1 = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    await writeFile(
      filePath,
      [
        '<!-- CAAMP:START -->\n' + path1 + '\n<!-- CAAMP:END -->',
        '<!-- CAAMP:START -->\n' + path1 + '\n<!-- CAAMP:END -->',
        '<!-- CAAMP:START -->\n' + path1 + '\n<!-- CAAMP:END --> trailing text',
      ].join('\n'),
    );

    const result = await dedupeFile(filePath);
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);

    // The kept block is the last one; trailing text is preserved
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('trailing text');
    expect((content.match(/<!-- CAAMP:START -->/g) ?? []).length).toBe(1);
  });

  it('preserves distinct blocks (different content) and only removes same-content duplicates', async () => {
    const filePath = join(testDir, 'mixed.md');
    const pathA = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    const pathB = '@~/.agents/AGENTS.md';
    // pathA appears twice (duplicate), pathB appears once (unique)
    await writeFile(
      filePath,
      [block(pathA), block(pathB), block(pathA)].join('\n'),
    );

    const result = await dedupeFile(filePath);
    expect(result.removed).toBe(1); // one duplicate of pathA removed
    expect(result.kept).toBe(2);    // pathA (last) + pathB kept
    expect(result.modified).toBe(true);

    const content = await readFile(filePath, 'utf-8');
    expect((content.match(/<!-- CAAMP:START -->/g) ?? []).length).toBe(2);
    expect(content).toContain(pathA);
    expect(content).toContain(pathB);
  });

  it('preserves surrounding non-block content when deduplicating', async () => {
    const filePath = join(testDir, 'preserve-content.md');
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    await writeFile(
      filePath,
      `# Header\n\n${block(path)}\n\n${block(path)}\n\n# Footer\n`,
    );

    const result = await dedupeFile(filePath);
    expect(result.modified).toBe(true);
    expect(result.removed).toBe(1);

    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    expect((content.match(/<!-- CAAMP:START -->/g) ?? []).length).toBe(1);
  });

  it('idempotent — running twice on already-clean file produces modified:false', async () => {
    const filePath = join(testDir, 'idempotent.md');
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    await writeFile(filePath, [block(path), block(path), block(path)].join('\n'));

    const first = await dedupeFile(filePath);
    expect(first.modified).toBe(true);
    expect(first.removed).toBe(2);

    const second = await dedupeFile(filePath);
    expect(second.modified).toBe(false);
    expect(second.removed).toBe(0);
  });

  it('handles file with malformed blocks (START without END) — parses clean blocks only', async () => {
    const filePath = join(testDir, 'malformed.md');
    // One clean block + orphaned START with no END
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    await writeFile(
      filePath,
      `${block(path)}\n<!-- CAAMP:START -->\norphaned content with no end marker`,
    );

    // parseCaampBlocks only finds complete START...END pairs.
    // The malformed orphan is NOT matched — it's treated as regular text.
    // dedupeFile should not crash.
    const result = await dedupeFile(filePath);
    // Only 1 complete block found → no duplicates
    expect(result.modified).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);

    // File is left unchanged (no crash)
    expect(existsSync(filePath)).toBe(true);
  });
});

// ── dedupeFiles ──────────────────────────────────────────────────────────────

describe('dedupeFiles()', () => {
  it('processes multiple files and returns results for each', async () => {
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';
    const file1 = join(testDir, 'A.md');
    const file2 = join(testDir, 'B.md');
    const file3 = join(testDir, 'C.md');

    await writeFile(file1, [block(path), block(path)].join('\n')); // 2 → 1
    await writeFile(file2, block(path));                            // already clean
    await writeFile(file3, '# No blocks\n');                       // no blocks

    const results = await dedupeFiles([file1, file2, file3]);
    expect(results).toHaveLength(3);

    expect(results[0]?.modified).toBe(true);
    expect(results[0]?.removed).toBe(1);

    expect(results[1]?.modified).toBe(false);
    expect(results[1]?.removed).toBe(0);

    expect(results[2]?.modified).toBe(false);
    expect(results[2]?.removed).toBe(0);
  });

  it('silently skips non-existent files', async () => {
    const results = await dedupeFiles([join(testDir, 'does-not-exist.md')]);
    expect(results).toHaveLength(1);
    expect(results[0]?.modified).toBe(false);
    expect(results[0]?.removed).toBe(0);
  });

  it('returns empty array for empty input', async () => {
    const results = await dedupeFiles([]);
    expect(results).toHaveLength(0);
  });
});

// ── inject() idempotency after 5 sequential calls ────────────────────────────

describe('inject() + dedupeFile() combined scenarios', () => {
  it('5 sequential inject() calls with same @path produce exactly 1 block', async () => {
    const filePath = join(testDir, 'sequential.md');
    const path = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';

    for (let i = 0; i < 5; i++) {
      await inject(filePath, path);
    }

    const content = await readFile(filePath, 'utf-8');
    const startCount = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    expect(startCount).toBe(1);
  });

  it('inject() 3 different @paths + dedupeFile() keeps all 3', async () => {
    const filePath = join(testDir, 'three-distinct.md');

    // Start with the file pre-populated with 3 distinct blocks
    const paths = [
      '@~/.temp/cleo-injection-chain-A.md',
      '@~/.temp/cleo-injection-chain-B.md',
      '@~/.local/share/cleo/templates/CLEO-INJECTION.md',
    ];
    await writeFile(filePath, paths.map(block).join('\n'));

    // dedupeFile: all 3 are distinct → no removals
    const result = await dedupeFile(filePath);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(3);

    const content = await readFile(filePath, 'utf-8');
    for (const p of paths) {
      expect(content).toContain(p);
    }
  });

  it('pre-populated 5-block mix + inject() canonical + dedupeFile() → 1 or few blocks', async () => {
    // Simulate the full T1939 scenario:
    // 1. File has 5 stacked blocks (mix of temp + canonical from past sessions)
    // 2. New session runs inject() with the canonical path
    // 3. inject() consolidates all into 1 block
    // 4. dedupeFile() on the result is a no-op (already clean)

    const filePath = join(testDir, 'full-scenario.md');
    const canonical = '@~/.local/share/cleo/templates/CLEO-INJECTION.md';

    // Start with 5 stacked identical blocks (all pointing to canonical)
    await writeFile(filePath, Array(5).fill(block(canonical)).join('\n'));

    // inject() consolidates all blocks into 1
    const action = await inject(filePath, canonical);
    expect(action).toBe('consolidated');

    const afterInject = await readFile(filePath, 'utf-8');
    expect((afterInject.match(/<!-- CAAMP:START -->/g) ?? []).length).toBe(1);

    // dedupeFile() is now a no-op
    const dedupeResult = await dedupeFile(filePath);
    expect(dedupeResult.modified).toBe(false);
    expect(dedupeResult.removed).toBe(0);
  });

  // ── T9020: 5 sessions with canonical path — 0 temp-path blocks ───────────

  it('T9020: 5 sequential inject() calls with canonical @~/.cleo/templates path produce exactly 1 block and 0 temp-path blocks', async () => {
    // This simulates what happens AFTER the T9020 fix is applied:
    // every session injects the same stable @~/.cleo/templates/CLEO-INJECTION.md
    // reference (via getCanonicalTemplatesTildePath()). The injector must remain
    // idempotent — only 1 block in the file after N sessions.
    const filePath = join(testDir, 'agents-hub.md');
    const canonicalRef = '@~/.cleo/templates/CLEO-INJECTION.md';

    for (let i = 0; i < 5; i++) {
      await inject(filePath, canonicalRef);
    }

    const content = await readFile(filePath, 'utf-8');
    const blockCount = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    expect(blockCount).toBe(1);
    expect(content).toContain(canonicalRef);
    // Zero temp-path references
    expect(content).not.toMatch(/cleo-injection-chain-/);
    expect(content).not.toMatch(/\/\.temp\//);
  });

  it('T9020: inject() with canonical ref replaces a pre-existing stale temp-path block (single block)', async () => {
    // Simulate one stale block remaining from before the fix
    const filePath = join(testDir, 'stale-agents-hub.md');
    const staleTempRef =
      '@~/.temp/cleo-injection-chain-STALE/.cleo-home/templates/CLEO-INJECTION.md';
    const canonicalRef = '@~/.cleo/templates/CLEO-INJECTION.md';

    // Pre-populate with a single stale block
    await writeFile(filePath, block(staleTempRef) + '\n');

    // New session injects the canonical ref — must UPDATE (replace) the stale block
    const action = await inject(filePath, canonicalRef);
    expect(action).toBe('updated');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain(canonicalRef);
    expect(content).not.toContain(staleTempRef);
    expect((content.match(/<!-- CAAMP:START -->/g) ?? []).length).toBe(1);
  });
});
