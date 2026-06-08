/**
 * Gate-13 import-purity guard for the S2 Pi embed (T11761 · S2 · T11898).
 *
 * The single dangerous side effect of importing `pi-agent-core`'s runtime is
 * that it transitively value-imports `pi-ai`'s barrel, which fires
 * `register-builtins` at module top level. Per the cartography (foundation §3.2)
 * that population is INERT: it stores lazy closures, constructs NO SDK client,
 * and reads NO `process.env[<PROVIDER>_API_KEY]` AT IMPORT — the env read only
 * happens later, inside `stream.ts withEnvApiKey`, which our custom streamFn
 * never reaches.
 *
 * This test imports the S2 adapter (→ pi-agent-core → pi-ai barrel) inside a
 * `process.env` proxy and asserts ZERO provider-key reads occurred at import
 * time. It also confirms the registry IS populated (proving the import really
 * exercised register-builtins) — populated-but-inert is the accepted contract,
 * NOT a Gate-13 leak.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import { afterEach, describe, expect, it } from 'vitest';

/** Provider-key env vars pi-ai's env-fallback would read (env-api-keys.ts table). */
const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'KIMI_API_KEY',
];

let savedEnv: NodeJS.ProcessEnv | null = null;

afterEach(() => {
  if (savedEnv) {
    process.env = savedEnv;
    savedEnv = null;
  }
});

describe('S2 import-time Gate-13 purity', () => {
  it('importing the Pi adapter does NOT read any provider *_API_KEY at module-evaluation time', async () => {
    const reads: string[] = [];
    savedEnv = process.env;
    process.env = new Proxy(savedEnv, {
      get(target, prop) {
        if (typeof prop === 'string' && PROVIDER_KEYS.includes(prop)) {
          reads.push(prop);
        }
        return Reflect.get(target, prop);
      },
    }) as NodeJS.ProcessEnv;

    // Importing the adapter pulls pi-agent-core (loop) → pi-ai (barrel) →
    // register-builtins. None of that may read a provider key at import.
    const mod = await import('../pi-agent-adapter.js');
    expect(typeof mod.createPiSkillRunner).toBe('function');
    expect(typeof mod.isPiRunnerEnabled).toBe('function');

    // Restore BEFORE asserting so a failure message renders cleanly.
    process.env = savedEnv;
    savedEnv = null;

    expect(reads).toEqual([]);
  });

  it('pi-ai register-builtins populated the registry with INERT lazy closures (populated-but-unused, not a leak)', async () => {
    // The pi-ai barrel value-import fires register-builtins; the registry should
    // be populated. We OWN the loop's LLM path (custom streamFn), so the registry
    // is never consulted — populated-but-inert is the accepted contract.
    const ai = await import('@earendil-works/pi-ai');
    const providers = ai.getApiProviders();
    expect(Array.isArray(providers)).toBe(true);
    // It is populated (9 chat apis registered) — proving the import really ran
    // register-builtins, and that population is the inert side effect we accept.
    expect(providers.length).toBeGreaterThan(0);
  });
});
