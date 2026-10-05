/**
 * Passive update notice (T13137): an installed CLEO learns about a newer
 * release, and a stronger notice names a release flagged as a hotfix, from a
 * cached dist-tags check that never runs on the command's own path.
 *
 * @task T13137
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimUpdateCheck,
  compareVersions,
  decideUpdateNotice,
  formatUpdateNotice,
  HOTFIX_NOTICE_INTERVAL_MS,
  isCiEnvironment,
  parseUpdateCache,
  releaseChannelTag,
  type ShowUpdateNoticeOptions,
  showUpdateNotice,
  UPDATE_CACHE_FILE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_LOCK_STALE_MS,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_LOCK_FILE,
  UPDATE_NOTICE_INTERVAL_MS,
  type UpdateCheckCache,
  type UpdateCheckRequest,
  updateCheckDue,
  updateNoticeSuppression,
} from '../update-notice.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-03T12:00:00.000Z');

describe('compareVersions', () => {
  it('orders CalVer numerically, not lexically', () => {
    expect(compareVersions('2026.10.3', '2026.10.10')).toBe(-1);
    expect(compareVersions('2026.9.30', '2026.10.1')).toBe(-1);
    expect(compareVersions('2026.10.3', '2026.10.3')).toBe(0);
    expect(compareVersions('2027.1.0', '2026.12.9')).toBe(1);
  });

  it('ranks a prerelease below its release, by semver identifier rules', () => {
    expect(compareVersions('2026.10.4-beta.1', '2026.10.4')).toBe(-1);
    expect(compareVersions('2026.10.4-beta.2', '2026.10.4-beta.10')).toBe(-1);
    expect(compareVersions('2026.10.4-beta.1', '2026.10.4-rc.1')).toBe(-1);
    expect(compareVersions('2026.10.4-beta', '2026.10.4-beta.1')).toBe(-1);
  });

  it('returns null for anything that is not a version', () => {
    expect(compareVersions('unknown', '2026.10.3')).toBeNull();
    expect(compareVersions('2026.10', '2026.10.3')).toBeNull();
  });
});

describe('releaseChannelTag', () => {
  it('follows the release workflow: plain → latest, beta/rc → beta, alpha/dev → none', () => {
    expect(releaseChannelTag('2026.10.3')).toBe('latest');
    expect(releaseChannelTag('2026.10.4-beta.1')).toBe('beta');
    expect(releaseChannelTag('2026.10.4-rc.2')).toBe('beta');
    expect(releaseChannelTag('2026.10.4-alpha.1')).toBeNull();
    expect(releaseChannelTag('2026.10.4-dev.3')).toBeNull();
    expect(releaseChannelTag('garbage')).toBeNull();
  });
});

describe('decideUpdateNotice', () => {
  it('is silent when the install is current or ahead of its channel', () => {
    expect(decideUpdateNotice('2026.10.3', { latest: '2026.10.3' })).toBeNull();
    expect(decideUpdateNotice('2026.10.4', { latest: '2026.10.3' })).toBeNull();
    expect(decideUpdateNotice('2026.10.3', {})).toBeNull();
  });

  it('names the newer release on the install channel', () => {
    expect(
      decideUpdateNotice('2026.10.3', { latest: '2026.10.5', beta: '2026.11.0-beta.1' }),
    ).toEqual({ kind: 'update', installed: '2026.10.3', target: '2026.10.5' });
    expect(
      decideUpdateNotice('2026.10.4-beta.1', { latest: '2026.10.3', beta: '2026.10.4-beta.2' }),
    ).toEqual({ kind: 'update', installed: '2026.10.4-beta.1', target: '2026.10.4-beta.2' });
  });

  it('gives a hotfix notice when self-update delivers a flagged release the install lacks', () => {
    expect(decideUpdateNotice('2026.10.3', { latest: '2026.10.5' }, '2026.10.4')).toEqual({
      kind: 'hotfix',
      installed: '2026.10.3',
      target: '2026.10.5',
      hotfix: '2026.10.4',
    });
    expect(decideUpdateNotice('2026.10.3', { latest: '2026.10.4' }, '2026.10.4')).toEqual({
      kind: 'hotfix',
      installed: '2026.10.3',
      target: '2026.10.4',
      hotfix: '2026.10.4',
    });
  });

  it('never reads a hotfix dist-tag: only release metadata flags a hotfix (T13184)', () => {
    expect(decideUpdateNotice('2026.10.3', { latest: '2026.10.4', hotfix: '2026.10.4' })).toEqual({
      kind: 'update',
      installed: '2026.10.3',
      target: '2026.10.4',
    });
  });

  it('ignores a hotfix the install already has, or one self-update would not deliver', () => {
    // Already past the hotfix: a plain update notice.
    expect(decideUpdateNotice('2026.10.4', { latest: '2026.10.5' }, '2026.10.4')?.kind).toBe(
      'update',
    );
    // Hotfix tag above the channel target (self-update installs the target).
    expect(decideUpdateNotice('2026.10.3', { latest: '2026.10.4' }, '2026.10.6')?.kind).toBe(
      'update',
    );
    // No newer release at all: a stale hotfix flag alone says nothing.
    expect(decideUpdateNotice('2026.10.4', { latest: '2026.10.4' }, '2026.10.4')).toBeNull();
  });
});

describe('formatUpdateNotice', () => {
  it('is one line naming the version and cleo self-update', () => {
    const line = formatUpdateNotice({
      kind: 'update',
      installed: '2026.10.3',
      target: '2026.10.5',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(line).toContain('2026.10.5');
    expect(line).toContain('2026.10.3');
    expect(line).toContain('`cleo self-update`');
    expect(line).toContain('CLEO_NO_UPDATE_NOTICE=1');
  });

  it('makes a hotfix notice stronger and names the flagged release', () => {
    const line = formatUpdateNotice({
      kind: 'hotfix',
      installed: '2026.10.3',
      target: '2026.10.5',
      hotfix: '2026.10.4',
    });
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(line).toContain('HOTFIX');
    expect(line).toContain('2026.10.4');
    expect(line).toContain('2026.10.5');
    expect(line).toContain('`cleo self-update` now');
  });
});

describe('updateNoticeSuppression', () => {
  it('honours CLEO_NO_UPDATE_NOTICE and NO_UPDATE_NOTIFIER in any environment', () => {
    expect(updateNoticeSuppression(['list'], { CLEO_NO_UPDATE_NOTICE: '1' }, true)).toBe(
      'CLEO_NO_UPDATE_NOTICE',
    );
    expect(updateNoticeSuppression(['list'], { CLEO_NO_UPDATE_NOTICE: 'true' }, true)).toBe(
      'CLEO_NO_UPDATE_NOTICE',
    );
    expect(updateNoticeSuppression(['list'], { NO_UPDATE_NOTIFIER: '1' }, true)).toBe(
      'NO_UPDATE_NOTIFIER',
    );
    expect(updateNoticeSuppression(['list'], { CLEO_NO_UPDATE_NOTICE: '0' }, true)).toBeNull();
  });

  it('is silent in CI', () => {
    expect(isCiEnvironment({ CI: 'true' })).toBe(true);
    expect(isCiEnvironment({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiEnvironment({ CI: 'false' })).toBe(false);
    expect(isCiEnvironment({})).toBe(false);
    expect(updateNoticeSuppression(['list'], { CI: '1' }, true)).toBe('ci');
  });

  it('is silent from a source checkout unless asked', () => {
    expect(updateNoticeSuppression(['list'], {}, false)).toBe('source-checkout');
    expect(
      updateNoticeSuppression(['list'], { CLEO_UPDATE_NOTICE_FROM_SOURCE: '1' }, false),
    ).toBeNull();
  });

  it('skips self-update and hook commands, and nothing else', () => {
    expect(updateNoticeSuppression(['self-update', '--check'], {}, true)).toBe(
      'command:self-update',
    );
    expect(updateNoticeSuppression(['hook', 'heavy-command'], {}, true)).toBe('command:hook');
    expect(updateNoticeSuppression(['--json', 'show', 'T1'], {}, true)).toBeNull();
  });
});

describe('cache and lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-update-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a malformed cache as no cache', () => {
    expect(parseUpdateCache('not json')).toBeNull();
    expect(parseUpdateCache('{"schemaVersion":2}')).toBeNull();
    expect(
      parseUpdateCache(
        JSON.stringify({
          schemaVersion: 1,
          checkedAt: 'yesterday',
          ok: true,
          distTags: { latest: '2026.10.3' },
        }),
      ),
    ).toBeNull();
  });

  it('reads the flagged hotfix version and drops a malformed one (T13184)', () => {
    const base = {
      schemaVersion: 1,
      checkedAt: new Date(T0).toISOString(),
      ok: true,
      distTags: {},
    };
    expect(parseUpdateCache(JSON.stringify({ ...base, hotfix: '2026.10.4' }))?.hotfix).toBe(
      '2026.10.4',
    );
    expect(parseUpdateCache(JSON.stringify({ ...base, hotfix: 'yes' }))).not.toHaveProperty(
      'hotfix',
    );
  });

  it('keeps only well-formed versions from the cache', () => {
    const cache = parseUpdateCache(
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: new Date(T0).toISOString(),
        ok: true,
        distTags: { latest: '2026.10.3', bad: '<script>', num: 7 },
      }),
    );
    expect(cache?.distTags).toEqual({ latest: '2026.10.3' });
  });

  it('checks daily after success and hourly after a failure', () => {
    const at = (ok: boolean): UpdateCheckCache => ({
      schemaVersion: 1,
      checkedAt: new Date(T0).toISOString(),
      ok,
      distTags: {},
    });
    expect(updateCheckDue(null, T0)).toBe(true);
    expect(updateCheckDue(at(true), T0 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(updateCheckDue(at(true), T0 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    expect(updateCheckDue(at(false), T0 + UPDATE_CHECK_RETRY_MS - 1)).toBe(false);
    expect(updateCheckDue(at(false), T0 + UPDATE_CHECK_RETRY_MS)).toBe(true);
    // A clock that moved backwards.
    expect(updateCheckDue(at(true), T0 - HOUR)).toBe(true);
  });

  it('admits one check at a time and reclaims a dead check lock', () => {
    const lock = join(dir, UPDATE_LOCK_FILE);
    expect(claimUpdateCheck(lock, Date.now())).toBe(true);
    expect(claimUpdateCheck(lock, Date.now())).toBe(false);
    const old = (Date.now() - UPDATE_CHECK_LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    expect(claimUpdateCheck(lock, Date.now())).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });
});

describe('showUpdateNotice', () => {
  let stateDir: string;
  let lines: string[];
  let started: UpdateCheckRequest[];

  /** Options for an installed CLI outside CI, with the check and stderr captured. */
  function options(over: Partial<ShowUpdateNoticeOptions> = {}): ShowUpdateNoticeOptions {
    return {
      version: '2026.10.3',
      argv: ['list'],
      env: {},
      stateDir,
      installedPackage: true,
      now: () => T0,
      stderr: { write: (chunk: string) => lines.push(chunk) },
      startCheck: (request) => started.push(request),
      ...over,
    };
  }

  function seedCache(
    distTags: Record<string, string>,
    checkedAt = T0,
    ok = true,
    hotfix?: string,
  ): void {
    const cache: UpdateCheckCache = {
      schemaVersion: 1,
      checkedAt: new Date(checkedAt).toISOString(),
      ok,
      distTags,
      ...(hotfix === undefined ? {} : { hotfix }),
    };
    writeFileSync(join(stateDir, UPDATE_CACHE_FILE), JSON.stringify(cache));
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cleo-update-notice-'));
    lines = [];
    started = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('with no cache, starts one background check and prints nothing', () => {
    const outcome = showUpdateNotice(options());
    expect(outcome).toEqual({ suppressed: null, checkStarted: true, shown: null });
    expect(lines).toEqual([]);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      cachePath: join(stateDir, UPDATE_CACHE_FILE),
      lockPath: join(stateDir, UPDATE_LOCK_FILE),
      registry: 'https://registry.npmjs.org/',
      packageName: '@cleocode/cleo',
    });
    // A concurrent command while that check runs starts no second one.
    expect(showUpdateNotice(options()).checkStarted).toBe(false);
    expect(started).toHaveLength(1);
  });

  it("uses npm's configured registry", () => {
    showUpdateNotice(options({ env: { npm_config_registry: 'https://npm.example.com/' } }));
    expect(started[0]?.registry).toBe('https://npm.example.com/');
  });

  it('shows a regular notice once a day, never on stdout', () => {
    seedCache({ latest: '2026.10.5' });
    const stdout = vi.spyOn(process.stdout, 'write');
    const first = showUpdateNotice(options());
    expect(first.shown).toEqual({ kind: 'update', installed: '2026.10.3', target: '2026.10.5' });
    expect(first.checkStarted).toBe(false);
    expect(lines).toEqual([formatUpdateNotice(first.shown as NonNullable<typeof first.shown>)]);

    expect(showUpdateNotice(options({ now: () => T0 + HOUR })).shown).toBeNull();
    expect(lines).toHaveLength(1);

    // A day later: shown again (and the cache is due, so a check starts too).
    const later = showUpdateNotice(options({ now: () => T0 + UPDATE_NOTICE_INTERVAL_MS }));
    expect(later.shown?.kind).toBe('update');
    expect(later.checkStarted).toBe(true);
    expect(lines).toHaveLength(2);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('shows a hotfix notice at most every 15 minutes, not on every command', () => {
    seedCache({ latest: '2026.10.4' }, T0, true, '2026.10.4');
    const at = (ms: number) => showUpdateNotice(options({ now: () => T0 + ms })).shown?.kind;
    expect(at(0)).toBe('hotfix');
    expect(at(1000)).toBeUndefined();
    expect(at(HOTFIX_NOTICE_INTERVAL_MS - 1)).toBeUndefined();
    expect(at(HOTFIX_NOTICE_INTERVAL_MS)).toBe('hotfix');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes('HOTFIX'))).toBe(true);
  });

  it('announces a hotfix at once even right after a regular notice', () => {
    seedCache({ latest: '2026.10.4' });
    expect(showUpdateNotice(options()).shown?.kind).toBe('update');
    seedCache({ latest: '2026.10.4' }, T0, true, '2026.10.4');
    expect(showUpdateNotice(options({ now: () => T0 + 1000 })).shown?.kind).toBe('hotfix');
    expect(lines).toHaveLength(2);
  });

  it('writes only to stderr when no stream is injected', () => {
    seedCache({ latest: '2026.10.4' }, T0, true, '2026.10.4');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { stderr: _injected, ...rest } = options();
    expect(showUpdateNotice(rest).shown?.kind).toBe('hotfix');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('HOTFIX');
  });

  it('--quiet prints nothing but still refreshes a stale cache', () => {
    seedCache({ latest: '2026.10.4' }, T0 - UPDATE_CHECK_INTERVAL_MS, true, '2026.10.4');
    const outcome = showUpdateNotice(options({ quiet: true }));
    expect(outcome.shown).toBeNull();
    expect(outcome.checkStarted).toBe(true);
    expect(lines).toEqual([]);
  });

  it('when suppressed (CI or opt-out), neither prints, checks nor writes state', () => {
    seedCache({ latest: '2026.10.4' }, T0 - UPDATE_CHECK_INTERVAL_MS, true, '2026.10.4');
    for (const env of [{ CI: 'true' }, { CLEO_NO_UPDATE_NOTICE: '1' }]) {
      const outcome = showUpdateNotice(options({ env }));
      expect(outcome.checkStarted).toBe(false);
      expect(outcome.shown).toBeNull();
      expect(outcome.suppressed).not.toBeNull();
    }
    expect(lines).toEqual([]);
    expect(started).toEqual([]);
    expect(existsSync(join(stateDir, UPDATE_LOCK_FILE))).toBe(false);
  });

  it('releases the lock when the check cannot start, and never throws', () => {
    const outcome = showUpdateNotice(
      options({
        startCheck: () => {
          throw new Error('spawn failed');
        },
      }),
    );
    expect(outcome.checkStarted).toBe(false);
    expect(existsSync(join(stateDir, UPDATE_LOCK_FILE))).toBe(false);
  });

  it('reads a corrupt cache as none and starts a fresh check', () => {
    writeFileSync(join(stateDir, UPDATE_CACHE_FILE), '{oops');
    const outcome = showUpdateNotice(options());
    expect(outcome.checkStarted).toBe(true);
    expect(outcome.shown).toBeNull();
    expect(readFileSync(join(stateDir, UPDATE_CACHE_FILE), 'utf8')).toBe('{oops');
  });
});
