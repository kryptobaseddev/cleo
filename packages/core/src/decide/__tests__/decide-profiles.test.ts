/**
 * System One profiles (T12733): several accounts per provider, addressed as
 * `<provider>/<name>`, exactly one active. Covers add, switch, remove, the
 * stored `default` URL, the 9.23 downgrade (the written file parsed by a
 * verbatim copy of the 9.23 schema), 9.23-rewrite detection, key masking in
 * every listing, and the wizard's profile and URL prompts. No network:
 * `fetch` is a stub.
 *
 * @task T12733
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decisionProviderKindSchema,
  JEV_DEFAULT_BASE_URL,
  JEV_MINIMUM_CAPABILITIES,
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
  parseDecideProfileRef,
  removeDecideProfile,
  resolveDecideProfile,
  saveDecideCredentials,
  useDecideProfile,
} from '../credentials.js';
import { askDecideDebug, configureDecide, listDecideProfilesReport } from '../operations.js';
import {
  _resetProviderStateMemoForTest,
  cachedCapabilities,
  defaultProviderStatePath,
  providerKeyHash,
  readProviderState,
  writeProviderState,
} from '../provider-state.js';
import { DECISION_PROVIDER_PRESETS } from '../providers.js';
import { runDecideWizard } from '../wizard.js';

vi.mock('../transport.js', () => ({
  decideFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const WORK_KEY = 'sk-laya-WORKSECRET-1111';
const HOME_KEY = 'sk-laya-HOMESECRET-3333';
const JEV_KEY = 'sk-jev-JEVSECRET-2222';
const TEAM_URL = 'https://jev.internal';

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
  for (const secret of [WORK_KEY, HOME_KEY, JEV_KEY, 'WORKSECRET', 'HOMESECRET', 'JEVSECRET']) {
    expect(text).not.toContain(secret);
  }
}

/** The raw file, every field kept (loose objects, so a rewrite copies them verbatim). */
const rawStoreSchema = z.looseObject({
  active: z.string().optional(),
  provider: z.string().nullable().optional(),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  profiles: z.record(z.string(), z.looseObject({ baseUrl: z.string(), apiKey: z.string() })),
});

