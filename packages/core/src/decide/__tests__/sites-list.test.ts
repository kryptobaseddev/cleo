/**
 * `cleo decide sites` listing — modes, filters and audit activity (T12662).
 *
 * @task T12662
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_AUDIT_FILE } from '../audit.js';
import { listDecisionSites } from '../sites/list.js';
import { DECISION_SITES } from '../sites/registry.js';

let root: string;
const NOW = new Date('2026-09-28T12:00:00.000Z');
const noConfig = async (): Promise<unknown> => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'decide-sites-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write audit lines to the live file. */
function audit(lines: readonly object[]): void {
  const file = join(root, DECISION_AUDIT_FILE);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const byId = (r: Awaited<ReturnType<typeof listDecisionSites>>, id: string) =>
  r.sites.find((s) => s.id === id);

describe('listDecisionSites (T12662)', () => {
  it('lists every registered site', async () => {
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: false,
      readConfig: noConfig,
      now: NOW,
    });
    expect(r.total).toBe(DECISION_SITES.length);
    expect(r.sites.map((s) => s.id)).toEqual(DECISION_SITES.map((s) => s.id));
  });

  it('is off for every System One site while no provider is configured; generative sites stay on', async () => {
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: false,
      readConfig: async () => 'on',
      now: NOW,
    });
    expect(r.providerConfigured).toBe(false);
    const dup = byId(r, 'tasks.duplicate-detection');
    expect(dup?.configuredMode).toBe('on');
    expect(dup?.effectiveMode).toBe('off');
    expect(byId(r, 'orchestration.owner-decision')?.effectiveMode).toBe('off');
    expect(byId(r, 'memory.extraction')?.effectiveMode).toBe('on');
  });

  it('uses the configured mode when a provider is configured, else the default', async () => {
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: true,
      readConfig: async (key) => (key === 'decide.sites.observationType' ? 'on' : undefined),
      now: NOW,
    });
    expect(byId(r, 'memory.observation-type')).toMatchObject({
      configuredMode: 'on',
      effectiveMode: 'on',
      modeKey: 'decide.sites.observationType',
    });
    const dup = byId(r, 'tasks.duplicate-detection');
    expect(dup?.configuredMode).toBeUndefined();
    expect(dup?.effectiveMode).toBe('shadow');
  });

  it('ignores an invalid configured mode', async () => {
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: true,
      readConfig: async () => 'sometimes',
      now: NOW,
    });
    expect(byId(r, 'tasks.duplicate-detection')?.configuredMode).toBeUndefined();
  });

  it('filters by rung, effective mode, id and evidence', async () => {
    const base = { projectRoot: root, providerConfigured: true, readConfig: noConfig, now: NOW };
    const rule = await listDecisionSites({ ...base, rung: 'rule' });
    expect(rule.sites.map((s) => s.id)).toEqual(['orchestration.owner-decision']);
    const shadow = await listDecisionSites({ ...base, mode: 'shadow' });
    expect(shadow.sites.every((s) => s.effectiveMode === 'shadow')).toBe(true);
    expect(shadow.sites.length).toBe(4);
    const one = await listDecisionSites({ ...base, id: 'memory.observation-type' });
    expect(one.sites.map((s) => s.id)).toEqual(['memory.observation-type']);
    expect(one.total).toBe(DECISION_SITES.length);
    expect((await listDecisionSites({ ...base, evidenceOnly: true })).sites).toEqual([]);
  });

  it('counts the last seven days of audit activity per site', async () => {
    const site = 'tasks.duplicate-detection';
    audit([
      { timestamp: '2026-09-28T10:00:00.000Z', site, source: 'provider', shadow: { agree: true } },
      { timestamp: '2026-09-27T10:00:00.000Z', site, source: 'provider', shadow: { agree: false } },
      { timestamp: '2026-09-26T10:00:00.000Z', site, source: 'cache', shadow: { agree: true } },
      { timestamp: '2026-09-25T10:00:00.000Z', site, source: 'fallback', shadow: { agree: null } },
      { timestamp: '2026-09-01T10:00:00.000Z', site, source: 'provider' },
      {
        timestamp: '2026-09-28T10:00:00.000Z',
        site: 'memory.observation-type',
        source: 'fallback',
      },
    ]);
    writeFileSync(join(root, `${DECISION_AUDIT_FILE}`), 'not json\n', { flag: 'a' });
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: true,
      readConfig: noConfig,
      now: NOW,
    });
    expect(byId(r, site)?.last7d).toEqual({
      asked: 4,
      provider: 2,
      cache: 1,
      fallback: 1,
      escalated: 0,
      agreement: 2 / 3,
    });
    expect(byId(r, 'memory.observation-type')?.last7d).toEqual({
      asked: 1,
      provider: 0,
      cache: 0,
      fallback: 1,
      escalated: 0,
    });
    expect(byId(r, 'memory.derivation')?.last7d.asked).toBe(0);
  });

  it('reads rotated audit generations too', async () => {
    const file = join(root, DECISION_AUDIT_FILE);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      `${file}.1`,
      `${JSON.stringify({ timestamp: '2026-09-27T00:00:00.000Z', site: 'cli.decide-ask', source: 'fallback' })}\n`,
    );
    const r = await listDecisionSites({
      projectRoot: root,
      providerConfigured: true,
      readConfig: noConfig,
      now: NOW,
    });
    expect(byId(r, 'cli.decide-ask')?.last7d.asked).toBe(1);
  });
});
