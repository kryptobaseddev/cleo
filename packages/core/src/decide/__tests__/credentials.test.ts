/**
 * Decision-credential store: 0600 round trip, key never serialised, clear +
 * backup purge, and the decision client loading the stored connection by
 * default. No network: `fetch` is a stub.
 *
 * @task T12491
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { DecisionRequest } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryTokenBucket } from '../budget.js';
import { _resetDecideDefaultsForTest, decide } from '../client.js';
import {
  clearDecideCredentials,
  DecideCredentialsError,
  decideCredentialsPath,
  describeDecideCredentials,
  loadDecideConnection,
  maskApiKey,
  saveDecideCredentials,
} from '../credentials.js';

const KEY = 'sk-test-SECRETVALUE-7890';
const URL = 'https://decide.test';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['CLEO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'cleo-decide-cred-'));
  process.env['CLEO_HOME'] = home;
  _resetCleoPlatformPathsCache();
  _resetDecideDefaultsForTest();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = previousHome;
  _resetCleoPlatformPathsCache();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('decide credential store', () => {
  it('stores URL, key and model in a 0600 file under the CLEO home and reads them back', async () => {
    const summary = await saveDecideCredentials({ baseUrl: URL, apiKey: `${KEY}\n`, model: 'm-1' });
    const path = decideCredentialsPath();
    expect(path).toBe(join(home, 'decide-credentials.json'));
    expect(mode(path)).toBe(0o600);
    expect(summary).toMatchObject({
      configured: true,
      baseUrl: URL,
      model: 'm-1',
      keyPreview: '…7890',
    });

    const sealed = loadDecideConnection();
    expect(sealed?.connection()).toEqual({ baseUrl: URL, apiKey: KEY, model: 'm-1' });

    // A second write rotates a backup; it must be 0600 too.
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    const backups = readdirSync(join(home, '.backups')).filter((f) =>
      f.startsWith('decide-credentials.json.'),
    );
    expect(backups.length).toBeGreaterThan(0);
    for (const b of backups) expect(mode(join(home, '.backups', b))).toBe(0o600);
    expect(loadDecideConnection()?.model).toBeUndefined();
  });

  it('never exposes the key through JSON, inspect, String or the summary', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm-1' });
    const sealed = loadDecideConnection();
    expect(sealed).not.toBeNull();
    const surfaces = [
      JSON.stringify(sealed),
      inspect(sealed, { showHidden: true, depth: 5 }),
      String(sealed),
      `${sealed}`,
      JSON.stringify(describeDecideCredentials()),
      JSON.stringify(Object.entries(sealed ?? {})),
    ];
    for (const s of surfaces) {
      expect(s).not.toContain(KEY);
      expect(s).not.toContain('SECRETVALUE');
    }
    expect(JSON.parse(JSON.stringify(sealed))).toEqual({
      baseUrl: URL,
      model: 'm-1',
      keyPreview: '…7890',
    });
  });

  it('rejects an invalid URL or blank key without echoing the key', async () => {
    await expect(saveDecideCredentials({ baseUrl: 'not a url', apiKey: KEY })).rejects.toThrow(
      DecideCredentialsError,
    );
    await expect(saveDecideCredentials({ baseUrl: 'file:///etc', apiKey: KEY })).rejects.toThrow(
      /http/,
    );
    await expect(saveDecideCredentials({ baseUrl: URL, apiKey: '   ' })).rejects.toThrow(/empty/);
    try {
      await saveDecideCredentials({ baseUrl: 'bad', apiKey: KEY });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
    expect(loadDecideConnection()).toBeNull();
  });

  it('clear removes the settings and purges rotated backups', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    expect(await clearDecideCredentials()).toBe(true);
    expect(loadDecideConnection()).toBeNull();
    expect(describeDecideCredentials().configured).toBe(false);
    expect(readFileSync(decideCredentialsPath(), 'utf-8')).not.toContain(KEY);
    const backupDir = join(home, '.backups');
    const left = existsSync(backupDir)
      ? readdirSync(backupDir).filter((f) => f.startsWith('decide-credentials.json.'))
      : [];
    expect(left).toEqual([]);
    expect(await clearDecideCredentials()).toBe(false);
  });

  it('treats a missing or malformed file as unconfigured', async () => {
    expect(loadDecideConnection()).toBeNull();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(decideCredentialsPath(), '{not json', { mode: 0o600 });
    expect(loadDecideConnection()).toBeNull();
  });

  it('masks keys to at most the last four characters', () => {
    expect(maskApiKey('abcdefgh')).toBe('…efgh');
    expect(maskApiKey('abc')).toBe('…');
  });
});

describe('decide client default loader', () => {
  const REQUEST: DecisionRequest = {
    state: 'build is red',
    questions: { retry: { type: 'noul', criteria: 'Retrying will help' } },
  };
  const heuristic = () => ({
    retry: { type: 'noul' as const, value: false, probability: 0.2, confidence: 0.1 },
  });

  it('uses the stored connection (URL, bearer key, default model) when none is passed', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'm-default' });
    const fetchStub = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ answers: { retry: { type: 'noul', noul: 0.8, confidence: 0.7 } } }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const entries: unknown[] = [];
    const outcome = await decide('site.loader', REQUEST, heuristic, {
      cache: null,
      budget: createMemoryTokenBucket(),
      audit: { write: (e) => entries.push(e) },
      timeoutMs: 2_000,
    });
    expect(outcome.source).toBe('provider');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchStub.mock.calls[0] ?? [];
    expect(calledUrl).toBe(`${URL}/v1/systemone`);
    expect((init?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body)).model).toBe('m-default');
    expect(JSON.stringify(entries)).not.toContain(KEY);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('falls back without network when nothing is stored, and null skips the loader', async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error('network forbidden');
    });
    vi.stubGlobal('fetch', fetchStub);
    const unconfigured = await decide('site.none', REQUEST, heuristic, {
      audit: null,
      cache: null,
    });
    expect(unconfigured.source).toBe('fallback');

    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    const explicitNull = await decide('site.null', REQUEST, heuristic, {
      connection: null,
      audit: null,
      cache: null,
    });
    expect(explicitNull.source).toBe('fallback');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
