/**
 * Legacy config key migration: orchestrator.contextThresholds -> orchestrate (T14375).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getThresholds } from '../../skills/orchestrator/startup.js';
import { migrateLegacyConfigFile, migrateLegacyConfigKeys } from '../legacy-keys.js';

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
    await rm(dir, { recursive: true, force: true });
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
