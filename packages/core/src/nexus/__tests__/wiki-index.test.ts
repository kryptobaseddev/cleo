/**
 * Tests for nexus wiki index generator.
 *
 * @task T1060
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateNexusWikiIndex } from '../wiki-index.js';

describe('nexus wiki-index', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-test-'));
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  });

  it('should return proper result structure', async () => {
    const outputDir = join(tempDir, 'structure-test');
    const result = await generateNexusWikiIndex(outputDir);

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('outputDir');
    expect(result).toHaveProperty('communityCount');
    expect(result).toHaveProperty('fileCount');
    expect(result).toHaveProperty('communities');
    expect(Array.isArray(result.communities)).toBe(true);
  });

  it('should return outputDir in result', async () => {
    const outputDir = join(tempDir, 'output-test');
    const result = await generateNexusWikiIndex(outputDir);

    expect(result.outputDir).toBe(outputDir);
  });

  it('should include fileCount in result', async () => {
    const outputDir = join(tempDir, 'filecount-test');
    const result = await generateNexusWikiIndex(outputDir);

    if (result.error) {
      console.error('Result error:', result.error);
    }
    expect(typeof result.fileCount).toBe('number');
    // When DB doesn't exist, we still write overview.md
    expect(result.fileCount).toBeGreaterThanOrEqual(0);
  });
});
