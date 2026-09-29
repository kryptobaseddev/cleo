/**
 * `runDecideWizard` (T12713) driven by a queued {@link StubWizardIO}: the
 * layahost path (key only), the jev path (URL + listed model), the probe
 * failure path, and the `system-one` setup section that wraps it. The key is
 * read through `secret()` and never appears in any output.
 *
 * @task T12713
 * @task T12714
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYAHOST_BASE_URL } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinSections, WIZARD_SECTION_IDS } from '../../setup/index.js';
import { createSystemOneSection } from '../../setup/sections/system-one.js';
import { StubWizardIO } from '../../setup/wizard.js';
import { _resetDecideDefaultsForTest } from '../client.js';
import { loadDecideConnection } from '../credentials.js';
import type { DecideAskResult } from '../operations.js';
import { DECISION_PROVIDER_PRESETS } from '../providers.js';
import { runDecideWizard } from '../wizard.js';

vi.mock('../transport.js', () => ({
  decideFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
}));

const KEY = 'sk-test-WIZARDSECRET-2468';
const JEV_URL = 'https://jev.example';
const LAYA = DECISION_PROVIDER_PRESETS.layahost.label;
const JEV = DECISION_PROVIDER_PRESETS.jev.label;

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['CLEO_HOME'];
  home = mkdtempSync(join(tmpdir(), 'cleo-decide-wizard-'));
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

/** A provider that lists `models` and answers 404 to the extension endpoints. */
function providerFetch(models: string[]) {
  return vi.fn(async (u: string, _init?: RequestInit) =>
    u.endsWith('/v1/models')
      ? Response.json({ models: models.map((name) => ({ name })) })
      : new Response('{}', { status: 404 }),
  );
}

const smokeOk: DecideAskResult = {
  answer: { type: 'noul', value: true, probability: 0.9, confidence: 0.8 },
  source: 'provider',
  latencyMs: 12,
};

function expectKeyNeverShown(io: StubWizardIO, result: unknown): void {
  const all = JSON.stringify([io.infos, io.warns, io.errors, io.promptHistory, result]);
  expect(all).not.toContain(KEY);
  expect(all).not.toContain('WIZARDSECRET');
}

