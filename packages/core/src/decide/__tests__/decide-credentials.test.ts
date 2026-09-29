/**
 * Decision-credential store: 0600 round trip, key never serialised, clear +
 * backup purge, and the decision client loading the stored connection by
 * default. No network: `fetch` is a stub.
 *
 * @task T12491
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { type DecisionRequest, LAYAHOST_BASE_URL } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMemoryTokenBucket } from '../budget.js';
import { _resetDecideDefaultsForTest, decide } from '../client.js';
import {
  _resetDecideHomeWarningForTest,
  clearDecideCredentials,
  DecideCredentialsError,
  decideCredentialsPath,
  describeDecideCredentials,
  isAllowedDecideBaseUrl,
  loadDecideConnection,
  maskApiKey,
  saveDecideCredentials,
} from '../credentials.js';

// T12492: the default Jev transport is `decideFetch` (node:http, releases every
// handle on abort), not the global `fetch`. These tests drive the default
// provider through a stubbed global `fetch`, so route the transport through it.
vi.mock('../transport.js', () => ({
  decideFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

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
    // T12733: the connection names its profile (a file without profiles is jev/default).
    expect(sealed?.connection()).toEqual({
      baseUrl: URL,
      apiKey: KEY,
      model: 'm-1',
      profile: 'jev/default',
    });

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
      provider: 'jev',
      baseUrl: URL,
      model: 'm-1',
      keyPreview: '…7890',
      profile: 'jev/default', // T12733: the profile id is not secret
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

  it('T12713: a file without provider infers the kind from its base URL', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ version: 1, baseUrl: URL, apiKey: KEY, model: 'm-1' }),
      { mode: 0o600 },
    );
    const sealed = loadDecideConnection();
    expect(sealed?.provider).toBe('jev');
    // T12733: the connection names its profile (a file without profiles is jev/default).
    expect(sealed?.connection()).toEqual({
      baseUrl: URL,
      apiKey: KEY,
      model: 'm-1',
      profile: 'jev/default',
    });
    expect(describeDecideCredentials()).toMatchObject({ configured: true, provider: 'jev' });

    // A provider-less file pointing at the layahost origin is layahost, not jev.
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ version: 1, baseUrl: LAYAHOST_BASE_URL, apiKey: KEY }),
      { mode: 0o600 },
    );
    expect(loadDecideConnection()?.provider).toBe('layahost');
    expect(describeDecideCredentials()).toMatchObject({ configured: true, provider: 'layahost' });
  });

  it('T12713: writes schema version 1, which the released (pre-provider) schema still parses', async () => {
    await saveDecideCredentials({ provider: 'layahost', baseUrl: URL, apiKey: KEY, model: 'm-1' });
    const onDisk: unknown = JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8'));
    expect(onDisk).toMatchObject({ version: 1, provider: 'layahost', baseUrl: URL });
    expect(mode(decideCredentialsPath())).toBe(0o600);
    expect(loadDecideConnection()?.provider).toBe('layahost');

    // Verbatim copy of the store schema released in v2026.9.21 (origin/main,
    // before T12713). A downgraded CLEO must still read the file.
    const releasedSchema = z.object({
      version: z.literal(1),
      baseUrl: z.string().nullable(),
      apiKey: z.string().nullable(),
      model: z.string().nullable().optional(),
      updatedAt: z.string().optional(),
    });
    const parsed = releasedSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ baseUrl: URL, model: 'm-1' });

    // A cleared store parses under the released schema too.
    await clearDecideCredentials();
    const cleared: unknown = JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8'));
    expect(releasedSchema.safeParse(cleared).success).toBe(true);
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

describe('decide credential hardening', () => {
  it.each([
    ['https://provider.example', true],
    ['https://provider.example:8443/api', true],
    ['http://localhost:8080', true],
    ['http://127.0.0.1:47811', true],
    ['http://[::1]:9000', true],
    ['http://provider.example', false],
    ['http://10.0.0.5', false],
    ['http://localhost.evil.example', false],
    ['ftp://provider.example', false],
    ['file:///etc/passwd', false],
    ['https://user:hunter2@provider.example', false],
    ['https://user@provider.example', false],
    ['https://:hunter2@provider.example', false],
  ] as const)('baseUrl %s allowed=%s', (url, allowed) => {
    expect(isAllowedDecideBaseUrl(url)).toBe(allowed);
  });

  it('refuses to store a remote plain-http URL, and the loader ignores one on disk', async () => {
    await expect(
      saveDecideCredentials({ baseUrl: 'http://provider.example', apiKey: KEY }),
    ).rejects.toThrow(/https/);
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ version: 1, baseUrl: 'http://provider.example', apiKey: KEY }),
      { mode: 0o600 },
    );
    expect(loadDecideConnection()).toBeNull();
  });

  it('refuses a URL with userinfo and never echoes the password', async () => {
    const attempt = saveDecideCredentials({
      baseUrl: 'https://user:hunter2@provider.example',
      apiKey: KEY,
    });
    await expect(attempt).rejects.toThrow(/username or password/);
    const err = await attempt.catch((e: Error) => e);
    expect(String(err)).not.toContain('hunter2');
    expect(JSON.stringify(describeDecideCredentials())).not.toContain('hunter2');
  });

  it('never echoes userinfo from a store written before the check', () => {
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ version: 1, baseUrl: 'https://user:hunter2@provider.example', apiKey: KEY }),
      { mode: 0o600 },
    );
    expect(loadDecideConnection()).toBeNull();
    expect(JSON.stringify(describeDecideCredentials())).not.toContain('hunter2');
  });

  it('rejects model names with escape or control characters, and drops them on load', async () => {
    const hostile = 'laya\u001b[31mred\u0007';
    await expect(
      saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: hostile }),
    ).rejects.toThrow(/model name/);
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ version: 1, baseUrl: URL, apiKey: KEY, model: hostile }),
      { mode: 0o600 },
    );
    expect(loadDecideConnection()?.model).toBeUndefined();
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY, model: 'org/model-v1.2:ft@x' });
    expect(loadDecideConnection()?.model).toBe('org/model-v1.2:ft@x');
  });

  it('refuses to write through a symlinked store file', async () => {
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, '{}');
    symlinkSync(target, decideCredentialsPath());
    await expect(saveDecideCredentials({ baseUrl: URL, apiKey: KEY })).rejects.toThrow(/symlink/);
    expect(readFileSync(target, 'utf-8')).toBe('{}');
  });

  it('refuses to write when .backups or a backup file is a symlink', async () => {
    await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    const outside = mkdtempSync(join(tmpdir(), 'cleo-decide-outside-'));
    try {
      rmSync(join(home, '.backups'), { recursive: true, force: true });
      symlinkSync(outside, join(home, '.backups'));
      await expect(saveDecideCredentials({ baseUrl: URL, apiKey: KEY })).rejects.toThrow(/symlink/);
      await expect(clearDecideCredentials()).rejects.toThrow(/symlink/);
      expect(readdirSync(outside)).toEqual([]);

      rmSync(join(home, '.backups'));
      mkdirSync(join(home, '.backups'), { mode: 0o700 });
      const leak = join(outside, 'leak');
      writeFileSync(leak, '');
      symlinkSync(leak, join(home, '.backups', 'decide-credentials.json.1'));
      await expect(saveDecideCredentials({ baseUrl: URL, apiKey: KEY })).rejects.toThrow(/symlink/);
      expect(readFileSync(leak, 'utf-8')).toBe('');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('warns on stderr (once, without the key) when the CLEO home is group/world-writable', async () => {
    _resetDecideHomeWarningForTest();
    chmodSync(home, 0o777);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
      await saveDecideCredentials({ baseUrl: URL, apiKey: KEY });
    } finally {
      spy.mockRestore();
      chmodSync(home, 0o700);
    }
    const warnings = writes.filter((w) => w.includes('group- or world-writable'));
    expect(warnings).toHaveLength(1);
    expect(warnings.join('')).not.toContain(KEY);
  });
});
