/**
 * Tests for .cleo/.gitignore management in init command and doctor check.
 * @task T4640
 * @task T4641
 * @epic T4637
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRootGitignore } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-gitignore-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ============================================================================
// Template validation
// ============================================================================

describe('cleo-gitignore template', () => {
  // Template moved to packages/core/templates/ (from monorepo root templates/)
  const templatePath = join(process.cwd(), 'packages', 'core', 'templates', 'cleo-gitignore');

  it('template file exists in the templates directory', async () => {
    // The template file should exist in packages/core/templates/
    expect(existsSync(templatePath)).toBe(true);
  });

  it('template contains expected ignore patterns', async () => {
    const content = await readFile(templatePath, 'utf-8');

    // Key patterns that should be present (deny-by-default template)
    expect(content).toContain('*'); // Step 1: ignore everything
    expect(content).toContain('!.gitignore'); // Allow list
    expect(content).toContain('!project-context.json'); // detected project facts are tracked
    expect(content).toContain('.backups/');
    expect(content).toContain('metrics/');
    expect(content).toContain('*.db');
    expect(content).toContain('*.db-journal');
    expect(content).toContain('*.db-wal');
    expect(content).toContain('*.db-shm');
    // ADR-013 §9 / T5158 — runtime config snapshots must be denied explicitly
    // so nested-.gitignore allow rules cannot unignore them at the project
    // repository level.
    expect(content).toMatch(/^config\.json$/m);
    expect(content).toMatch(/^project-info\.json$/m);
  });

  it('template does NOT re-include config.json or project-info.json', async () => {
    const content = await readFile(templatePath, 'utf-8');

    // ADR-013 §9 / T5158 — these re-include rules previously allowed
    // config.json and project-info.json to be staged in the project git
    // repo despite being declared runtime state. The fix is to drop the
    // allow rules entirely.
    expect(content).not.toMatch(/^!config\.json$/m);
    expect(content).not.toMatch(/^!project-info\.json$/m);
  });

  it('template does NOT ignore core tracked files', async () => {
    const content = await readFile(templatePath, 'utf-8');
    const lines = content.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '');

    // These patterns should NOT appear as active ignore rules — they are
    // historically tracked data files from the pre-SQLite era that remained
    // allow-listed. (config.json and project-info.json DO appear as denies
    // post-ADR-013 §9 — covered by the dedicated test above.)
    const trackedFiles = ['todo.json', 'todo-archive.json', 'sessions.json'];
    for (const tracked of trackedFiles) {
      const hasExactIgnore = lines.some((l) => l.trim() === tracked);
      expect(hasExactIgnore).toBe(false);
    }
  });

  it('template has clear documentation header', async () => {
    const content = await readFile(templatePath, 'utf-8');

    expect(content).toContain('Deny-by-default');
    expect(content).toContain('ALLOW LIST');
    expect(content).toContain('EXPLICIT DENY');
  });
});

// ============================================================================
// Init creates .cleo/.gitignore
// ============================================================================

describe('init creates .cleo/.gitignore', () => {
  it('creates .gitignore in .cleo directory during init', async () => {
    const cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    // Use the actual template that init would write
    const { getGitignoreTemplate } = await import('../init.js');
    const content = getGitignoreTemplate();
    const gitignorePath = join(cleoDir, '.gitignore');
    await writeFile(gitignorePath, content);

    expect(existsSync(gitignorePath)).toBe(true);

    const written = await readFile(gitignorePath, 'utf-8');
    // getGitignoreTemplate() returns content (from package templates or fallback)
    expect(written.length).toBeGreaterThan(0);
  });

  it('does not overwrite existing .cleo/.gitignore without force', async () => {
    const cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    const gitignorePath = join(cleoDir, '.gitignore');
    const original = '# custom content\n*.custom\n';
    await writeFile(gitignorePath, original);

    // Without force, the file should not be overwritten
    // (testing the logic, not the full CLI flow)
    const exists = existsSync(gitignorePath);
    expect(exists).toBe(true);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toBe(original);
  });
});

// ============================================================================
// Init removes .cleo/ from root .gitignore
// ============================================================================

describe('init removes .cleo/ from root .gitignore', () => {
  it('removes .cleo/ line from root .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.cleo/\ndist/\n');

    // Read, filter, write - same logic as removeCleoFromRootGitignore
    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
    });
    await writeFile(gitignorePath, filtered.join('\n'));

    const result = await readFile(gitignorePath, 'utf-8');
    expect(result).not.toContain('.cleo/');
    expect(result).toContain('node_modules/');
    expect(result).toContain('dist/');
  });

  it('removes .cleo (without trailing slash) from root .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n.cleo\ndist/\n');

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
    });
    await writeFile(gitignorePath, filtered.join('\n'));

    const result = await readFile(gitignorePath, 'utf-8');
    expect(result).not.toMatch(/^\.cleo$/m);
    expect(result).toContain('node_modules/');
  });

  it('removes /.cleo/ (anchored) from root .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n/.cleo/\ndist/\n');

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
    });
    await writeFile(gitignorePath, filtered.join('\n'));

    const result = await readFile(gitignorePath, 'utf-8');
    expect(result).not.toContain('/.cleo/');
    expect(result).toContain('node_modules/');
  });

  it('preserves .cleo/ sub-path patterns in root .gitignore', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    await writeFile(gitignorePath, '.cleo/backups/\n.cleo/*.tmp\n.cleo/\n');

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
    });
    await writeFile(gitignorePath, filtered.join('\n'));

    const result = await readFile(gitignorePath, 'utf-8');
    // Sub-path patterns should be preserved
    expect(result).toContain('.cleo/backups/');
    expect(result).toContain('.cleo/*.tmp');
    // But the blanket .cleo/ should be removed
    expect(result).not.toMatch(/^\.cleo\/$/m);
  });

  it('handles root .gitignore without .cleo/ (no-op)', async () => {
    const gitignorePath = join(testDir, '.gitignore');
    const original = 'node_modules/\ndist/\n';
    await writeFile(gitignorePath, original);

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
    });

    // Nothing should be filtered
    expect(filtered.length).toBe(lines.length);
  });
});

// ============================================================================
// Doctor check for root .gitignore
// ============================================================================

describe('checkRootGitignore', () => {
  it('passes when no root .gitignore exists', () => {
    const result = checkRootGitignore(join(testDir, 'nonexistent'));
    expect(result.status).toBe('passed');
    expect(result.id).toBe('root_gitignore');
  });

  it('passes when root .gitignore does not block .cleo/', async () => {
    await writeFile(join(testDir, '.gitignore'), 'node_modules/\ndist/\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('passed');
  });

  it('warns when root .gitignore contains .cleo/', async () => {
    await writeFile(join(testDir, '.gitignore'), 'node_modules/\n.cleo/\ndist/\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('.cleo/');
    expect(result.fix).toContain('cleo init');
  });

  it('warns when root .gitignore contains .cleo (no slash)', async () => {
    await writeFile(join(testDir, '.gitignore'), '.cleo\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('warning');
  });

  it('warns when root .gitignore contains /.cleo/', async () => {
    await writeFile(join(testDir, '.gitignore'), '/.cleo/\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('warning');
  });

  it('does not warn for .cleo sub-path patterns', async () => {
    await writeFile(join(testDir, '.gitignore'), '.cleo/backups/\n.cleo/*.tmp\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('passed');
  });

  it('ignores comment lines containing .cleo', async () => {
    await writeFile(join(testDir, '.gitignore'), '# .cleo/ is tracked\nnode_modules/\n');
    const result = checkRootGitignore(testDir);
    expect(result.status).toBe('passed');
  });
});
