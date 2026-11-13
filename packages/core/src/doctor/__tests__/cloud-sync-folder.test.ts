/**
 * T14549 AC5 — warn (never block) when the project root is inside a
 * cloud-synced folder, detected from local filesystem signals under an
 * injected HOME.
 *
 * @task T14549
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemHealth } from '../../system/health.js';
import {
  checkCloudSyncedProject,
  detectCloudSyncedFolder,
  isPathWithin,
  scanCloudSyncedFolder,
} from '../cloud-sync-folder.js';

let home: string;

/** Create `path` under the fake home and return it. */
function dir(...parts: string[]): string {
  const path = join(home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-t14549-home-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('T14549: cloud-synced project folders', () => {
  it('detects macOS iCloud Desktop & Documents sync of ~/Documents and warns about WAL files', () => {
    const project = dir('Documents', 'code', 'app');
    const cloudDocs = dir('Library', 'Mobile Documents', 'com~apple~CloudDocs');
    symlinkSync(join(home, 'Documents'), join(cloudDocs, 'Documents'));

    const found = detectCloudSyncedFolder(project, { home, env: {} });
    expect(found?.provider).toBe('iCloud Drive (Desktop & Documents)');

    const check = checkCloudSyncedProject(project, { home, env: {} });
    expect(check.status).toBe('warning');
    expect(check.message).toContain('SQLite WAL');
    expect(check.message).toContain('Move the project');
  });

  it('does not flag ~/Documents when Desktop & Documents sync is off', () => {
    const project = dir('Documents', 'code', 'app');
    dir('Library', 'Mobile Documents', 'com~apple~CloudDocs');
    expect(detectCloudSyncedFolder(project, { home, env: {} })).toBeNull();
    expect(checkCloudSyncedProject(project, { home, env: {} }).status).toBe('passed');
  });

  it('does not flag ~/Documents when sync is off but iCloud kept a Documents directory', () => {
    // Apple support 109344: turning the feature off keeps the cloud copy in
    // iCloud Drive and creates a fresh, unsynced local ~/Documents.
    const project = dir('Documents', 'code', 'app');
    dir('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents', 'old-files');
    dir('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop');
    expect(detectCloudSyncedFolder(project, { home, env: {} })).toBeNull();
    expect(checkCloudSyncedProject(project, { home, env: {} }).status).toBe('passed');
  });

  it('does not flag ~/Documents when the iCloud link points somewhere else', () => {
    const project = dir('Documents', 'code', 'app');
    const cloudDocs = dir('Library', 'Mobile Documents', 'com~apple~CloudDocs');
    symlinkSync(dir('elsewhere'), join(cloudDocs, 'Documents'));
    expect(detectCloudSyncedFolder(project, { home, env: {} })).toBeNull();
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'degrades to info, never throws, when a signal is unreadable (EACCES)',
    () => {
      const project = dir('Documents', 'code', 'app');
      const cloudDocs = dir('Library', 'Mobile Documents', 'com~apple~CloudDocs');
      const cloudStorage = dir('Library', 'CloudStorage');
      chmodSync(cloudDocs, 0o000);
      chmodSync(cloudStorage, 0o000);
      try {
        const scan = scanCloudSyncedFolder(project, { home, env: {} });
        expect(scan.found).toBeNull();
        expect(scan.unreadable.length).toBeGreaterThan(0);
        const check = checkCloudSyncedProject(project, { home, env: {} });
        expect(check.status).toBe('info');
        expect(check.message).toContain('could not read');
      } finally {
        chmodSync(cloudDocs, 0o755);
        chmodSync(cloudStorage, 0o755);
      }
    },
  );

  it('compares Windows paths by drive and segment, case-insensitively', () => {
    const dropbox = 'C:\\Users\\me\\Dropbox';
    expect(isPathWithin(dropbox, 'D:\\projects\\app', path.win32)).toBe(false);
    expect(isPathWithin(dropbox, 'D:\\Users\\me\\Dropbox\\app', path.win32)).toBe(false);
    expect(isPathWithin(dropbox, 'c:\\users\\ME\\dropbox\\app', path.win32)).toBe(true);
    expect(isPathWithin(dropbox, 'C:\\Users\\me\\Dropbox2\\app', path.win32)).toBe(false);
    expect(isPathWithin('/home/me/Dropbox', '/home/me/Dropbox2/app', path.posix)).toBe(false);
    expect(isPathWithin('/home/me/Dropbox', '/home/me/Dropbox/app', path.posix)).toBe(true);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'plain cleo doctor surfaces an incomplete cloud check as info, never as passing',
    async () => {
      const project = dir('projects', 'app');
      const cloudStorage = dir('Library', 'CloudStorage');
      chmodSync(cloudStorage, 0o000);
      vi.stubEnv('HOME', home);
      try {
        const health = await getSystemHealth(project);
        const cloud = health.checks.find((c) => c.name === 'cloud_synced_project');
        expect(cloud?.status).toBe('info');
        expect(cloud?.message).toContain('could not read');
      } finally {
        vi.unstubAllEnvs();
        chmodSync(cloudStorage, 0o755);
      }
    },
  );

  it.each([
    [
      'Google Drive (File Provider)',
      ['Library', 'CloudStorage', 'GoogleDrive-me@example.com'],
      'Google Drive',
    ],
    ['OneDrive (File Provider)', ['Library', 'CloudStorage', 'OneDrive-Personal'], 'OneDrive'],
    ['Dropbox (File Provider)', ['Library', 'CloudStorage', 'Dropbox'], 'Dropbox'],
    ['iCloud Drive', ['Library', 'Mobile Documents', 'com~apple~CloudDocs'], 'iCloud Drive'],
    ['Dropbox (home folder)', ['Dropbox'], 'Dropbox'],
    ['OneDrive (home folder)', ['OneDrive - Contoso'], 'OneDrive'],
    ['Google Drive (home folder)', ['Google Drive'], 'Google Drive'],
  ])('detects %s', (_label, parts, provider) => {
    const project = dir(...parts, 'proj');
    expect(detectCloudSyncedFolder(project, { home, env: {} })?.provider).toBe(provider);
  });

  it('detects the folder the OneDrive environment variable names', () => {
    const synced = dir('elsewhere', 'od');
    const project = dir('elsewhere', 'od', 'proj');
    expect(detectCloudSyncedFolder(project, { home, env: { OneDrive: synced } })?.provider).toBe(
      'OneDrive',
    );
  });

  it('passes a project outside every synced folder', () => {
    dir('Dropbox');
    const project = dir('projects', 'app');
    expect(checkCloudSyncedProject(project, { home, env: {} }).status).toBe('passed');
  });
});
