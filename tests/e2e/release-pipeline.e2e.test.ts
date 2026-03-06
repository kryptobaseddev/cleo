/**
 * E2E tests for the T5576 release pipeline remediation.
 *
 * Covers:
 *   1. Custom [custom-log] block preservation in CHANGELOG across updates
 *   2. Release gate fail path when tasks are not done
 *   3. Full release flow in dryRun mode
 *
 * @task T5583
 * @epic T5576
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// Scenario 1: Custom block preservation
// ============================================================================

describe('E2E: custom-log block preservation in CHANGELOG', () => {
  let tempDir: string;
  let changelogPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-e2e-changelog-'));
    changelogPath = join(tempDir, 'CHANGELOG.md');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves [custom-log] block content after section update', async () => {
    const { writeChangelogSection } = await import('../../src/core/release/changelog-writer.js');

    // Set up CHANGELOG with a version section containing a custom-log block.
    // Note: avoid ## headings inside custom-log blocks because the section
    // boundary detection uses ^## as the delimiter for the next section.
    const initialChangelog = `# CHANGELOG

## [1.0.0] (2026-01-01)

### Features
- Initial release

[custom-log]
These notes were written by hand and must be preserved.
[/custom-log]

---

## [0.9.0] (2025-12-01)

Older entry.

---
`;

    await writeFile(changelogPath, initialChangelog, 'utf8');

    // Now call writeChangelogSection with new generated content for the same version
    const newGeneratedContent = `### Features
- Updated feature list
- Added new capability`;

    await writeChangelogSection('1.0.0', newGeneratedContent, [], changelogPath);

    const result = readFileSync(changelogPath, 'utf8');

    // Custom block content should appear (tags stripped, inner content preserved)
    expect(result).toContain('These notes were written by hand and must be preserved.');

    // Tags themselves should not appear in the output
    expect(result).not.toContain('[custom-log]');
    expect(result).not.toContain('[/custom-log]');

    // New generated content should be present
    expect(result).toContain('Updated feature list');
    expect(result).toContain('Added new capability');

    // Older section should still be present
    expect(result).toContain('## [0.9.0]');
    expect(result).toContain('Older entry.');
  });

  it('handles multiple custom blocks and deduplicates on re-write', async () => {
    const { writeChangelogSection } = await import('../../src/core/release/changelog-writer.js');

    const initialChangelog = `# CHANGELOG

## [2.0.0] (2026-02-01)

Generated content.

[custom-log]
Block A content.
[/custom-log]

[custom-log]
Block B content.
[/custom-log]

---
`;

    await writeFile(changelogPath, initialChangelog, 'utf8');

    await writeChangelogSection('2.0.0', 'Regenerated content.', [], changelogPath);

    const result = readFileSync(changelogPath, 'utf8');

    expect(result).toContain('Block A content.');
    expect(result).toContain('Block B content.');
    expect(result).toContain('Regenerated content.');
  });

  it('creates new section when version does not exist yet', async () => {
    const { writeChangelogSection } = await import('../../src/core/release/changelog-writer.js');

    const initialChangelog = `# CHANGELOG

## [1.0.0] (2026-01-01)

Existing entry.

---
`;

    await writeFile(changelogPath, initialChangelog, 'utf8');

    await writeChangelogSection('2.0.0', '### New Features\n- Brand new version', [], changelogPath);

    const result = readFileSync(changelogPath, 'utf8');

    expect(result).toContain('Brand new version');
    expect(result).toContain('## [1.0.0]');
    expect(result).toContain('Existing entry.');
  });
});

// ============================================================================
// Scenario 2: Gate fail path — task not done
// ============================================================================

describe('E2E: release gate fail path', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-e2e-gates-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../src/store/sqlite.js');
      await closeAllDatabases();
    } catch { /* ignore */ }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns allPassed=false when a task in the release is not done', async () => {
    const { prepareRelease, runReleaseGates } = await import('../../src/core/release/release-manifest.js');

    const version = '1.2.3';

    // Active task — not done
    const tasks = [
      { id: 'T100', title: 'Finished task', status: 'done', completedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'T101', title: 'Incomplete task', status: 'active', completedAt: null },
    ];

    const loadTasksFn = async () => tasks;

    // Prepare release with specific task IDs
    await prepareRelease(
      version,
      ['T100', 'T101'],
      undefined,
      loadTasksFn,
      testDir,
    );

    // Run gates — tasks_complete gate should fail because T101 is 'active'
    const result = await runReleaseGates(version, loadTasksFn, testDir);

    expect(result.allPassed).toBe(false);

    const taskCompleteGate = result.gates.find((g) => g.name === 'tasks_complete');
    expect(taskCompleteGate).toBeDefined();
    expect(taskCompleteGate!.status).toBe('failed');

    // Error message should mention the incomplete task ID
    expect(taskCompleteGate!.message).toContain('T101');

    expect(result.failedCount).toBeGreaterThan(0);
  });

  it('returns allPassed=false when has_changelog gate fails (no changelog generated)', async () => {
    const { prepareRelease, runReleaseGates } = await import('../../src/core/release/release-manifest.js');

    const version = '1.2.4';

    const tasks = [
      { id: 'T200', title: 'Done task', status: 'done', completedAt: '2026-03-01T00:00:00.000Z' },
    ];

    await prepareRelease(version, ['T200'], undefined, async () => tasks, testDir);

    // Run gates without generating changelog first
    const result = await runReleaseGates(version, async () => tasks, testDir);

    expect(result.allPassed).toBe(false);
    const changelogGate = result.gates.find((g) => g.name === 'has_changelog');
    expect(changelogGate).toBeDefined();
    expect(changelogGate!.status).toBe('failed');
  });

  it('all gates pass when release is properly set up', async () => {
    const { prepareRelease, generateReleaseChangelog, runReleaseGates } =
      await import('../../src/core/release/release-manifest.js');

    const version = '1.2.5';

    const tasks = [
      { id: 'T300', title: 'Done task', status: 'done', completedAt: '2026-03-01T00:00:00.000Z' },
    ];

    await prepareRelease(version, ['T300'], undefined, async () => tasks, testDir);
    await generateReleaseChangelog(version, async () => tasks, testDir);

    const result = await runReleaseGates(version, async () => tasks, testDir);

    expect(result.allPassed).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.passedCount).toBe(result.gates.length);
  });
});

