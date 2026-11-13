/**
 * Legacy config key migration: orchestrator.contextThresholds -> orchestrate (T14375).
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawConfigValue, loadConfig, setConfigValue } from '../../config.js';
import { createUpgradeFileJournal } from '../../scaffold/upgrade-file-journal.js';
import { getThresholds } from '../../skills/orchestrator/startup.js';
import { resolveHierarchyPolicy } from '../../tasks/hierarchy-policy.js';
import {
  configLegacyKeyDeprecations,
  migrateHierarchyDefaults,
  migrateLegacyConfigFile,
  migrateLegacyConfigKeys,
  resolveLegacyConfigKey,
} from '../legacy-keys.js';

describe('migrateLegacyConfigKeys', () => {
  it('moves orchestrator.contextThresholds under orchestrate and drops the old key', () => {
    const cfg: Record<string, unknown> = {
      orchestrate: { leadWorker: { v1: true } },
      orchestrator: { contextThresholds: { warning: 60, critical: 75 } },
    };
    expect(migrateLegacyConfigKeys(cfg)).toEqual(['orchestrator.contextThresholds']);
    expect(cfg).toEqual({
      orchestrate: { leadWorker: { v1: true }, contextThresholds: { warning: 60, critical: 75 } },
    });
    expect(migrateLegacyConfigKeys(cfg)).toEqual([]);
  });

  it('keeps an existing orchestrate.contextThresholds and leaves unknown legacy keys', () => {
    const cfg: Record<string, unknown> = {
      orchestrate: { contextThresholds: { warning: 65, critical: 85 } },
      orchestrator: { contextThresholds: { warning: 60, critical: 75 }, other: 1 },
    };
    migrateLegacyConfigKeys(cfg);
    expect(cfg).toEqual({
      orchestrate: { contextThresholds: { warning: 65, critical: 85 } },
      orchestrator: { other: 1 },
    });
  });

  it('merges field by field: a field set under the new key wins, the rest carry over', () => {
    const cfg: Record<string, unknown> = {
      orchestrate: { contextThresholds: { warning: 60 } },
      orchestrator: { contextThresholds: { warning: 70, critical: 90 } },
    };
    migrateLegacyConfigKeys(cfg);
    expect(cfg).toEqual({ orchestrate: { contextThresholds: { warning: 60, critical: 90 } } });
    expect(getThresholds({ ...cfg })).toEqual({ warning: 60, critical: 90 });
  });

  it('maps the legacy key path to the new one and warns, never silently', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      expect(resolveLegacyConfigKey('orchestrator.contextThresholds.critical')).toBe(
        'orchestrate.contextThresholds.critical',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("use 'orchestrate.contextThresholds.critical'"),
        'DeprecationWarning',
      );
      warn.mockClear();
      expect(resolveLegacyConfigKey('orchestrate.leadWorker.v1')).toBe('orchestrate.leadWorker.v1');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('names a legacy key as a deprecation and migrates it for validation', () => {
    const cfg: Record<string, unknown> = {
      orchestrator: { contextThresholds: { warning: 60 } },
    };
    expect(configLegacyKeyDeprecations(cfg)).toEqual([
      expect.stringMatching(/orchestrator\.contextThresholds is deprecated.*cleo upgrade/),
    ]);
    expect(cfg).toEqual({ orchestrate: { contextThresholds: { warning: 60 } } });
    expect(configLegacyKeyDeprecations(cfg)).toEqual([]);
  });

  it('getThresholds reads a legacy config and the new key', () => {
    expect(
      getThresholds({ orchestrator: { contextThresholds: { warning: 60, critical: 75 } } }),
    ).toEqual({ warning: 60, critical: 75 });
    expect(
      getThresholds({ orchestrate: { contextThresholds: { warning: 55, critical: 90 } } }),
    ).toEqual({ warning: 55, critical: 90 });
    expect(getThresholds({})).toEqual({ warning: 70, critical: 80 });
  });
});

describe('migrateHierarchyDefaults', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cleo-hierarchy-defaults-'));
    vi.stubEnv('CLEO_DIR', dir);
    vi.stubEnv('CLEO_HOME', join(dir, 'global'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('previews and repairs legacy caps with an exact backup, then applies the selected preset', async () => {
    const path = join(dir, 'config.json');
    const original = JSON.stringify({
      hierarchy: { maxDepth: 3, maxSiblings: 0, maxActiveSiblings: 0 },
      session: { autoStart: true },
    });
    await writeFile(path, original);
    if (process.platform !== 'win32') await chmod(path, 0o600);
    const journal = createUpgradeFileJournal(dir, dir);
    const keys = ['hierarchy.maxSiblings', 'hierarchy.maxActiveSiblings'];
    expect(await migrateHierarchyDefaults(path, journal, true)).toEqual(keys);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(journal.changes).toEqual([]);
    expect(await migrateHierarchyDefaults(path, journal)).toEqual(keys);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      hierarchy: { maxDepth: 3 },
      session: { autoStart: true },
    });
    expect(journal.changes).toHaveLength(1);
    expect(await readFile(journal.changes[0]!.backupPath!, 'utf8')).toBe(original);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await migrateHierarchyDefaults(path, journal)).toEqual([]);
    expect(journal.changes).toHaveLength(1);
    await setConfigValue('hierarchy.enforcementProfile', 'human-cognitive', dir);
    expect(resolveHierarchyPolicy(await loadConfig(dir))).toMatchObject({
      maxSiblings: 7,
      maxActiveSiblings: 3,
    });
  });

  it('retains positive caps and leaves intentional zeros intact until explicitly repaired', async () => {
    const path = join(dir, 'config.json');
    await setConfigValue(
      'hierarchy',
      { enforcementProfile: 'human-cognitive', maxSiblings: 0, maxActiveSiblings: 5 },
      dir,
    );
    expect(resolveHierarchyPolicy(await loadConfig(dir))).toMatchObject({
      maxSiblings: 0,
      maxActiveSiblings: 5,
    });
    expect(await migrateHierarchyDefaults(path, createUpgradeFileJournal(dir, dir))).toEqual([
      'hierarchy.maxSiblings',
    ]);
    expect(resolveHierarchyPolicy(await loadConfig(dir))).toMatchObject({
      maxSiblings: 7,
      maxActiveSiblings: 5,
    });
  });

  it('leaves malformed files untouched and fails without creating a backup', async () => {
    const path = join(dir, 'config.json');
    const journal = createUpgradeFileJournal(dir, dir);
    expect(await migrateHierarchyDefaults(path, journal)).toEqual([]);
    await writeFile(path, '{not json');
    await expect(migrateHierarchyDefaults(path, journal)).rejects.toThrow('Invalid JSON');
    expect(await readFile(path, 'utf8')).toBe('{not json');
    expect(journal.changes).toEqual([]);
  });

  it('does not rewrite config when its backup cannot be created', async () => {
    const path = join(dir, 'config.json');
    const original = JSON.stringify({ hierarchy: { maxSiblings: 0 } });
    await writeFile(path, original);
    const journal = { ...createUpgradeFileJournal(dir, dir), backupDir: join(dir, 'blocked') };
    await writeFile(journal.backupDir, 'not a directory');
    await expect(migrateHierarchyDefaults(path, journal)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(journal.changes).toEqual([]);
  });
});

describe('migrateLegacyConfigFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cleo-legacy-keys-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('config set on the legacy path writes the new path and keeps the other legacy field', async () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.stubEnv('CLEO_DIR', dir);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ orchestrator: { contextThresholds: { warning: 70, critical: 90 } } }),
    );
    const written = await setConfigValue('orchestrator.contextThresholds.warning', '60', dir);
    expect(written.key).toBe('orchestrate.contextThresholds.warning');
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({
      orchestrate: { contextThresholds: { warning: 60, critical: 90 } },
    });
    expect(await getRawConfigValue('orchestrator.contextThresholds.critical', dir)).toBe(90);
    expect(process.emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
      'DeprecationWarning',
    );
  });

  it('rewrites a legacy config once, keeping every other setting', async () => {
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        version: '2.11.0',
        session: { autoStart: true },
        orchestrator: { contextThresholds: { warning: 60, critical: 75 } },
      }),
    );
    expect(await migrateLegacyConfigFile(path)).toEqual(['orchestrator.contextThresholds']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: '2.11.0',
      session: { autoStart: true },
      orchestrate: { contextThresholds: { warning: 60, critical: 75 } },
    });
    expect(await migrateLegacyConfigFile(path)).toEqual([]);
  });

  it('leaves missing and malformed files untouched', async () => {
    expect(await migrateLegacyConfigFile(join(dir, 'absent.json'))).toEqual([]);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    expect(await migrateLegacyConfigFile(bad)).toEqual([]);
    expect(await readFile(bad, 'utf8')).toBe('{not json');
  });
});
