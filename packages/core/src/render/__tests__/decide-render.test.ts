/**
 * Human renderers for `cleo decide` (T12733): the config block with the
 * smoke test's question, status, ask and the profile list. ANSI codes are
 * stripped before matching.
 *
 * @task T12733
 */

import { describe, expect, it } from 'vitest';
import {
  renderDecideAsk,
  renderDecideConfig,
  renderDecideProfiles,
  renderDecideStatus,
} from '../decide/index.js';

/** Strip ANSI colour codes. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

const smoke = {
  question: 'The text says a provider was configured.',
  state: 'CLEO setup check: the System One provider was just configured.',
  profile: 'layahost/default',
  answer: { type: 'noul', value: true, probability: 0.8, confidence: 0.6 },
  source: 'provider',
  latencyMs: 368,
  costUsd: 0.000015,
  requestId: 'req_ixolop1234567890',
};

const config = {
  configured: true,
  path: '/home/u/.cleo/decide-credentials.json',
  provider: 'layahost',
  baseUrl: 'https://layahost.com',
  urlSource: 'default',
  model: 'laya-auto',
  keyPreview: '…6cWe',
  profile: 'layahost/default',
  activeProfile: 'layahost/default',
  active: true,
  modelSource: 'preset',
  providerState: 'reachable',
  capabilities: { wire: 'jev-systemone/1', maxQuestionsPerRequest: 32, maxStateChars: 32000 },
};

describe('renderDecideConfig', () => {
  it('prints the success block and the smoke question, never the envelope', () => {
    const out = plain(
      renderDecideConfig({ configured: true, summary: 'ok', config, smoke }, false),
    );
    expect(out.split('\n')).toEqual([
      '✓ System One configured: layahost/default (active)',
      '  URL      https://layahost.com (default)',
      '  Model    laya-auto',
      '  Key      …6cWe',
      '  Status   reachable · capabilities jev-systemone/1',
      '✓ Test decision',
      '  Question: The text says a provider was configured.',
      '  State:    CLEO setup check: the System One provider was just configured.',
      '  Answer:   yes (confidence 60%)',
      '  Source:   provider · 368 ms · $0.000015 · req_ixolop12…',
      '  Profile:  layahost/default',
    ]);
    expect(out).not.toContain('{');
  });

  it('marks an inactive profile with the command that switches to it', () => {
    const out = plain(
      renderDecideConfig(
        { ...config, profile: 'jev/team', active: false, activeProfile: 'layahost/default' },
        false,
      ),
    );
    expect(out).toContain('System One configured: jev/team (inactive; cleo decide use jev/team)');
  });

  it('a skipped wizard says so', () => {
    expect(
      plain(renderDecideConfig({ configured: false, summary: 'skipped (empty api key)' }, false)),
    ).toBe('! System One not configured: skipped (empty api key)');
  });
});

describe('renderDecideAsk', () => {
  it('shows question, state, yes/no with confidence, source, latency and cost', () => {
    const out = plain(renderDecideAsk(smoke, false));
    expect(out).toContain('Question: The text says a provider was configured.');
    expect(out).toContain('Answer:   yes (confidence 60%)');
    expect(out).toContain('Source:   provider · 368 ms · $0.000015');
    expect(plain(renderDecideAsk(smoke, true))).toBe('yes (confidence 60%)');
  });

  it('flags a fallback with its reason', () => {
    const out = plain(
      renderDecideAsk(
        { ...smoke, source: 'fallback', fallbackReason: 'timeout', costUsd: undefined },
        false,
      ),
    );
    expect(out.split('\n')[0]).toBe('! System One decision');
    expect(out).toContain('Fallback: timeout');
  });
});

describe('renderDecideStatus', () => {
  it('shows state, settings, balance and spend', () => {
    const out = plain(
      renderDecideStatus(
        {
          state: 'reachable',
          profile: 'layahost/work',
          baseUrl: 'https://layahost.com',
          keyPreview: '…1111',
          model: 'laya-auto',
          latencyMs: 42,
          sites: 7,
          capabilities: {
            wire: 'jev-systemone/1',
            usage: true,
            batch: { maxRequests: 1, maxQuestions: 1 },
          },
          usage: { balanceMicros: 2_500_000, decisionsLeft: 1000, fetchedAt: 'x' },
          spend: {
            month: '2026-09',
            spentMicros: 15,
            reservedMicros: 0,
            capMicros: 1_000_000,
            capReached: false,
          },
        },
        false,
      ),
    );
    expect(out).toContain('✓ System One reachable: layahost/work');
    expect(out).toContain(
      'Status   reachable · 42 ms · capabilities jev-systemone/1 + batch, usage',
    );
    expect(out).toContain('Balance  $2.50 (1000 decisions left)');
    expect(out).toContain('Spend    $0.000015 of $1.00 in 2026-09');
  });
});

describe('renderDecideProfiles', () => {
  it('lists profiles with the active one marked and keys masked', () => {
    const out = plain(
      renderDecideProfiles(
        {
          path: '/x',
          active: 'layahost/work',
          reconciled: false,
          profiles: [
            {
              id: 'jev/team',
              name: 'team',
              active: false,
              provider: 'jev',
              baseUrl: 'https://jev.internal',
              urlSource: 'override',
              keyPreview: '…2222',
              model: 'm',
              configured: true,
              probe: { state: 'unauthorized' },
            },
            {
              id: 'layahost/work',
              name: 'work',
              active: true,
              provider: 'layahost',
              baseUrl: 'https://layahost.com',
              urlSource: 'default',
              keyPreview: '…1111',
              model: 'laya-auto',
              configured: true,
            },
          ],
        },
        false,
      ),
    );
    expect(out.split('\n')).toEqual([
      'System One profiles (active: layahost/work)',
      '  jev/team       https://jev.internal (override)  m  …2222  unauthorized',
      '* layahost/work  https://layahost.com (default)  laya-auto  …1111',
    ]);
  });
});