describe('runDecideWizard', () => {
  it('layahost path: key only, laya-auto preselected first, smoke run after save', async () => {
    const fetchStub = providerFetch(['laya-english', 'laya-auto', 'laya-multilingual']);
    const smoke = vi.fn(async () => smokeOk);
    const selectSpy = vi.spyOn(StubWizardIO.prototype, 'select');
    const io = new StubWizardIO({
      selects: [LAYA, 'laya-auto'],
      prompts: [''], // T12733: Enter keeps "default" as the profile name
      secrets: [KEY],
      confirms: [true, true], // use the default URL; run the smoke test
    });
    const result = await runDecideWizard(io, { fetch: fetchStub, smoke });

    expect(result).toMatchObject({ configured: true, smoke: { source: 'provider' } });
    expect(result.config).toMatchObject({
      provider: 'layahost',
      baseUrl: LAYAHOST_BASE_URL,
      model: 'laya-auto',
      keyPreview: '…2468',
    });
    // Provider menu: layahost first; model menu: the default first, no duplicate.
    expect(selectSpy.mock.calls[0]?.[1]?.[0]).toBe(LAYA);
    expect(selectSpy.mock.calls[1]?.[1]).toEqual([
      'laya-auto',
      'laya-english',
      'laya-multilingual',
    ]);
    // No URL prompt on the layahost path; the key went through secret().
    expect(io.promptHistory.find((h) => /API key/.test(h.question))?.answer).toBe('***');
    expect(io.promptHistory.some((h) => /base URL/.test(h.question))).toBe(false);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(loadDecideConnection()?.connection()).toEqual({
      baseUrl: LAYAHOST_BASE_URL,
      apiKey: KEY,
      model: 'laya-auto',
    });
    expectKeyNeverShown(io, result);
    selectSpy.mockRestore();
  });

  it('jev path: prompts for the URL, re-asks on a plain-http remote URL, model from the listing', async () => {
    const fetchStub = providerFetch(['jev-a', 'jev-b']);
    const io = new StubWizardIO({
      selects: [JEV, 'jev-b'],
      prompts: ['', 'http://remote.example', JEV_URL],
      secrets: [KEY],
      confirms: [false, false], // override the default URL; no smoke test
    });
    const smoke = vi.fn(async () => smokeOk);
    const result = await runDecideWizard(io, { fetch: fetchStub, smoke });

    expect(result.config).toMatchObject({ provider: 'jev', baseUrl: JEV_URL, model: 'jev-b' });
    expect(io.warns.some((w) => /not accepted/.test(w))).toBe(true);
    expect(fetchStub.mock.calls.some(([u]) => u === `${JEV_URL}/v1/models`)).toBe(true);
    expect(smoke).not.toHaveBeenCalled();
    expect(result.smoke).toBeUndefined();
    expectKeyNeverShown(io, result);
  });

  it('jev path with an empty listing asks for the model name', async () => {
    const io = new StubWizardIO({
      selects: [JEV],
      prompts: ['', JEV_URL, 'custom-model'],
      secrets: [KEY],
      confirms: [false, false],
    });
    const result = await runDecideWizard(io, { fetch: providerFetch([]) });
    expect(result.config).toMatchObject({ provider: 'jev', model: 'custom-model' });
  });

  it('a failed probe asks before saving; declining stores nothing', async () => {
    const io = new StubWizardIO({
      selects: [LAYA],
      prompts: [''],
      secrets: [KEY],
      confirms: [true, false], // use the default URL; do not save after the failed probe
    });
    const result = await runDecideWizard(io, {
      fetch: vi.fn(async () => new Response('{}', { status: 401 })),
    });
    expect(result).toMatchObject({
      configured: false,
      summary: 'cancelled (provider probe failed)',
    });
    expect(loadDecideConnection()).toBeNull();
    expectKeyNeverShown(io, result);
  });

  it('an empty key leaves the settings unchanged', async () => {
    const io = new StubWizardIO({
      selects: [LAYA],
      prompts: [''],
      secrets: [''],
      confirms: [true],
    });
    const result = await runDecideWizard(io, { fetch: vi.fn() });
    expect(result).toMatchObject({ configured: false, summary: 'skipped (empty api key)' });
    expect(loadDecideConnection()).toBeNull();
  });
});

describe('system-one setup section', () => {
  it('is registered right after llm, optional, and known to --config-json', () => {
    const ids = createBuiltinSections().map((s) => s.section);
    expect(ids.indexOf('system-one')).toBe(ids.indexOf('llm') + 1);
    const section = createBuiltinSections().find((s) => s.section === 'system-one');
    expect(section?.optional).toBe(true);
    expect(WIZARD_SECTION_IDS.has('system-one')).toBe(true);
  });

  it('isConfigured reads the decide store; run skips non-interactive and "not now"', async () => {
    const section = createSystemOneSection({ fetch: providerFetch(['laya-auto']) });
    expect(await section.isConfigured?.({})).toBe(false);
    const skipped = await section.run(new StubWizardIO(), { nonInteractive: true });
    expect(skipped).toMatchObject({ changed: false });
    const declined = await section.run(new StubWizardIO(), {});
    expect(declined).toMatchObject({ changed: false, summary: 'skipped (not now)' });

    const io = new StubWizardIO({
      confirms: [true, true, false],
      selects: [LAYA],
      prompts: [''],
      secrets: [KEY],
    });
    const ran = await section.run(io, {});
    expect(ran.changed).toBe(true);
    expect(await section.isConfigured?.({})).toBe(true);
    expectKeyNeverShown(io, ran);
  });
});
