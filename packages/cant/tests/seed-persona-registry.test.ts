/**
 * Regression tests — T1210 · seed persona registry hardening.
 *
 * Verifies that:
 *  1. The `packages/agents/` layout is canonical (no duplicate subdirectory).
 *  2. `loadSeedAgentIdentities()` returns valid `PeerIdentity[]` from the
 *     `packages/agents/seed-agents/` generic templates + universal base.
 *  3. `cleo-subagent` (universal base) is always present and resolvable.
 *  4. All 7 CLEO project-tier seed personas exist in `.cleo/cant/agents/` —
 *     these are the agents the classifier routes tasks to and that
 *     `cleo orchestrate spawn` resolves. This is the regression guard against
 *     E_AGENT_NOT_FOUND for known personas.
 *  5. An unknown persona ID is NOT present (structured absence, not an error).
 *  6. `isPeerIdentity` / `assertPeerIdentity` validators from `@cleocode/contracts`
 *     work correctly on well-formed and malformed records.
 *
 * Architecture (ADR-055 / T1237):
 *  - `packages/agents/seed-agents/` — generic `{{variable}}` templates (not
 *    project-specific). The 4 generic templates ship here.
 *  - `packages/agents/cleo-subagent.cant` — universal protocol base (one file
 *    at root, no subdirectory).
 *  - `.cleo/cant/agents/` — project-tier CLEO-specific personas (cleo-prime,
 *    cleo-dev, cleo-db-lead, cleo-historian, cleo-rust-lead, cleo-subagent [via
 *    resolver], cleoos-opus-orchestrator). These are the 7 personas the
 *    classifier routes to.
 *
 * Post-T1210 contract:
 *  - ONE `cleo-subagent.cant` at `packages/agents/` root.
 *  - NO `packages/agents/cleo-subagent/` subdirectory.
 *  - NO standalone `AGENT.md` in seed-agents/ (content is in .cant).
 *
 * @task T1210
 * @epic T1144
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPeerIdentity,
  filterPeerIdentities,
  isPeerIdentity,
} from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  loadSeedAgentIdentities,
  SEED_PERSONA_IDS,
} from '../src/native-loader.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `packages/agents/` root relative to this test file.
 * Works for both `packages/cant/tests/` (source) and `packages/cant/dist/` (compiled).
 */
function resolveAgentsRoot(): string {
  return resolve(THIS_DIR, '..', '..', 'agents');
}

/**
 * Resolve `.cleo/cant/agents/` root (project-tier CLEO personas).
 * These are NOT shipped in the npm package but live in the project repo.
 */
function resolveProjectTierAgentsDir(): string {
  return resolve(THIS_DIR, '..', '..', '..', '.cleo', 'cant', 'agents');
}

const AGENTS_ROOT = resolveAgentsRoot();
const SEED_AGENTS_DIR = join(AGENTS_ROOT, 'seed-agents');
const UNIVERSAL_BASE = join(AGENTS_ROOT, 'cleo-subagent.cant');
const PROJECT_AGENTS_DIR = resolveProjectTierAgentsDir();

// ---------------------------------------------------------------------------
// 1. Filesystem layout contract (packages/agents/)
// ---------------------------------------------------------------------------

