/**
 * T11944 — the resolver DEFAULT model derives from `models_catalog` (release_date
 * DESC) via the T11737 chokepoint, with the static literal kept as the OFFLINE-ONLY
 * floor when the catalog yields nothing.
 *
 * The canonical global `cleo.db` is resolved from `XDG_DATA_HOME` / `CLEO_HOME`,
 * which we point at a fresh tmpdir per test (mirrors `system-resolver.test.ts`), so
 * seeding the canonical global DB is what the resolver consults. NO network.
 *
 * @task T11944
 * @epic T11694
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CuratedCatalog } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../../store/dual-scope-db.js';
import { _resetCatalogResolverCache } from '../catalog-resolver.js';
import { seedModelsCatalog } from '../catalog-seeder.js';
import { IMPLICIT_FALLBACK_MODEL } from '../role-resolver.js';
import { resolveLLMForSystem } from '../system-resolver.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_HOME',
  'HOME',
  'CLEO_DIR',
  'CLEO_DATA_DIR',
];

let xdgRoot: string;
let projectRoot: string;

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

beforeEach(() => {
  saveEnv();
  for (const k of ENV_KEYS) delete process.env[k];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  xdgRoot = join(tmpdir(), `cleo-rcd-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-rcd-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-rcd-home-${stamp}`);
  projectRoot = join(tmpdir(), `cleo-rcd-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  // Point the disk-cache dir at an empty temp dir so the chokepoint has NO disk
  // cache to fall back to (forces table → seed only).
  process.env['CLEO_DATA_DIR'] = join(xdgRoot, 'data-empty');
  mkdirSync(process.env['CLEO_DATA_DIR'], { recursive: true });
  _resetCleoPlatformPathsCache();
  _resetDualScopeDbCache();
  _resetCatalogResolverCache();
});

afterEach(() => {
  _resetDualScopeDbCache();
  _resetCatalogResolverCache();
  restoreEnv();
  _resetCleoPlatformPathsCache();
  try {
    rmSync(xdgRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Two anthropic models with differing release_date — newer should win. */
function twoAnthropic(newerId: string, newerDate: string): CuratedCatalog {
  return {
    version: '1.0.0',
    lastUpdated: '2026-06-09',
    providers: {
      anthropic: { id: 'anthropic', endpoint: 'https://api.anthropic.com', authTypes: ['api_key'] },
    },
    models: {
      anthropic: {
        'claude-older-haiku': {
          id: 'claude-older-haiku',
          name: 'Older',
          family: 'claude',
          attachment: false,
          reasoning: false,
          temperature: true,
          interleaved: false,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: {},
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: '2024-06-01',
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
        [newerId]: {
          id: newerId,
          name: 'Newer',
          family: 'claude',
          attachment: true,
          reasoning: true,
          temperature: true,
          interleaved: true,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          cost: {},
          limit: { context: 200000, output: 64000 },
          status: 'stable',
          release_date: newerDate,
          provider: { npm: '@anthropic-ai/sdk', api: 'anthropic_messages' },
        },
      },
    },
  };
}

describe('resolver default ← models_catalog (T11944)', () => {
  it('seeded table with two anthropic rows → default is the NEWER release_date model', async () => {
    // Seed the canonical global cleo.db (resolved from the tmpdir XDG env).
    const handle = await openDualScopeDb('global');
    await seedModelsCatalog({
      db: handle.db,
      catalog: twoAnthropic('claude-opus-9-9-20991231', '2099-12-31'),
    });
    _resetCatalogResolverCache();

    // No credential / no role config → implicit-fallback → upgradeCatalogDefault runs.
    const result = await resolveLLMForSystem('default', { projectRoot });
    expect(result.source).toBe('implicit-fallback');
    expect(result.provider).toBe('anthropic');
    // The catalog SSoT (release_date DESC) drove the default — NOT the hardcoded
    // `claude-haiku-4-5` literal.
    expect(result.model).toBe('claude-opus-9-9-20991231');
    expect(result.model).not.toBe(IMPLICIT_FALLBACK_MODEL);
  }, 30_000);

  it('OFFLINE FLOOR: empty table + empty disk cache → degrade does NOT break (resolves from the shipped seed, not a crash)', async () => {
    // Open (migrate) the global DB but do NOT seed — table empty; cache dir empty.
    await openDualScopeDb('global');
    _resetCatalogResolverCache();

    const result = await resolveLLMForSystem('default', { projectRoot });
    // Degrade path is exercised and a model is resolved (fresh/offline install does
    // NOT crash). The shipped seed is the offline floor; the chokepoint still yields
    // a catalog-driven anthropic id rather than throwing.
    expect(result.source).toBe('implicit-fallback');
    expect(result.provider).toBe('anthropic');
    expect(typeof result.model).toBe('string');
    expect(result.model.length).toBeGreaterThan(0);
  }, 30_000);

  it('skipCatalogDefault=true keeps the raw IMPLICIT_FALLBACK_MODEL literal (no catalog consulted)', async () => {
    const handle = await openDualScopeDb('global');
    await seedModelsCatalog({
      db: handle.db,
      catalog: twoAnthropic('claude-opus-9-9-20991231', '2099-12-31'),
    });
    _resetCatalogResolverCache();

    const result = await resolveLLMForSystem('default', { projectRoot, skipCatalogDefault: true });
    expect(result.source).toBe('implicit-fallback');
    // The catalog is intentionally NOT consulted → the frozen literal survives.
    expect(result.model).toBe(IMPLICIT_FALLBACK_MODEL);
  }, 30_000);
});
