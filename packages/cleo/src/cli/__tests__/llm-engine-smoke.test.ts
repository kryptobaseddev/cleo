/**
 * End-to-end smoke test for the `cleo llm` engine surface (T9259).
 *
 * Named `llm-engine-smoke.test.ts` (not `*-integration.test.ts`) so the
 * default `pnpm test` sweep picks it up — the package vitest config excludes
 * the `*-integration.test.ts` / `*.integration.test.ts` patterns and routes
 * them through `pnpm run test:integration` instead.
 *
 * Where `llm-command.test.ts` mocks the engine and verifies the citty wiring,
 * this file does the opposite: it imports the real engine ops from
 * `@cleocode/core/internal` and walks them against a tmpdir-isolated
 * `XDG_DATA_HOME` + `HOME` so the multi-credential pool, the role-resolver,
 * and the redaction surface are all exercised without mocks.
 *
 * The flow under test mirrors the dispatch happy-path:
 *
 *   llmAdd('anthropic', 'sk-ant-api03-FIXTURE', label='fixture')
 *     → llmList('anthropic')                — fixture entry appears, token redacted
 *     → llmWhoami({})                       — envelope shape, one entry per role
 *     → llmRemove('anthropic', label='fixture') — entry gone
 *
 * Token redaction: every `tokenPreview` field MUST surface only the last 4
 * characters of the stored token (full token never appears in the envelope).
 *
 * @task T9259
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineResult } from '@cleocode/contracts';
import { llmAdd, llmList, llmRemove, llmWhoami } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  'HOME',
  'CLEO_DIR',
];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function isolate(): { xdgRoot: string; home: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-cli-xdg-${stamp}`);
  const home = join(tmpdir(), `cleo-cli-home-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['HOME'] = home;
  return { xdgRoot, home };
}

/** Narrow an `EngineResult<T>` to its success branch with a useful error if not. */
function unwrap<T>(result: EngineResult<T>): T {
  if (!result.success) {
    throw new Error(
      `Engine call failed: code=${result.code ?? 'unknown'} message=${result.message ?? '(none)'}`,
    );
  }
  return result.data;
}

beforeEach(() => {
  saveEnv();
  clearEnv();
});