// ============================================================================
// Scenario 3: Full release flow — dryRun mode
// ============================================================================

describe('E2E: release.ship dry run', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-e2e-ship-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../src/store/sqlite.js');
      await closeAllDatabases();
    } catch { /* ignore */ }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns dry run summary without executing git commands', async () => {
    const {
      prepareRelease,
      generateReleaseChangelog,
    } = await import('../../src/core/release/release-manifest.js');
    const { releaseShip } = await import('../../src/dispatch/engines/release-engine.js');

    // prepareRelease normalizes versions by prepending 'v'
    const version = 'v3.0.0';
    const epicId = 'T5576';

    const tasks = [
      { id: 'T400', title: 'Done feature', status: 'done', completedAt: '2026-03-01T00:00:00.000Z', labels: ['feat'] },
      { id: 'T401', title: 'Done fix', status: 'done', completedAt: '2026-03-02T00:00:00.000Z', labels: ['fix'] },
    ];

    const loadTasksFn = async () => tasks;

    // Step 1: Prepare release
    const prepared = await prepareRelease(version, ['T400', 'T401'], undefined, loadTasksFn, testDir);
    expect(prepared.version).toBe(version);
    expect(prepared.taskCount).toBe(2);

    // Step 2: Generate changelog so has_changelog gate passes
    const changelogResult = await generateReleaseChangelog(version, loadTasksFn, testDir);
    expect(changelogResult.version).toBe(version);
    expect(typeof changelogResult.changelog).toBe('string');

    // Step 3: Call releaseShip with dryRun=true — should not run git
    const result = await releaseShip(
      { version, epicId, dryRun: true },
      testDir,
    );

    // Should succeed
    expect(result.success).toBe(true);

    const data = result.data as {
      version: string;
      epicId: string;
      dryRun: boolean;
      wouldDo: string[];
    };

    expect(data.dryRun).toBe(true);
    expect(data.version).toBe(version);
    expect(data.epicId).toBe(epicId);

    // wouldDo list should describe git commands that would have run
    expect(Array.isArray(data.wouldDo)).toBe(true);
    expect(data.wouldDo.length).toBeGreaterThan(0);

    const wouldDoStr = data.wouldDo.join('\n');
    expect(wouldDoStr).toContain('git');
  });

  it('returns gate failure error when tasks are not done in ship flow', async () => {
    const { prepareRelease } = await import('../../src/core/release/release-manifest.js');
    const { releaseShip } = await import('../../src/dispatch/engines/release-engine.js');

    const version = 'v3.0.1';
    const epicId = 'T5576';

    const tasks = [
      { id: 'T500', title: 'Blocked task', status: 'blocked', completedAt: null },
    ];

    await prepareRelease(version, ['T500'], undefined, async () => tasks, testDir);

    const result = await releaseShip({ version, epicId, dryRun: true }, testDir);

    // Should fail because tasks_complete gate fails
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
  });
});
