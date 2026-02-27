/**
 * Tests for docs-sync validation (documentation drift detection).
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getScriptCommands,
  getIndexScripts,
  getIndexCommands,
  checkCommandsSync,
  checkWrapperSync,
  detectDrift,
  shouldRunDriftDetection,
} from '../docs-sync.js';

// ============================================================================
// Test helpers
// ============================================================================

function makeRoot(): string {
  const root = join(tmpdir(), `cleo-docs-sync-test-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function makeScriptsDir(root: string, scripts: string[]): string {
  const dir = join(root, 'scripts');
  mkdirSync(dir, { recursive: true });
  for (const name of scripts) {
    writeFileSync(join(dir, `${name}.sh`), `#!/bin/bash\necho ${name}\n`);
  }
  return dir;
}

function makeCommandsIndex(root: string, commands: Array<{ name: string; script?: string; aliasFor?: string | null; note?: string | null }>): string {
  const indexPath = join(root, 'docs', 'commands', 'COMMANDS-INDEX.json');
  mkdirSync(join(root, 'docs', 'commands'), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ commands }, null, 2));
  return indexPath;
}

// ============================================================================
// getScriptCommands
// ============================================================================

describe('getScriptCommands', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns sorted list of script names without .sh extension', () => {
    makeScriptsDir(root, ['zebra', 'add', 'list']);
    const cmds = getScriptCommands(join(root, 'scripts'));
    expect(cmds).toEqual(['add', 'list', 'zebra']);
  });

  it('returns empty array for non-existent directory', () => {
    const cmds = getScriptCommands(join(root, 'nonexistent'));
    expect(cmds).toEqual([]);
  });

  it('ignores non-.sh files', () => {
    const dir = join(root, 'scripts');
    mkdirSync(dir);
    writeFileSync(join(dir, 'add.sh'), '#!/bin/bash');
    writeFileSync(join(dir, 'README.md'), '# docs');
    writeFileSync(join(dir, 'config.json'), '{}');
    const cmds = getScriptCommands(dir);
    expect(cmds).toEqual(['add']);
  });

  it('returns empty array for empty directory', () => {
    mkdirSync(join(root, 'scripts'));
    const cmds = getScriptCommands(join(root, 'scripts'));
    expect(cmds).toEqual([]);
  });
});

// ============================================================================
// getIndexScripts
// ============================================================================

describe('getIndexScripts', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('extracts script names from index', () => {
    const indexPath = makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
      { name: 'list', script: 'list.sh' },
    ]);
    const scripts = getIndexScripts(indexPath);
    expect(scripts).toContain('add');
    expect(scripts).toContain('list');
  });

  it('returns empty array for missing file', () => {
    const scripts = getIndexScripts(join(root, 'missing.json'));
    expect(scripts).toEqual([]);
  });

  it('handles entries without script field', () => {
    const indexPath = makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
      { name: 'alias-cmd', aliasFor: 'add' },
    ]);
    const scripts = getIndexScripts(indexPath);
    expect(scripts).toContain('add');
    // aliasFor entry has no script field - should be filtered
    expect(scripts).not.toContain('alias-cmd');
  });

  it('returns empty array for invalid JSON', () => {
    const badPath = join(root, 'bad.json');
    writeFileSync(badPath, 'NOT JSON');
    expect(getIndexScripts(badPath)).toEqual([]);
  });
});

// ============================================================================
// getIndexCommands
// ============================================================================

describe('getIndexCommands', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns command names sorted', () => {
    const indexPath = makeCommandsIndex(root, [
      { name: 'zebra' },
      { name: 'add' },
      { name: 'list' },
    ]);
    const cmds = getIndexCommands(indexPath);
    expect(cmds).toEqual(['add', 'list', 'zebra']);
  });

  it('returns empty for missing file', () => {
    expect(getIndexCommands(join(root, 'missing.json'))).toEqual([]);
  });
});

// ============================================================================
// checkCommandsSync
// ============================================================================

describe('checkCommandsSync', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns no issues when scripts and index are in sync', () => {
    makeScriptsDir(root, ['add', 'list', 'find']);
    const indexPath = makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
      { name: 'list', script: 'list.sh' },
      { name: 'find', script: 'find.sh' },
    ]);
    const issues = checkCommandsSync(join(root, 'scripts'), indexPath);
    expect(issues).toHaveLength(0);
  });

  it('reports script missing from index as error', () => {
    makeScriptsDir(root, ['add', 'orphaned-script']);
    const indexPath = makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
    ]);
    const issues = checkCommandsSync(join(root, 'scripts'), indexPath);
    const missingFromIndex = issues.filter(i => i.type === 'missing_from_index');
    expect(missingFromIndex).toHaveLength(1);
    expect(missingFromIndex[0].item).toBe('orphaned-script.sh');
    expect(missingFromIndex[0].severity).toBe('error');
  });

  it('reports orphaned index entry (no script file) as error', () => {
    makeScriptsDir(root, ['add']);
    const indexPath = makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
      { name: 'ghost', script: 'ghost.sh' },
    ]);
    const issues = checkCommandsSync(join(root, 'scripts'), indexPath);
    const orphaned = issues.filter(i => i.type === 'orphaned_index');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].item).toBe('ghost.sh');
    expect(orphaned[0].severity).toBe('error');
  });

  it('handles non-existent scripts directory gracefully', () => {
    const indexPath = makeCommandsIndex(root, [{ name: 'add', script: 'add.sh' }]);
    const issues = checkCommandsSync(join(root, 'nonexistent'), indexPath);
    // Should report orphaned entries for all index scripts
    expect(issues.every(i => i.type === 'orphaned_index')).toBe(true);
  });
});

// ============================================================================
// shouldRunDriftDetection
// ============================================================================

describe('shouldRunDriftDetection', () => {
  it('returns false when disabled', () => {
    expect(shouldRunDriftDetection(false, true)).toBe(false);
  });

  it('returns false when autoCheck is false', () => {
    expect(shouldRunDriftDetection(true, false)).toBe(false);
  });

  it('returns true when enabled and autoCheck on, no command filter', () => {
    expect(shouldRunDriftDetection(true, true)).toBe(true);
  });

  it('returns true when command matches criticalCommands', () => {
    expect(shouldRunDriftDetection(true, true, 'add', ['add', 'list'])).toBe(true);
  });

  it('returns false when command not in criticalCommands', () => {
    expect(shouldRunDriftDetection(true, true, 'show', ['add', 'list'])).toBe(false);
  });

  it('returns true when command provided but no criticalCommands list', () => {
    expect(shouldRunDriftDetection(true, true, 'show', [])).toBe(true);
  });
});

// ============================================================================
// detectDrift
// ============================================================================

describe('detectDrift', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns exitCode 0 with no issues when scripts and index match', () => {
    makeScriptsDir(root, ['add', 'list']);
    makeCommandsIndex(root, [
      { name: 'add', script: 'add.sh' },
      { name: 'list', script: 'list.sh' },
    ]);
    const report = detectDrift('full', root);
    expect(report.exitCode).toBe(0);
    expect(report.mode).toBe('full');
  });

  it('returns exitCode 2 when there are errors', () => {
    makeScriptsDir(root, ['add', 'unlisted']);
    makeCommandsIndex(root, [{ name: 'add', script: 'add.sh' }]);
    const report = detectDrift('quick', root);
    expect(report.exitCode).toBe(2);
    expect(report.issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('returns mode in report', () => {
    const report = detectDrift('quick', root);
    expect(report.mode).toBe('quick');
  });

  it('handles missing scripts dir gracefully', () => {
    // No scripts dir and no index - should return empty or warnings only
    const report = detectDrift('quick', root);
    expect(report).toBeDefined();
    expect(Array.isArray(report.issues)).toBe(true);
  });
});