function readRaw(): z.infer<typeof rawStoreSchema> {
  return rawStoreSchema.parse(JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8')));
}

function writeRaw(value: object): void {
  writeFileSync(decideCredentialsPath(), JSON.stringify(value), { mode: 0o600 });
}

/** layahost/work (first, so active), layahost/personal, and jev/team on an override URL. */
async function addProfiles(): Promise<void> {
  const fetch = providerFetch();
  await configureDecide({ provider: 'layahost', profile: 'work', apiKey: WORK_KEY, fetch });
  await configureDecide({ profile: 'layahost/personal', apiKey: HOME_KEY, fetch });
  await configureDecide({ profile: 'jev/team', baseUrl: TEAM_URL, apiKey: JEV_KEY, fetch });
}

describe('profile references', () => {
  it('parses <provider>/<name> and a bare provider as <provider>/default', () => {
    expect(parseDecideProfileRef('layahost/work')).toEqual({
      provider: 'layahost',
      name: 'work',
      id: 'layahost/work',
    });
    expect(parseDecideProfileRef('jev')?.id).toBe('jev/default');
    for (const bad of ['', 'work', 'openai/x', 'layahost/', 'layahost/Work', 'a/b/c', 'jev/x_y']) {
      expect(parseDecideProfileRef(bad)).toBeNull();
    }
  });

  it('validates profile names', () => {
    for (const ok of ['default', 'work', 'team-b', 'a', 'x1']) {
      expect(isValidDecideProfileName(ok)).toBe(true);
    }
    for (const bad of ['', 'Work', 'team_b', '-x', 'x-', 'a b', 'x'.repeat(33)]) {
      expect(isValidDecideProfileName(bad)).toBe(false);
    }
  });
});

describe('profiles: add, switch, remove', () => {
  it('holds several accounts per provider; the first profile stays active', async () => {
    await addProfiles();
    const list = listDecideProfiles();
    expect(list).toMatchObject({ active: 'layahost/work', reconciled: false });
    expect(list.profiles.map((p) => [p.id, p.active, p.urlSource])).toEqual([
      ['jev/team', false, 'override'],
      ['layahost/personal', false, 'default'],
      ['layahost/work', true, 'default'],
    ]);
    expect(list.profiles.find((p) => p.id === 'layahost/personal')).toMatchObject({
      name: 'personal',
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      model: LAYAHOST_DEFAULT_MODEL,
      keyPreview: '…3333',
    });
    expect(loadDecideConnection()?.connection().apiKey).toBe(WORK_KEY);
    expect(statSync(decideCredentialsPath()).mode & 0o777).toBe(0o600);
  });

  it('stores the preset URL as the literal "default" and resolves it at call time', async () => {
    await addProfiles();
    const raw = readRaw();
    expect(raw.profiles['layahost/work']?.baseUrl).toBe('default');
    expect(raw.profiles['jev/team']?.baseUrl).toBe(TEAM_URL);
    // The top level (what 9.23 reads) carries the resolved URL.
    expect(raw.baseUrl).toBe(LAYAHOST_BASE_URL);
    // An explicit URL equal to the preset collapses to "default" too.
    await saveDecideCredentials({
      profile: 'jev/default',
      baseUrl: `${JEV_DEFAULT_BASE_URL}/`,
      apiKey: JEV_KEY,
    });
    expect(readRaw().profiles['jev/default']?.baseUrl).toBe('default');
    expect(resolveDecideProfile('jev').baseUrl).toBe(JEV_DEFAULT_BASE_URL);
  });

  it('resolveDecideProfile addresses any profile without switching the active one', async () => {
    await addProfiles();
    expect(resolveDecideProfile('layahost/personal')).toEqual({
      name: 'layahost/personal',
      profile: 'layahost/personal',
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      apiKey: HOME_KEY,
      model: LAYAHOST_DEFAULT_MODEL,
    });
    expect(resolveDecideProfile('jev/team')).toEqual({
      name: 'jev/team',
      profile: 'jev/team',
      provider: 'jev',
      baseUrl: TEAM_URL,
      apiKey: JEV_KEY,
      model: 'jev-model',
    });
    expect(listDecideProfiles().active).toBe('layahost/work');
    expect(() => resolveDecideProfile('layahost/nope')).toThrow(
      /no System One profile 'layahost\/nope'.*jev\/team, layahost\/personal, layahost\/work/,
    );
    expect(() => resolveDecideProfile('Bad Name')).toThrow(DecideCredentialsError);
    expectNoKeys([`${loadDecideProfile('jev/team')}`, loadDecideProfile('jev/team')]);
  });

  it('use switches the active profile and keeps the top level in sync', async () => {
    await addProfiles();
    const list = await useDecideProfile('layahost/personal');
    expect(list.active).toBe('layahost/personal');
    expect(loadDecideConnection()?.connection().apiKey).toBe(HOME_KEY);
    await useDecideProfile('jev/team');
    expect(readRaw()).toMatchObject({
      active: 'jev/team',
      provider: 'jev',
      baseUrl: TEAM_URL,
      apiKey: JEV_KEY,
    });
    await expect(useDecideProfile('jev/missing')).rejects.toThrow(/no System One profile/);
    await expect(useDecideProfile('nope')).rejects.toThrow(/invalid profile/);
  });

  it('--activate on another profile switches immediately', async () => {
    const fetch = providerFetch();
    await configureDecide({ provider: 'layahost', apiKey: WORK_KEY, fetch });
    const result = await configureDecide({
      profile: 'jev/team',
      baseUrl: TEAM_URL,
      apiKey: JEV_KEY,
      activate: true,
      fetch,
    });
    expect(result).toMatchObject({ profile: 'jev/team', active: true, activeProfile: 'jev/team' });
    expect(loadDecideConnection()?.baseUrl).toBe(TEAM_URL);
  });

  it('a new profile needs its own key; a provider mismatch is refused', async () => {
    await addProfiles();
    await expect(configureDecide({ profile: 'layahost/lab' })).rejects.toThrow(
      /profile 'layahost\/lab' has no stored key/,
    );
    await expect(
      configureDecide({ provider: 'jev', profile: 'layahost/lab', apiKey: JEV_KEY }),
    ).rejects.toThrow(/belongs to layahost, not jev/);
    await expect(configureDecide({ profile: 'Lab_1', apiKey: JEV_KEY })).rejects.toThrow(
      /invalid profile name/,
    );
  });

  it('config without --profile updates the active profile of that provider', async () => {
    await addProfiles();
    await configureDecide({ model: 'laya-english', fetch: providerFetch() });
    expect(loadDecideProfile('layahost/work')?.model).toBe('laya-english');
    expect(loadDecideProfile('layahost/personal')?.model).toBe(LAYAHOST_DEFAULT_MODEL);
    // A different provider without --profile targets <provider>/default.
    await configureDecide({ provider: 'jev', apiKey: JEV_KEY, fetch: providerFetch() });
    expect(loadDecideProfile('jev/default')?.baseUrl).toBe(JEV_DEFAULT_BASE_URL);
  });

  it('--url default resets an override back to the preset', async () => {
    await addProfiles();
    await configureDecide({
      profile: 'jev/team',
      baseUrl: 'default',
      apiKey: JEV_KEY,
      fetch: providerFetch(),
    });
    expect(readRaw().profiles['jev/team']?.baseUrl).toBe('default');
    expect(resolveDecideProfile('jev/team').baseUrl).toBe(JEV_DEFAULT_BASE_URL);
  });

  it('remove refuses the active profile unless --use names another', async () => {
    await addProfiles();
    await expect(removeDecideProfile('layahost/work')).rejects.toThrow(/active profile.*--use/);
    await expect(removeDecideProfile('layahost/work', 'layahost/work')).rejects.toThrow(/another/);
    await expect(removeDecideProfile('layahost/work', 'jev/ghost')).rejects.toThrow(/another/);
    const after = await removeDecideProfile('layahost/work', 'layahost/personal');
    expect(after.active).toBe('layahost/personal');
    expect(after.profiles.map((p) => p.id)).toEqual(['jev/team', 'layahost/personal']);
    expect(loadDecideConnection()?.connection().apiKey).toBe(HOME_KEY);
    expect(readFileSync(decideCredentialsPath(), 'utf-8')).not.toContain(WORK_KEY);
  });

  it('removing an inactive profile keeps the active one', async () => {
    await addProfiles();
    const after = await removeDecideProfile('jev/team');
    expect(after.active).toBe('layahost/work');
    expect(loadDecideProfile('jev/team')).toBeNull();
    await expect(removeDecideProfile('jev/team')).rejects.toThrow(/no System One profile/);
  });

  it('decide ask --profile asks through that profile and reports the question', async () => {
    await addProfiles();
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        calls.push(`${u} ${new Headers(init?.headers).get('authorization') ?? ''}`);
        return new Response('{}', { status: 503 });
      }),
    );
    try {
      const result = await askDecideDebug({
        state: 's',
        question: 'Is it?',
        profile: 'jev/team',
        timeoutMs: 500,
      });
      expect(result).toMatchObject({ question: 'Is it?', profile: 'jev/team' });
      expect(calls.some((c) => c.startsWith(TEAM_URL) && c.endsWith(JEV_KEY))).toBe(true);
      expectNoKeys(result);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('downgrade to 9.23 and rewrites by 9.23', () => {
  it('the written file parses under the 9.23 schema as the ACTIVE profile, URL resolved', async () => {
    await addProfiles();
    await useDecideProfile('layahost/personal');
    const parsed = storeSchema923.parse(JSON.parse(readFileSync(decideCredentialsPath(), 'utf-8')));
    expect(parsed).toMatchObject({
      version: 1,
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      apiKey: HOME_KEY,
      model: LAYAHOST_DEFAULT_MODEL,
    });
    // 9.23's non-strict object strips the additive fields instead of rejecting them.
    expect(Object.keys(parsed)).not.toContain('profiles');
  });

  it('a 9.23 file (no profiles) reads as <provider>/default, active', () => {
    writeRaw({
      version: 1,
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      apiKey: WORK_KEY,
      model: LAYAHOST_DEFAULT_MODEL,
    });
    const list = listDecideProfiles();
    expect(list).toMatchObject({ active: 'layahost/default', reconciled: false });
    expect(list.profiles).toEqual([expect.objectContaining({ urlSource: 'default' })]);
    expect(resolveDecideProfile('layahost').apiKey).toBe(WORK_KEY);
  });

  it('a 9.23 custom jev URL becomes jev/default with that URL as an override', () => {
    writeRaw({ version: 1, baseUrl: TEAM_URL, apiKey: JEV_KEY, model: null });
    expect(listDecideProfiles().profiles).toEqual([
      expect.objectContaining({ id: 'jev/default', urlSource: 'override', baseUrl: TEAM_URL }),
    ]);
  });

  it('detects a 9.23 rewrite: top-level settings differing from the active profile win', async () => {
    await addProfiles();
    // 9.23 re-saved its one config (a rotated key) while the profile map survived.
    writeRaw({ ...readRaw(), version: 1, apiKey: 'sk-laya-ROTATED-9999', model: 'laya-english' });
    const list = listDecideProfiles();
    expect(list).toMatchObject({ active: 'layahost/work', reconciled: true });
    expect(list.profiles.find((p) => p.id === 'layahost/work')).toMatchObject({
      keyPreview: '…9999',
      model: 'laya-english',
      urlSource: 'default',
    });
    // The next write persists it and keeps every other profile.
    await useDecideProfile('layahost/personal');
    await useDecideProfile('layahost/work');
    expect(listDecideProfiles().reconciled).toBe(false);
    expect(resolveDecideProfile('layahost/work').apiKey).toBe('sk-laya-ROTATED-9999');
    expect(resolveDecideProfile('jev/team').apiKey).toBe(JEV_KEY);
  });

  it('a 9.23 provider switch becomes <new provider>/<active name>', async () => {
    await addProfiles();
    const raw = readRaw();
    writeRaw({ ...raw, version: 1, provider: 'jev', baseUrl: TEAM_URL, apiKey: JEV_KEY });
    const list = listDecideProfiles();
    expect(list).toMatchObject({ active: 'jev/work', reconciled: true });
    expect(resolveDecideProfile('layahost/work').apiKey).toBe(WORK_KEY);
  });

  it('a 9.23 save that dropped profiles leaves its one config active; adding more keeps it', async () => {
    await addProfiles();
    writeRaw({ version: 1, provider: 'jev', baseUrl: TEAM_URL, apiKey: JEV_KEY, model: null });
    expect(listDecideProfiles()).toMatchObject({ active: 'jev/default', reconciled: false });
    await configureDecide({ provider: 'layahost', apiKey: WORK_KEY, fetch: providerFetch() });
    expect(listDecideProfiles().profiles.map((p) => [p.id, p.active])).toEqual([
      ['jev/default', true],
      ['layahost/default', false],
    ]);
  });

  it('empty top-level settings beside a stored active profile mean none is active', async () => {
    await addProfiles();
    writeRaw({
      ...readRaw(),
      version: 1,
      provider: null,
      baseUrl: null,
      apiKey: null,
      model: null,
    });
    expect(loadDecideConnection()).toBeNull();
    expect(listDecideProfiles()).toMatchObject({ active: null, reconciled: true });
    expect(loadDecideProfile('jev/team')).not.toBeNull();
  });
});

describe('provider state is kept per profile (two accounts on one URL)', () => {
  const BATCHING = {
    ...JEV_MINIMUM_CAPABILITIES,
    batch: { maxRequests: 8, maxQuestions: 256 },
    cacheControl: true,
  };

  it('two layahost profiles with different keys never overwrite each other', async () => {
    await addProfiles();
    _resetProviderStateMemoForTest();
    const work = loadDecideProfile('layahost/work')?.connection();
    const personal = loadDecideProfile('layahost/personal')?.connection();
    if (!work || !personal) throw new Error('profiles not stored');
    expect(work.baseUrl).toBe(personal.baseUrl);
    const now = Date.now();
    writeProviderState(
      {
        baseUrl: work.baseUrl,
        keyHash: providerKeyHash(WORK_KEY),
        detectedAt: now,
        capabilities: BATCHING,
      },
      defaultProviderStatePath(),
      'layahost/work',
    );
    writeProviderState(
      {
        baseUrl: personal.baseUrl,
        keyHash: providerKeyHash(HOME_KEY),
        detectedAt: now,
        capabilities: JEV_MINIMUM_CAPABILITIES,
      },
      defaultProviderStatePath(),
      'layahost/personal',
    );
    // Before T12733 the second write replaced the first: work lost batching.
    expect(readProviderState(work)?.capabilities.batch).toEqual(BATCHING.batch);
    expect(cachedCapabilities(work)?.cacheControl).toBe(true);
    expect(cachedCapabilities(personal)?.batch).toBeUndefined();
    // The key hash still guards: the work profile with another key reads nothing.
    expect(readProviderState({ ...work, apiKey: HOME_KEY })).toBeNull();
    // No key is ever written to the state file.
    expectNoKeys(readFileSync(defaultProviderStatePath(), 'utf-8'));
  });

  it('still reads a pre-T12733 single-state file, guarded by URL and key', async () => {
    await addProfiles();
    _resetProviderStateMemoForTest();
    const work = loadDecideProfile('layahost/work')?.connection();
    if (!work) throw new Error('profile not stored');
    const legacy = {
      baseUrl: work.baseUrl,
      keyHash: providerKeyHash(WORK_KEY),
      detectedAt: Date.now(),
      capabilities: BATCHING,
    };
    writeFileSync(defaultProviderStatePath(), JSON.stringify(legacy));
    expect(readProviderState(work)?.capabilities.batch).toEqual(BATCHING.batch);
    expect(readProviderState({ ...work, apiKey: HOME_KEY })).toBeNull();
  });
});

describe('masking', () => {
  it('listings, probes and summaries never carry a key', async () => {
    await addProfiles();
    const probed = await listDecideProfilesReport({ probe: true, fetch: providerFetch() });
    expect(probed.profiles.map((p) => p.probe?.state)).toEqual([
      'reachable',
      'reachable',
      'reachable',
    ]);
    expect(probed.profiles.map((p) => p.keyPreview)).toEqual(['…2222', '…3333', '…1111']);
    expectNoKeys(probed);
    expectNoKeys(listDecideProfiles());
    expectNoKeys(await useDecideProfile('jev/team'));
    expectNoKeys(await removeDecideProfile('layahost/work'));
  });

  it('without --probe the listing makes no request', async () => {
    await addProfiles();
    const fetch = providerFetch();
    const list = await listDecideProfilesReport({ fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(list.profiles.every((p) => p.probe === undefined)).toBe(true);
  });
});

describe('wizard profile and URL prompts', () => {
  const LAYA = DECISION_PROVIDER_PRESETS.layahost.label;
  const JEV = DECISION_PROVIDER_PRESETS.jev.label;
  const smoke = async () => ({
    answer: { type: 'noul' as const, value: true, probability: 0.9, confidence: 0.8 },
    source: 'provider' as const,
    latencyMs: 1,
  });

  it('Enter keeps "default"; the default URL is stored as "default"; the first profile activates', async () => {
    const io = new StubWizardIO({
      selects: [LAYA, LAYAHOST_DEFAULT_MODEL],
      prompts: [''],
      secrets: [WORK_KEY],
      confirms: [true, false], // default URL; no smoke
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({ configured: true, config: { profile: 'layahost/default' } });
    expect(result.summary).toMatch(/^layahost\/default configured and active/);
    const questions = io.promptHistory.map((h) => h.question);
    expect(questions).toContain('Profile name, saved as layahost/<name> (Enter for "default"):');
    expect(questions).toContain(`Use the default URL (${LAYAHOST_BASE_URL})?`);
    expect(questions.some((q) => /active profile/.test(q))).toBe(false);
    expect(readRaw().profiles['layahost/default']?.baseUrl).toBe('default');
    expectNoKeys([io.infos, io.warns, io.promptHistory, result]);
  });

  it('a named second profile with an override URL re-asks a bad name and asks to activate', async () => {
    await configureDecide({ provider: 'layahost', apiKey: WORK_KEY, fetch: providerFetch() });
    const io = new StubWizardIO({
      selects: [JEV],
      prompts: ['Bad Name', 'team', TEAM_URL],
      secrets: [JEV_KEY],
      confirms: [false, true, false], // override URL; activate; no smoke
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({
      configured: true,
      config: { profile: 'jev/team', active: true },
    });
    expect(io.warns.some((w) => /Profile names use/.test(w))).toBe(true);
    const asked = io.promptHistory.find((h) =>
      /Make "jev\/team" the active profile/.test(h.question),
    );
    expect(asked?.question).toMatch(/"layahost\/default" is active now/);
    expect(listDecideProfiles().active).toBe('jev/team');
    expect(readRaw().profiles['jev/team']?.baseUrl).toBe(TEAM_URL);
    expectNoKeys([io.infos, io.warns, io.promptHistory, result]);
  });

  it('declining activation keeps the current active profile', async () => {
    await configureDecide({ provider: 'layahost', apiKey: WORK_KEY, fetch: providerFetch() });
    const io = new StubWizardIO({
      selects: [JEV],
      prompts: [''],
      secrets: [JEV_KEY],
      confirms: [true, false, false], // default Jev URL; do not activate; no smoke
    });
    const result = await runDecideWizard(io, { fetch: providerFetch(), smoke });
    expect(result).toMatchObject({
      configured: true,
      config: { profile: 'jev/default', active: false },
    });
    expect(io.infos.some((i) => /cleo decide use jev\/default/.test(i))).toBe(true);
    expect(listDecideProfiles().active).toBe('layahost/default');
    expect(resolveDecideProfile('jev').baseUrl).toBe(JEV_DEFAULT_BASE_URL);
  });
});
