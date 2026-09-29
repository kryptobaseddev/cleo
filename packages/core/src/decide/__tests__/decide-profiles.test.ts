/**
 * Named System One profiles (T12733): two keys side by side, one active.
 * Covers add, switch, remove, the 9.23 downgrade (the written file parsed by
 * a verbatim copy of the 9.23 schema), 9.23-rewrite detection, key masking in
 * every listing, and the wizard's profile prompt. No network: `fetch` is a
 * stub.
 *
 * @task T12733
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DecisionProviderKind,
  decisionProviderKindSchema,
  LAYAHOST_BASE_URL,
  LAYAHOST_DEFAULT_MODEL,
} from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StubWizardIO } from '../../setup/wizard.js';
import { _resetDecideDefaultsForTest } from '../client.js';
import {
  DecideCredentialsError,
  decideCredentialsPath,
  isValidDecideProfileName,
  listDecideProfiles,
  loadDecideConnection,
  loadDecideProfile,
  removeDecideProfile,
  resolveDecideProfile,
  saveDecideCredentials,
  useDecideProfile,
} from '../credentials.js';
import { configureDecide, listDecideProfilesReport } from '../operations.js';
import { DECISION_PROVIDER_PRESETS } from '../providers.js';
import { runDecideWizard } from '../wizard.js';

vi.mock('../transport.js', () => ({
  decideFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const LAYA_KEY = 'sk-laya-LAYASECRET-1111';
const JEV_KEY = 'sk-jev-JEVSECRET-2222';
const JEV_URL = 'https://jev.example';

/**
 * Verbatim copy of the store schema shipped in v2026.9.23
 * (`packages/core/src/decide/credentials.ts`), the release a user may
 * downgrade to.
 */
const DECIDE_CREDENTIALS_VERSION = 1;
const storeSchema923 = z.object({
  version: z.literal(DECIDE_CREDENTIALS_VERSION),
  /** T12713, optional: absent in files written before provider kinds existed. */
  provider: decisionProviderKindSchema.nullable().optional(),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['CLEO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'cleo-decide-profiles-'));
  process.env['CLEO_HOME'] = home;
  _resetCleoPlatformPathsCache();
  _resetDecideDefaultsForTest();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = previousHome;
  _resetCleoPlatformPathsCache();
  rmSync(home, { recursive: true, force: true });
});

/** A provider that lists one model and answers 404 to the extension endpoints. */
function providerFetch() {
  return vi.fn(async (u: string, _init?: RequestInit) =>
    u.endsWith('/v1/models')
      ? Response.json({ models: [{ name: 'jev-model' }] })
      : new Response('{}', { status: 404 }),
  );
}

function expectNoKeys(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [LAYA_KEY, JEV_KEY, 'LAYASECRET', 'JEVSECRET']) {
    expect(text).not.toContain(secret);
  }
}

