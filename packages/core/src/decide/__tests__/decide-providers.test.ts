/**
 * Decision-provider presets (T12713): layahost is the recommended default with
 * a fixed URL and model; jev needs a URL and takes its model from /v1/models.
 *
 * @task T12713
 */

import {
  DECISION_PROVIDER_KINDS,
  LAYAHOST_BASE_URL,
  LAYAHOST_DEFAULT_MODEL,
} from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  DECISION_PROVIDER_PRESETS,
  inferDecisionProviderKind,
  listDecisionProviderPresets,
  parseDecisionProviderKind,
} from '../providers.js';

describe('decision provider presets', () => {
  it('layahost: fixed URL (OpenAPI servers[0]), laya-auto, recommended, no URL needed', () => {
    expect(LAYAHOST_BASE_URL).toBe('https://layahost.com');
    expect(DECISION_PROVIDER_PRESETS.layahost).toMatchObject({
      kind: 'layahost',
      defaultBaseUrl: LAYAHOST_BASE_URL,
      defaultModel: LAYAHOST_DEFAULT_MODEL,
      requiresUrl: false,
      recommended: true,
    });
    expect(LAYAHOST_DEFAULT_MODEL).toBe('laya-auto');
  });

  it('jev: URL required, no default URL or model (the listing decides)', () => {
    const jev = DECISION_PROVIDER_PRESETS.jev;
    expect(jev).toMatchObject({ kind: 'jev', requiresUrl: true, recommended: false });
    expect(jev.defaultBaseUrl).toBeUndefined();
    expect(jev.defaultModel).toBeUndefined();
  });

  it('lists every kind, recommended first, with distinct labels', () => {
    const presets = listDecisionProviderPresets();
    expect(presets.map((p) => p.kind)).toEqual([...DECISION_PROVIDER_KINDS]);
    expect(presets[0]?.recommended).toBe(true);
    expect(presets[0]?.label).toMatch(/recommended/);
    expect(new Set(presets.map((p) => p.label)).size).toBe(presets.length);
  });

  it('parses flag values and rejects unknown ones', () => {
    expect(parseDecisionProviderKind('layahost')).toBe('layahost');
    expect(parseDecisionProviderKind(' JEV ')).toBe('jev');
    expect(parseDecisionProviderKind('openai')).toBeUndefined();
    expect(parseDecisionProviderKind(undefined)).toBeUndefined();
  });

  it('infers the kind from the URL origin (scheme, host and port)', () => {
    expect(inferDecisionProviderKind('https://layahost.com/')).toBe('layahost');
    expect(inferDecisionProviderKind('https://LAYAHOST.com/api')).toBe('layahost');
    expect(inferDecisionProviderKind('https://evil.layahost.com.example')).toBe('jev');
    expect(inferDecisionProviderKind('http://127.0.0.1:47811')).toBe('jev');
    expect(inferDecisionProviderKind('not a url')).toBe('jev');
    // Same host, different scheme or port → a different origin → not layahost.
    expect(inferDecisionProviderKind('http://layahost.com')).toBe('jev');
    expect(inferDecisionProviderKind('https://layahost.com:8443')).toBe('jev');
  });
});
