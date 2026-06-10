/**
 * Tests for cantbook stage LLM-profile resolution (T11759 · M4).
 *
 * Exercises the {@link resolveCantbookNodeProfile} seam the production cantbook
 * dispatchers call: a `.cantbook` agentic stage's `profile:` is resolved through
 * the E9 chokepoint (`resolveLLMForSystem`) keyed by the cantbook node identity
 * (`cantbook:<playbook>#<nodeId>`), with the named profile pinned.
 *
 * Filesystem isolation mirrors `system-resolver.test.ts` — a fresh tmpdir per
 * test backing XDG/HOME, a project-local `.cleo/config.json` seeded with the
 * `llm` block, env restored in `afterEach`. No live backend is reached: every
 * assertion is over the RESOLVED metadata (provider/model/source/system key),
 * never a wire round-trip.
 *
 * @task T11759
 * @epic T10403
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cantbookNodeSystemKey,
  hasCantbookProfilePin,
  resolveCantbookNodeProfile,
} from '../../playbooks/cantbook-profile.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import { _resetPermsWarningForTests, _resetRoundRobinForTests } from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';

// ---------------------------------------------------------------------------
// Environment isolation (mirrors system-resolver.test.ts)
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_HOME',
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

function isolate(): { projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-cbp-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-cbp-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-cbp-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-cbp-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  return { projectRoot };
}

function seedProjectConfig(projectRoot: string, llm: unknown): void {
  writeFileSync(
    join(projectRoot, '.cleo', 'config.json'),
    JSON.stringify({ llm }, null, 2),
    'utf-8',
  );
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

// ---------------------------------------------------------------------------
// cantbookNodeSystemKey — the AC2 identity encoding
// ---------------------------------------------------------------------------

describe('T11759: cantbookNodeSystemKey', () => {
  it('encodes cantbook:<playbook>#<nodeId>', () => {
    expect(cantbookNodeSystemKey('rcasd', 'architect')).toBe('cantbook:rcasd#architect');
  });
});

describe('T11759: hasCantbookProfilePin', () => {
  it('is false for an empty pin', () => {
    expect(hasCantbookProfilePin({})).toBe(false);
  });
  it('is true when any of profile/model/provider is set', () => {
    expect(hasCantbookProfilePin({ profile: 'x' })).toBe(true);
    expect(hasCantbookProfilePin({ model: 'm' })).toBe(true);
    expect(hasCantbookProfilePin({ provider: 'anthropic' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveCantbookNodeProfile — resolution through the E9 chokepoint
// ---------------------------------------------------------------------------

describe('T11759: resolveCantbookNodeProfile', () => {
  it('AC2: a node `profile:` pin resolves the named profile through E9 (profile wins)', async () => {
    const { projectRoot } = isolate();
    // The background role (task-executor → judgement) is configured to a DIFFERENT
    // model; the named profile MUST win so the stage pin is honored, NOT the role.
    seedProjectConfig(projectRoot, {
      roles: { judgement: { provider: 'anthropic', model: 'role-default-model' } },
      profiles: {
        'frontier-review': { provider: 'anthropic', model: 'pinned-frontier-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-cbp';

    const resolved = await resolveCantbookNodeProfile({
      playbookName: 'review-flow',
      nodeId: 'review',
      pin: { profile: 'frontier-review' },
      projectRoot,
    });

    // The cantbook node identity is the system the resolution was keyed under.
    expect(resolved.system).toBe('task-executor');
    // The named profile won over the role default (AC2: pin honored).
    expect(resolved.source).toBe('profile');
    expect(resolved.model).toBe('pinned-frontier-model');
    expect(resolved.provider).toBe('anthropic');
  });

  it('AC2: with no profile pin, the cantbook system key drives the llm.systems[key] tier', async () => {
    const { projectRoot } = isolate();
    const systemKey = cantbookNodeSystemKey('review-flow', 'review');
    // No `roles.judgement` inline tuple — so the explicit-arg lane is empty and
    // resolution reaches the `systems[key]` granular-override tier (which sits
    // below the role tier but above the global default).
    seedProjectConfig(projectRoot, {
      systems: {
        [systemKey]: { provider: 'anthropic', model: 'per-stage-system-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-cbp';

    // No `profile` pin — but the dispatcher still resolves because the node
    // declared an inline `model`/`provider` (hasCantbookProfilePin is true).
    const resolved = await resolveCantbookNodeProfile({
      playbookName: 'review-flow',
      nodeId: 'review',
      pin: { model: 'inline-hint', provider: 'anthropic' },
      projectRoot,
    });

    // The `llm.systems[cantbook:review-flow#review]` granular tier resolved.
    expect(resolved.source).toBe('system');
    expect(resolved.model).toBe('per-stage-system-model');
  });

  it('falls through unchanged when the named profile is unknown', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: { judgement: { provider: 'anthropic', model: 'role-default-model' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-cbp';

    const resolved = await resolveCantbookNodeProfile({
      playbookName: 'review-flow',
      nodeId: 'review',
      pin: { profile: 'does-not-exist' },
      projectRoot,
    });

    // Unknown profile → no pin tier hit → the role default resolves.
    expect(resolved.source).toBe('role');
    expect(resolved.model).toBe('role-default-model');
  });

  it('never throws — returns a null-credential envelope when nothing is configured', async () => {
    const { projectRoot } = isolate();
    // No config, no key — resolution lands on the implicit fallback.
    const resolved = await resolveCantbookNodeProfile({
      playbookName: 'p',
      nodeId: 'n',
      pin: { profile: 'whatever' },
      projectRoot,
    });
    expect(resolved.source).toBe('implicit-fallback');
    expect(resolved.credential).toBeNull();
  });
});
