/**
 * Legacy config key migration: orchestrator.contextThresholds -> orchestrate (T14375).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawConfigValue, setConfigValue } from '../../config.js';
import { getThresholds } from '../../skills/orchestrator/startup.js';
import {
  configLegacyKeyDeprecations,
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