function readRaw(): Record<string, unknown> {
  return z
    .record(z.string(), z.json())
    .parse(JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8')));
}

/** Store both profiles through the operator path: layahost first, then jev. */
async function addTwoProfiles(): Promise<void> {
  const fetch = providerFetch();
  await configureDecide({ provider: 'layahost', apiKey: LAYA_KEY, fetch });
  await configureDecide({ provider: 'jev', baseUrl: JEV_URL, apiKey: JEV_KEY, fetch });
}

describe('named profiles: add, switch, remove', () => {
  it('adds two profiles side by side; the first stays active', async () => {
    await addTwoProfiles();
    const list = listDecideProfiles();
    expect(list.active).toBe('layahost');
    expect(list.reconciled).toBe(false);
    expect(list.profiles.map((p) => [p.name, p.active, p.provider])).toEqual([
      ['jev', false, 'jev'],
      ['layahost', true, 'layahost'],
    ]);
    expect(list.profiles.find((p) => p.name === 'jev')).toMatchObject({
      baseUrl: JEV_URL,
      model: 'jev-model',
      keyPreview: '…2222',
      configured: true,
    });
    // Everyday decisions still use layahost.
    expect(loadDecideConnection()?.baseUrl).toBe(LAYAHOST_BASE_URL);
    expect(statSync(decideCredentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('resolveDecideProfile addresses any profile without switching the active one', async () => {
    await addTwoProfiles();
    const jev = resolveDecideProfile('jev');
    expect(jev.connection()).toEqual({ baseUrl: JEV_URL, apiKey: JEV_KEY, model: 'jev-model' });
    expect(resolveDecideProfile('layahost').connection().apiKey).toBe(LAYA_KEY);
    expect(listDecideProfiles().active).toBe('layahost');
    expect(() => resolveDecideProfile('nope')).toThrow(
      /no System One profile named 'nope'.*jev, layahost/,
    );
    expect(() => resolveDecideProfile('Bad Name')).toThrow(DecideCredentialsError);
    expectNoKeys(`${jev}`);
  });

  it('use switches the active profile and keeps the top level in sync', async () => {
    await addTwoProfiles();
    const list = await useDecideProfile('jev');
    expect(list.active).toBe('jev');
    expect(loadDecideConnection()?.connection()).toEqual({
      baseUrl: JEV_URL,
      apiKey: JEV_KEY,
      model: 'jev-model',
    });
    const raw = readRaw();
    expect(raw).toMatchObject({ version: 1, active: 'jev', provider: 'jev', baseUrl: JEV_URL });
    await expect(useDecideProfile('missing')).rejects.toThrow(/no System One profile/);
  });

  it('--activate on a second profile switches immediately', async () => {
    const fetch = providerFetch();
    await configureDecide({ provider: 'layahost', apiKey: LAYA_KEY, fetch });
    const result = await configureDecide({
      provider: 'jev',
      baseUrl: JEV_URL,
      apiKey: JEV_KEY,
      activate: true,
      fetch,
    });
    expect(result).toMatchObject({ profile: 'jev', active: true, activeProfile: 'jev' });
    expect(loadDecideConnection()?.baseUrl).toBe(JEV_URL);
  });

  it('a custom profile name holds a second endpoint; a new profile needs its own key', async () => {
    await addTwoProfiles();
    await expect(
      configureDecide({ profile: 'lab', provider: 'jev', baseUrl: 'https://lab.example' }),
    ).rejects.toThrow(/profile 'lab' has no stored key/);
    await expect(
      configureDecide({ profile: 'Lab_1', provider: 'jev', baseUrl: JEV_URL, apiKey: JEV_KEY }),
    ).rejects.toThrow(/invalid profile name/);
    const saved = await saveDecideCredentials({
      profile: 'lab',
      provider: 'jev',
      baseUrl: 'https://lab.example',
      apiKey: 'sk-lab-3333',
      model: 'm',
    });
    expect(saved).toMatchObject({ profile: 'lab', activeProfile: 'layahost', keyPreview: '…3333' });
    expect(listDecideProfiles().profiles.map((p) => p.name)).toEqual(['jev', 'lab', 'layahost']);
  });

  it('config without --provider updates the active profile only', async () => {
    await addTwoProfiles();
    await configureDecide({ model: 'laya-english', fetch: providerFetch() });
    expect(loadDecideProfile('layahost')?.model).toBe('laya-english');
    expect(loadDecideProfile('jev')?.model).toBe('jev-model');
  });

  it('remove refuses the active profile unless --use names another', async () => {
    await addTwoProfiles();
    await expect(removeDecideProfile('layahost')).rejects.toThrow(/active profile.*--use/);
    await expect(removeDecideProfile('layahost', 'layahost')).rejects.toThrow(/another/);
    await expect(removeDecideProfile('layahost', 'ghost')).rejects.toThrow(/another/);
    const after = await removeDecideProfile('layahost', 'jev');
    expect(after.active).toBe('jev');
    expect(after.profiles.map((p) => p.name)).toEqual(['jev']);
    expect(loadDecideConnection()?.baseUrl).toBe(JEV_URL);
    expect(JSON.stringify(readRaw())).not.toContain(LAYA_KEY);
  });

  it('removing an inactive profile keeps the active one', async () => {
    await addTwoProfiles();
    const after = await removeDecideProfile('jev');
    expect(after).toMatchObject({ active: 'layahost' });
    expect(after.profiles.map((p) => p.name)).toEqual(['layahost']);
    expect(loadDecideProfile('jev')).toBeNull();
    await expect(removeDecideProfile('jev')).rejects.toThrow(/no System One profile/);
  });

  it('validates profile names', () => {
    for (const ok of ['layahost', 'jev', 'jev-lab', 'a', 'x1']) {
      expect(isValidDecideProfileName(ok)).toBe(true);
    }
    for (const bad of ['', 'Jev', 'jev_lab', '-jev', 'jev-', 'a b', 'x'.repeat(33)]) {
      expect(isValidDecideProfileName(bad)).toBe(false);
    }
  });
});

describe('downgrade to 9.23 and rewrites by 9.23', () => {
  it('the written file parses under the 9.23 schema as the ACTIVE profile', async () => {
    await addTwoProfiles();
    await useDecideProfile('jev');
    const parsed = storeSchema923.parse(JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8')));
    expect(parsed).toMatchObject({
      version: 1,
      provider: 'jev',
      baseUrl: JEV_URL,
      apiKey: JEV_KEY,
      model: 'jev-model',
    });
    // 9.23's non-strict object strips the additive fields instead of rejecting them.
    expect(Object.keys(parsed)).not.toContain('profiles');
  });

  it('a 9.23 file (no profiles) reads as one active profile named after its provider', () => {
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({
        version: 1,
        provider: 'layahost',
        baseUrl: LAYAHOST_BASE_URL,
        apiKey: LAYA_KEY,
        model: LAYAHOST_DEFAULT_MODEL,
      }),
      { mode: 0o600 },
    );
    const list = listDecideProfiles();
    expect(list).toMatchObject({ active: 'layahost', reconciled: false });
    expect(list.profiles).toHaveLength(1);
    expect(resolveDecideProfile('layahost').connection().apiKey).toBe(LAYA_KEY);
  });

  it('detects a 9.23 rewrite: top-level differing from profiles[active] wins', async () => {
    await addTwoProfiles();
    // Simulate 9.23 re-saving its one config (new key) while the profile map survived.
    const raw = readRaw();
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ ...raw, apiKey: 'sk-laya-ROTATED-9999', model: 'laya-english' }),
      { mode: 0o600 },
    );
    const list = listDecideProfiles();
    expect(list.reconciled).toBe(true);
    expect(list.active).toBe('layahost');
    expect(list.profiles.find((p) => p.name === 'layahost')).toMatchObject({
      keyPreview: '…9999',
      model: 'laya-english',
    });
    expect(resolveDecideProfile('layahost').connection().apiKey).toBe('sk-laya-ROTATED-9999');
    // The next write persists the reconciled entry and keeps the other profile.
    await useDecideProfile('jev');
    await useDecideProfile('layahost');
    expect(listDecideProfiles().reconciled).toBe(false);
    expect(resolveDecideProfile('layahost').connection().apiKey).toBe('sk-laya-ROTATED-9999');
    expect(resolveDecideProfile('jev').connection().apiKey).toBe(JEV_KEY);
  });

  it('a 9.23 save that dropped profiles leaves its one config active; re-adding restores both', async () => {
    await addTwoProfiles();
    const kind: DecisionProviderKind = 'jev';
    // 9.23's save replaces the file with its single-config shape.
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({
        version: 1,
        provider: kind,
        baseUrl: JEV_URL,
        apiKey: JEV_KEY,
        model: null,
      }),
      { mode: 0o600 },
    );
    expect(listDecideProfiles()).toMatchObject({ active: 'jev', reconciled: false });
    expect(listDecideProfiles().profiles.map((p) => p.name)).toEqual(['jev']);
    await configureDecide({ provider: 'layahost', apiKey: LAYA_KEY, fetch: providerFetch() });
    expect(listDecideProfiles().profiles.map((p) => [p.name, p.active])).toEqual([
      ['jev', true],
      ['layahost', false],
    ]);
  });

  it('empty top-level settings beside a stored active profile mean none is active', async () => {
    await addTwoProfiles();
    const raw = readRaw();
    writeFileSync(
      decideCredentialsPath(),
      JSON.stringify({ ...raw, provider: null, baseUrl: null, apiKey: null, model: null }),
      { mode: 0o600 },
    );
    expect(loadDecideConnection()).toBeNull();
    expect(listDecideProfiles()).toMatchObject({ active: null, reconciled: true });
    expect(loadDecideProfile('jev')).not.toBeNull();
  });
});

describe('masking', () => {
  it('listings, probes and summaries never carry a key', async () => {
    await addTwoProfiles();
    const probed = await listDecideProfilesReport({ probe: true, fetch: providerFetch() });
    expect(probed.profiles.map((p) => p.probe?.state)).toEqual(['reachable', 'reachable']);
    expect(probed.profiles.map((p) => p.keyPreview)).toEqual(['…2222', '…1111']);
    expectNoKeys(probed);
    expectNoKeys(listDecideProfiles());
    expectNoKeys(await useDecideProfile('jev'));
    expectNoKeys(await removeDecideProfile('layahost', 'jev').catch((e: Error) => e.message));
    expectNoKeys(await listDecideProfilesReport());
  });

  it('without --probe the listing makes no request', async () => {
    await addTwoProfiles();
    const fetch = providerFetch();
    const list = await listDecideProfilesReport({ fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(list.profiles.every((p) => p.probe === undefined)).toBe(true);
  });
});

describe('wizard profile prompt', () => {
  const LAYA = DECISION_PROVIDER_PRESETS.layahost.label;
  const JEV = DECISION_PROVIDER_PRESETS.jev.label;
  const smoke = async () => ({
    answer: { type: 'noul' as const, value: true, probability: 0.9, confidence: 0.8 },
    source: 'provider' as const,
    latencyMs: 1,
  });

  it('Enter keeps the provider name; the first profile activates without asking', async () => {
    const io = new StubWizardIO({
      selects: [LAYA, LAYAHOST_DEFAULT_MODEL],
      prompts: [''],
      secrets: [LAYA_KEY],
      confirms: [false],
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({ configured: true });
    expect(result.summary).toMatch(/^layahost \(layahost\) configured and active/);
    expect(io.promptHistory.map((h) => h.question)).toContain(
      'Profile name (Enter for "layahost"):',
    );
    expect(io.promptHistory.some((h) => /active profile/.test(h.question))).toBe(false);
    expect(listDecideProfiles().active).toBe('layahost');
    expectNoKeys([io.infos, io.warns, io.promptHistory, result]);
  });

  it('a named second profile re-asks on an invalid name and asks whether to activate', async () => {
    await configureDecide({ provider: 'layahost', apiKey: LAYA_KEY, fetch: providerFetch() });
    const io = new StubWizardIO({
      selects: [JEV],
      prompts: ['Bad Name', 'jev-lab', JEV_URL],
      secrets: [JEV_KEY],
      confirms: [true, false],
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({
      configured: true,
      config: { profile: 'jev-lab', active: true },
    });
    expect(io.warns.some((w) => /Profile names use/.test(w))).toBe(true);
    const asked = io.promptHistory.find((h) =>
      /Make "jev-lab" the active profile/.test(h.question),
    );
    expect(asked?.question).toMatch(/"layahost" is active now/);
    expect(listDecideProfiles()).toMatchObject({ active: 'jev-lab' });
    expect(listDecideProfiles().profiles.map((p) => p.name)).toEqual(['jev-lab', 'layahost']);
    expectNoKeys([io.infos, io.warns, io.promptHistory, result]);
  });

  it('declining activation keeps the current active profile', async () => {
    await configureDecide({ provider: 'layahost', apiKey: LAYA_KEY, fetch: providerFetch() });
    const io = new StubWizardIO({
      selects: [JEV],
      prompts: ['', JEV_URL],
      secrets: [JEV_KEY],
      confirms: [false, false],
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({ configured: true, config: { profile: 'jev', active: false } });
    expect(io.infos.some((i) => /cleo decide use jev/.test(i))).toBe(true);
    expect(listDecideProfiles().active).toBe('layahost');
  });
});
