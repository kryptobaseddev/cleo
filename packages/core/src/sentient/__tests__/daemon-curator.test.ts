/**
 * Unit tests for the curator daemon-integration helpers (T9682 / T9683).
 *
 * Covers:
 *   - `readCuratorConfig` returns defaults when the config file is absent.
 *   - `readCuratorConfig` returns defaults when `daemon.curator` is absent.
 *   - `readCuratorConfig` reads valid fields and ignores malformed ones.
 *   - `curatorCronExpression` emits sane crons for hourly, daily, and weekly
 *      intervals.
 *
 * The bootstrap-side `cron.schedule` is exercised indirectly by the existing
 * daemon-supervision suite — we focus here on the pure helpers so coverage is
 * deterministic and side-effect-free.
 *
 * @task T9682, T9683
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { curatorCronExpression, DEFAULT_CURATOR_CONFIG, readCuratorConfig } from '../daemon.js';

describe('readCuratorConfig', () => {
  let tmpRoot: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9682-'));
    configPath = join(tmpRoot, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns defaults when the config file does not exist', async () => {
    const cfg = await readCuratorConfig(configPath);
    expect(cfg).toEqual(DEFAULT_CURATOR_CONFIG);
    expect(cfg.enabled).toBe(false);
  });

  it('returns defaults when daemon.curator is missing', async () => {
    writeFileSync(configPath, JSON.stringify({ daemon: { superviseStudio: true } }), 'utf-8');
    const cfg = await readCuratorConfig(configPath);
    expect(cfg).toEqual(DEFAULT_CURATOR_CONFIG);
  });

  it('reads valid fields and ignores malformed ones', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        daemon: {
          curator: {
            enabled: true,
            runEveryHours: 12,
            staleAfterDays: 'thirty', // malformed — should fall through to default
            archiveAfterDays: -1, // out of range — should fall through to default
          },
        },
      }),
      'utf-8',
    );

    const cfg = await readCuratorConfig(configPath);
    expect(cfg.enabled).toBe(true);
    expect(cfg.runEveryHours).toBe(12);
    expect(cfg.staleAfterDays).toBe(DEFAULT_CURATOR_CONFIG.staleAfterDays);
    expect(cfg.archiveAfterDays).toBe(DEFAULT_CURATOR_CONFIG.archiveAfterDays);
  });

  it('disabled = false short-circuits even when other fields are valid', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        daemon: {
          curator: { enabled: false, runEveryHours: 24, staleAfterDays: 60, archiveAfterDays: 180 },
        },
      }),
      'utf-8',
    );
    const cfg = await readCuratorConfig(configPath);
    expect(cfg.enabled).toBe(false);
    // Sub-fields still parse so the dry-run CLI can preview them.
    expect(cfg.runEveryHours).toBe(24);
    expect(cfg.staleAfterDays).toBe(60);
    expect(cfg.archiveAfterDays).toBe(180);
  });
});

describe('curatorCronExpression', () => {
  it('hourly intervals less than 24 emit every-N-hours', () => {
    expect(curatorCronExpression(1)).toBe('0 */1 * * *');
    expect(curatorCronExpression(6)).toBe('0 */6 * * *');
    expect(curatorCronExpression(12)).toBe('0 */12 * * *');
  });

  it('exact multiples of 24 emit every-N-days at midnight UTC', () => {
    expect(curatorCronExpression(24)).toBe('0 0 */1 * *');
    expect(curatorCronExpression(168)).toBe('0 0 */7 * *');
  });

  it('fractional intervals are clamped UP to 1 hour minimum', () => {
    expect(curatorCronExpression(0.5)).toBe('0 */1 * * *');
    expect(curatorCronExpression(0)).toBe('0 */1 * * *');
  });

  it('very long intervals fall back to once-per-day', () => {
    // 90 days exceeds 28 — falls back to daily so should_run_now can gate.
    expect(curatorCronExpression(24 * 90)).toBe('0 0 * * *');
  });
});
