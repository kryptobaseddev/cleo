/**
 * Tests for sharing module (config-driven .cleo/ commit allowlist).
 * @task T4883
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchesPattern, syncGitignore, getSharingStatus } from '../sharing/index.js';

describe('sharing', () => {
  describe('matchesPattern', () => {
    it('matches exact file names', () => {
      expect(matchesPattern('config.json', 'config.json')).toBe(true);
      expect(matchesPattern('config.json', 'other.json')).toBe(false);
    });

    it('matches directory globs with **', () => {
      expect(matchesPattern('adrs/ADR-001.md', 'adrs/**')).toBe(true);
      expect(matchesPattern('adrs/sub/file.md', 'adrs/**')).toBe(true);
      expect(matchesPattern('adrs', 'adrs/**')).toBe(true);
      expect(matchesPattern('other/file.md', 'adrs/**')).toBe(false);
    });

    it('matches wildcard patterns with *', () => {
      expect(matchesPattern('audit-log-123.json', 'audit-log*.json')).toBe(true);
      expect(matchesPattern('audit-log.json', 'audit-log*.json')).toBe(true);
      expect(matchesPattern('other-log.json', 'audit-log*.json')).toBe(false);
    });

    it('matches .fuse_hidden* pattern', () => {
      expect(matchesPattern('.fuse_hidden0000445200000004', '.fuse_hidden*')).toBe(true);
      expect(matchesPattern('.fuse_hidden', '.fuse_hidden*')).toBe(true);
    });

    it('handles leading/trailing slashes', () => {
      expect(matchesPattern('/config.json', 'config.json')).toBe(true);
      expect(matchesPattern('config.json/', 'config.json')).toBe(true);
    });
  });

  describe('syncGitignore', () => {
    let tempDir: string;
    const origDir = process.env['CLEO_DIR'];
    const origRoot = process.env['CLEO_ROOT'];
    const origHome = process.env['CLEO_HOME'];

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cleo-sharing-test-'));
      const cleoDir = join(tempDir, '.cleo');
      await mkdir(cleoDir, { recursive: true });

      // Write minimal config with sharing mode
      await writeFile(
        join(cleoDir, 'config.json'),
        JSON.stringify({
          version: '2.10.0',
          sharing: {
            mode: 'project',
            commitAllowlist: ['config.json', 'adrs/**'],
            denylist: ['tasks.db'],
          },
        }),
      );

      process.env['CLEO_DIR'] = cleoDir;
      process.env['CLEO_ROOT'] = tempDir;
      process.env['CLEO_HOME'] = join(tempDir, 'global');
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
      if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
      else delete process.env['CLEO_DIR'];
      if (origRoot !== undefined) process.env['CLEO_ROOT'] = origRoot;
      else delete process.env['CLEO_ROOT'];
      if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
      else delete process.env['CLEO_HOME'];
    });

    it('creates .gitignore with managed section when none exists', async () => {
      const result = await syncGitignore(tempDir);
      expect(result.updated).toBe(true);
      expect(result.entriesCount).toBeGreaterThan(0);

      const content = await readFile(join(tempDir, '.gitignore'), 'utf-8');
      expect(content).toContain('CLEO:SHARING:START');
      expect(content).toContain('CLEO:SHARING:END');
      expect(content).toContain('.cleo/');
      expect(content).toContain('!.cleo/config.json');
      expect(content).toContain('!.cleo/adrs/**');
    });

    it('updates existing .gitignore managed section', async () => {
      // Write initial .gitignore with existing content
      await writeFile(join(tempDir, '.gitignore'), 'node_modules/\n');

      const result = await syncGitignore(tempDir);
      expect(result.updated).toBe(true);

      const content = await readFile(join(tempDir, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('CLEO:SHARING:START');
    });
  });

  describe('getSharingStatus', () => {
    let tempDir: string;
    const origDir = process.env['CLEO_DIR'];
    const origRoot = process.env['CLEO_ROOT'];
    const origHome = process.env['CLEO_HOME'];

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'cleo-status-test-'));
      const cleoDir = join(tempDir, '.cleo');
      await mkdir(join(cleoDir, 'adrs'), { recursive: true });

      await writeFile(
        join(cleoDir, 'config.json'),
        JSON.stringify({
          version: '2.10.0',
          sharing: {
            mode: 'project',
            commitAllowlist: ['config.json', 'adrs/**'],
            denylist: ['tasks.db'],
          },
        }),
      );
      await writeFile(join(cleoDir, 'tasks.db'), 'binary data');
      await writeFile(join(cleoDir, 'adrs', 'ADR-001.md'), '# ADR');

      process.env['CLEO_DIR'] = cleoDir;
      process.env['CLEO_ROOT'] = tempDir;
      process.env['CLEO_HOME'] = join(tempDir, 'global');
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
      if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
      else delete process.env['CLEO_DIR'];
      if (origRoot !== undefined) process.env['CLEO_ROOT'] = origRoot;
      else delete process.env['CLEO_ROOT'];
      if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
      else delete process.env['CLEO_HOME'];
    });

    it('classifies files as tracked or ignored based on config', async () => {
      const status = await getSharingStatus(tempDir);

      expect(status.mode).toBe('project');
      expect(status.tracked).toContain('config.json');
      expect(status.tracked).toContain('adrs/ADR-001.md');
      expect(status.ignored).toContain('tasks.db');
    });
  });
});
