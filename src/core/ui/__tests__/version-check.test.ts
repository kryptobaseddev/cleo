/**
 * Tests for version check (version-check.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkProjectNeedsUpdate } from '../version-check.js';

// Mock store/json
vi.mock('../../../store/json.js', () => ({
  readJson: vi.fn(),
}));

// Mock fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import { readJson } from '../../../store/json.js';
import { existsSync, readFileSync } from 'node:fs';

describe('checkProjectNeedsUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return no warnings if not a cleo project', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await checkProjectNeedsUpdate('/tmp/not-a-project');
    expect(result.needsUpdate).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('should warn if schemaVersion is missing', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes('todo.json')) return true;
      return false;
    });
    vi.mocked(readJson).mockResolvedValue({
      _meta: {},
      tasks: [],
    });

    const result = await checkProjectNeedsUpdate('/tmp/test-project');
    expect(result.needsUpdate).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining('Missing ._meta.schemaVersion'),
    );
  });

  it('should warn about legacy structure', async () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p).includes('todo.json')) return true;
      return false;
    });
    vi.mocked(readJson).mockResolvedValue({
      _meta: { schemaVersion: '2.5.0' },
      phases: {}, // legacy top-level phases
      tasks: [],
    });

    const result = await checkProjectNeedsUpdate('/tmp/test-project');
    expect(result.needsUpdate).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining('legacy structure'),
    );
  });
});