describe('packages/agents/ layout (T1210 — consolidated)', () => {
  it('packages/agents/ root exists', () => {
    expect(existsSync(AGENTS_ROOT), `agents root not found at: ${AGENTS_ROOT}`).toBe(true);
  });

  it('cleo-subagent.cant exists at root level (universal base)', () => {
    expect(existsSync(UNIVERSAL_BASE), `universal base missing: ${UNIVERSAL_BASE}`).toBe(true);
  });

  it('packages/agents/seed-agents/ directory exists', () => {
    expect(existsSync(SEED_AGENTS_DIR), `seed-agents dir missing: ${SEED_AGENTS_DIR}`).toBe(true);
  });

  it('packages/agents/cleo-subagent/ subdirectory does NOT exist (removed by T1210)', () => {
    const subdir = join(AGENTS_ROOT, 'cleo-subagent');
    expect(
      existsSync(subdir),
      `Duplicate cleo-subagent/ subdirectory still exists at: ${subdir}. T1210 requires only cleo-subagent.cant at root.`,
    ).toBe(false);
  });

  it('packages/agents/cleo-subagent/AGENT.md does NOT exist (content folded into .cant)', () => {
    const agentMd = join(AGENTS_ROOT, 'cleo-subagent', 'AGENT.md');
    expect(existsSync(agentMd), `Legacy AGENT.md still at: ${agentMd}`).toBe(false);
  });

  it('seed-agents/ contains no standalone AGENT.md files (only .cant + README.md)', () => {
    const entries = existsSync(SEED_AGENTS_DIR) ? readdirSync(SEED_AGENTS_DIR) : [];
    const stray = entries.filter((e) => e.endsWith('.md') && e !== 'README.md');
    expect(stray, `Standalone AGENT.md files found in seed-agents/: ${stray.join(', ')}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. loadSeedAgentIdentities — basic contract
// ---------------------------------------------------------------------------

describe('loadSeedAgentIdentities()', () => {
  it('returns an array', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns at least 1 entry (universal base alone is sufficient)', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('every entry passes isPeerIdentity validation', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    for (const entry of result) {
      expect(
        isPeerIdentity(entry),
        `Entry ${JSON.stringify(entry)} failed isPeerIdentity`,
      ).toBe(true);
    }
  });

  it('includes cleo-subagent (universal base)', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    const ids = result.map((p) => p.peerId);
    expect(ids).toContain('cleo-subagent');
  });

  it('gracefully returns [] when agentsRoot does not exist', () => {
    const result = loadSeedAgentIdentities('/does-not-exist-xyz-1234');
    expect(result).toEqual([]);
  });

  it('never throws for a valid agentsRoot', () => {
    expect(() => loadSeedAgentIdentities(AGENTS_ROOT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. SEED_PERSONA_IDS constant
// ---------------------------------------------------------------------------

describe('SEED_PERSONA_IDS constant', () => {
  it('has exactly 7 entries', () => {
    expect(SEED_PERSONA_IDS).toHaveLength(7);
  });

  it('contains all 7 expected persona IDs', () => {
    const expected = [
      'cleo-prime',
      'cleo-dev',
      'cleo-db-lead',
      'cleo-historian',
      'cleo-rust-lead',
      'cleo-subagent',
      'cleoos-opus-orchestrator',
    ];
    for (const id of expected) {
      expect(
        (SEED_PERSONA_IDS as readonly string[]).includes(id),
        `SEED_PERSONA_IDS missing: ${id}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Project-tier personas — the 7 classifier targets
//
// These personas live in .cleo/cant/agents/ (NOT in packages/agents/).
// They are the regression guard against E_AGENT_NOT_FOUND from orchestration.
// ---------------------------------------------------------------------------

describe('project-tier personas (.cleo/cant/agents/) — E_AGENT_NOT_FOUND regression', () => {
  const CLASSIFIER_PERSONAS = [
    'cleo-prime',
    'cleo-dev',
    'cleo-db-lead',
    'cleo-historian',
    'cleo-rust-lead',
    'cleoos-opus-orchestrator',
  ] as const;

  it('.cleo/cant/agents/ directory exists', () => {
    expect(
      existsSync(PROJECT_AGENTS_DIR),
      `.cleo/cant/agents/ missing at: ${PROJECT_AGENTS_DIR}`,
    ).toBe(true);
  });

  for (const personaId of CLASSIFIER_PERSONAS) {
    it(`${personaId}.cant exists in project-tier agents dir`, () => {
      const cantFile = join(PROJECT_AGENTS_DIR, `${personaId}.cant`);
      expect(
        existsSync(cantFile),
        `Persona ${personaId} missing: ${cantFile}. This will cause E_AGENT_NOT_FOUND in orchestrate spawn.`,
      ).toBe(true);
    });
  }

  it('cleo-subagent is resolvable via universal base in packages/agents/', () => {
    // cleo-subagent resolves via the universal tier (packages/agents/cleo-subagent.cant)
    // not via a project-tier file. Universal base guarantees it never 404s.
    expect(existsSync(UNIVERSAL_BASE)).toBe(true);
  });

  it('no persona in SEED_PERSONA_IDS triggers E_AGENT_NOT_FOUND (structural check)', () => {
    // All 6 classifier personas (excl. cleo-subagent) must have a project-tier file.
    // cleo-subagent is covered by the universal base (above).
    const missing: string[] = [];
    for (const id of SEED_PERSONA_IDS) {
      if (id === 'cleo-subagent') continue; // covered by universal base
      const cantFile = join(PROJECT_AGENTS_DIR, `${id}.cant`);
      if (!existsSync(cantFile)) missing.push(id);
    }
    expect(
      missing,
      `These personas are missing from .cleo/cant/agents/ and will produce E_AGENT_NOT_FOUND: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Unknown persona — structured absence
// ---------------------------------------------------------------------------

describe('unknown persona handling', () => {
  it('loadSeedAgentIdentities does NOT include unknown-persona-xyz', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    const ids = result.map((p) => p.peerId);
    expect(ids).not.toContain('unknown-persona-xyz');
  });

  it('result.find() for unknown persona returns undefined (not an error)', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    const found = result.find((p) => p.peerId === 'not-a-real-persona');
    expect(found).toBeUndefined();
  });

  it('unknown persona .cant file does not exist in project-tier dir', () => {
    const cantFile = join(PROJECT_AGENTS_DIR, 'totally-unknown-persona.cant');
    expect(existsSync(cantFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. PeerIdentity validators from @cleocode/contracts
// ---------------------------------------------------------------------------

describe('isPeerIdentity()', () => {
  it('accepts a valid PeerIdentity', () => {
    const valid = {
      peerId: 'cleo-dev',
      peerKind: 'lead' as const,
      cantFile: '/some/path/cleo-dev.cant',
      displayName: 'cleo-dev',
      description: 'General purpose development lead',
    };
    expect(isPeerIdentity(valid)).toBe(true);
  });

  it('rejects missing peerId', () => {
    expect(
      isPeerIdentity({ peerKind: 'lead', cantFile: '/x.cant', displayName: 'x', description: '' }),
    ).toBe(false);
  });

  it('rejects empty peerId', () => {
    expect(
      isPeerIdentity({ peerId: '', peerKind: 'lead', cantFile: '/x.cant', displayName: 'x', description: '' }),
    ).toBe(false);
  });

  it('rejects invalid peerKind', () => {
    expect(
      isPeerIdentity({ peerId: 'x', peerKind: 'robot', cantFile: '/x.cant', displayName: 'x', description: '' }),
    ).toBe(false);
  });

  it('rejects empty cantFile', () => {
    expect(
      isPeerIdentity({ peerId: 'x', peerKind: 'worker', cantFile: '', displayName: 'x', description: '' }),
    ).toBe(false);
  });

  it('rejects null', () => {
    expect(isPeerIdentity(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isPeerIdentity('cleo-dev')).toBe(false);
  });

  it('accepts all 4 valid peerKind values', () => {
    const base = { peerId: 'x', cantFile: '/x.cant', displayName: 'x', description: '' };
    for (const kind of ['orchestrator', 'lead', 'worker', 'subagent'] as const) {
      expect(isPeerIdentity({ ...base, peerKind: kind })).toBe(true);
    }
  });
});

describe('assertPeerIdentity()', () => {
  it('does not throw for a valid PeerIdentity', () => {
    expect(() =>
      assertPeerIdentity({
        peerId: 'cleo-prime',
        peerKind: 'orchestrator',
        cantFile: '/x.cant',
        displayName: 'cleo-prime',
        description: '',
      }),
    ).not.toThrow();
  });

  it('throws TypeError for an invalid value', () => {
    expect(() =>
      assertPeerIdentity({ peerId: '', peerKind: 'bad', cantFile: '', displayName: '' }),
    ).toThrow(TypeError);
  });
});

describe('filterPeerIdentities()', () => {
  it('returns only valid entries from a mixed array', () => {
    const mixed: unknown[] = [
      { peerId: 'ok', peerKind: 'worker', cantFile: '/x.cant', displayName: 'ok', description: '' },
      { peerId: '', peerKind: 'bad', cantFile: '', displayName: '' },
      null,
      42,
      {
        peerId: 'also-ok',
        peerKind: 'lead',
        cantFile: '/y.cant',
        displayName: 'also-ok',
        description: 'desc',
      },
    ];
    const result = filterPeerIdentities(mixed);
    expect(result).toHaveLength(2);
    expect(result[0]?.peerId).toBe('ok');
    expect(result[1]?.peerId).toBe('also-ok');
  });
});

// ---------------------------------------------------------------------------
// 7. PeerIdentity shape contract on loaded identities
// ---------------------------------------------------------------------------

describe('PeerIdentity shape — loaded from seed-agents/', () => {
  it('cleo-subagent (universal base) has peerKind "subagent" or "worker"', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    const subagent = result.find((p) => p.peerId === 'cleo-subagent');
    expect(subagent, 'cleo-subagent identity not found in loadSeedAgentIdentities()').toBeDefined();
    expect(['subagent', 'worker']).toContain(subagent?.peerKind);
  });

  it('every loaded identity has a non-empty cantFile path', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    for (const entry of result) {
      expect(entry.cantFile.length, `cantFile empty for ${entry.peerId}`).toBeGreaterThan(0);
    }
  });

  it('every loaded identity has a non-empty peerId', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    for (const entry of result) {
      expect(entry.peerId.length, 'peerId must not be empty').toBeGreaterThan(0);
    }
  });

  it('cantFile paths point to actually-existing files', () => {
    const result = loadSeedAgentIdentities(AGENTS_ROOT);
    for (const entry of result) {
      expect(
        existsSync(entry.cantFile),
        `cantFile does not exist on disk: ${entry.cantFile} (for ${entry.peerId})`,
      ).toBe(true);
    }
  });
});