afterEach(() => {
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Full add → list → whoami → remove flow
// ---------------------------------------------------------------------------

describe('cleo llm — engine smoke test (no mocks, real filesystem)', () => {
  it('add → list → whoami → remove round-trip with token redaction', async () => {
    isolate();
    const FIXTURE_TOKEN = 'sk-ant-api03-FIXTURE-INTEGRATION-SUFFIX';
    const EXPECTED_PREVIEW = `…${FIXTURE_TOKEN.slice(-4)}`;

    // 1. Add — credentials.json file is created, fixture is upserted.
    const addEnvelope = unwrap(
      await llmAdd({
        provider: 'anthropic',
        apiKey: FIXTURE_TOKEN,
        label: 'fixture',
      }),
    );
    expect(addEnvelope.detectedAuthType).toBe('api_key');
    expect(addEnvelope.credential.provider).toBe('anthropic');
    expect(addEnvelope.credential.label).toBe('fixture');
    expect(addEnvelope.credential.tokenPreview).toBe(EXPECTED_PREVIEW);
    // The full token must NOT leak through the envelope.
    expect(JSON.stringify(addEnvelope)).not.toContain(FIXTURE_TOKEN);

    // 2. List — fixture entry appears, token redacted.
    const listEnvelope = unwrap(await llmList({ provider: 'anthropic' }));
    expect(listEnvelope.credentials).toHaveLength(1);
    const [entry] = listEnvelope.credentials;
    expect(entry?.label).toBe('fixture');
    expect(entry?.tokenPreview).toBe(EXPECTED_PREVIEW);
    expect(JSON.stringify(listEnvelope)).not.toContain(FIXTURE_TOKEN);

    // 3. Whoami — envelope shape returns one entry per role; the fixture
    //    credential is now reachable for every role since it is the only
    //    anthropic entry.
    const whoamiEnvelope = unwrap(await llmWhoami({}));
    expect(whoamiEnvelope.entries).toHaveLength(5);
    const roles = whoamiEnvelope.entries.map((e) => e.role).sort();
    expect(roles).toEqual(
      ['consolidation', 'derivation', 'extraction', 'hygiene', 'judgement'].sort(),
    );
    for (const e of whoamiEnvelope.entries) {
      expect(e.hasCredential).toBe(true);
      expect(e.credentialSource).toBe('cred-file');
      expect(e.credentialLabel).toBe('fixture');
      expect(e.provider).toBe('anthropic');
    }
    expect(JSON.stringify(whoamiEnvelope)).not.toContain(FIXTURE_TOKEN);

    // 4. Remove — entry is gone, list returns empty.
    const removeEnvelope = unwrap(await llmRemove({ provider: 'anthropic', label: 'fixture' }));
    expect(removeEnvelope.removed).toBe(true);
    expect(removeEnvelope.provider).toBe('anthropic');
    expect(removeEnvelope.label).toBe('fixture');

    const listAfterRemove = unwrap(await llmList({ provider: 'anthropic' }));
    expect(listAfterRemove.credentials).toEqual([]);
  });

  it('add with sk-ant-oat-* prefix auto-detects authType=oauth', async () => {
    isolate();
    const FIXTURE_TOKEN = 'sk-ant-oat-01-FIXTURE-OAUTH';
    const env = unwrap(
      await llmAdd({
        provider: 'anthropic',
        apiKey: FIXTURE_TOKEN,
        label: 'oauth-fixture',
      }),
    );
    expect(env.detectedAuthType).toBe('oauth');
    expect(env.credential.authType).toBe('oauth');
    expect(env.credential.tokenPreview).toBe(`…${FIXTURE_TOKEN.slice(-4)}`);
  });

  it('remove with no matching label returns removed=false (no error)', async () => {
    isolate();
    await llmAdd({
      provider: 'anthropic',
      apiKey: 'sk-real-token',
      label: 'real',
    });
    const env = unwrap(await llmRemove({ provider: 'anthropic', label: 'ghost' }));
    expect(env.removed).toBe(false);
    // The real entry must still be there.
    const after = unwrap(await llmList({ provider: 'anthropic' }));
    expect(after.credentials).toHaveLength(1);
    expect(after.credentials[0]?.label).toBe('real');
  });

  it('whoami envelope shape — every entry carries provider/model/source even with no credential', async () => {
    isolate();
    // No add, no env, no claude-creds, no global / project config — every
    // role must still return an entry with hasCredential=false.
    const env = unwrap(await llmWhoami({}));
    expect(env.entries).toHaveLength(5);
    for (const e of env.entries) {
      expect(e.provider).toBe('anthropic');
      expect(typeof e.model).toBe('string');
      expect(e.model.length).toBeGreaterThan(0);
      expect(e.source).toBe('implicit-fallback');
      expect(e.hasCredential).toBe(false);
    }
  });

  it('list across providers segments correctly', async () => {
    isolate();
    await llmAdd({ provider: 'anthropic', apiKey: 'sk-ant-AAAA', label: 'a' });
    await llmAdd({ provider: 'openai', apiKey: 'sk-oai-BBBB', label: 'b' });

    const anth = unwrap(await llmList({ provider: 'anthropic' }));
    expect(anth.credentials.map((c) => c.label)).toEqual(['a']);

    const oai = unwrap(await llmList({ provider: 'openai' }));
    expect(oai.credentials.map((c) => c.label)).toEqual(['b']);

    const all = unwrap(await llmList({}));
    const labels = all.credentials.map((c) => c.label).sort();
    expect(labels).toEqual(['a', 'b']);
  });
});
