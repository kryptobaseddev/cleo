/**
 * Unit tests for the T1239 {@link CoreAgentDispatcher} — 5-tier resolution
 * wrapper around the registry-backed 4-tier resolver.
 *
 * The tests focus on the meta-tier addition (filesystem-only, no DB) and on
 * the dispatcher's success/failure envelope semantics. The wrapped 4-tier
 * resolver has its own dedicated test suite at
 * `packages/core/src/store/__tests__/agent-resolver.test.ts`; we do not
 * duplicate that coverage here.
 *
 * @task T1239
 * @epic T1232
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TIER_META,
  CoreAgentDispatcher,
  createAgentDispatcher,
  type DispatchContext,
  resolveMetaAgent,
} from '../agent-dispatcher.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const META_ARCHITECT_CANT = `---
kind: agent
version: 2
---

agent agent-architect:
  role: specialist
  parent: cleo-prime
  description: "Meta-agent fixture"
  prompt: "You are agent-architect."
  skills: []
`;

interface TmpEnv {
  base: string;
  metaDir: string;
  emptyDbPath: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

/**
 * Create an isolated tmp workspace containing a synthetic `meta/` directory
 * and an empty sqlite file standing in for the global `signaldock.db`.
 *
 * The empty DB has the `agents` table created but no rows — so tier 2-5
 * resolution via the wrapped resolver all miss, letting the test focus on
 * the meta-tier behaviour.
 */
function makeTmpEnv(): TmpEnv {
  const base = mkdtempSync(join(tmpdir(), 'cleo-agent-dispatcher-'));
  const metaDir = join(base, 'meta');
  const emptyDbPath = join(base, 'signaldock-empty.db');

  mkdirSync(metaDir, { recursive: true });

  // Minimal agents table schema so `resolveAgent` doesn't crash. We only need
  // enough columns to satisfy SELECT + WHERE; the rows are always empty.
  const db = new DatabaseSync(emptyDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      class TEXT NOT NULL,
      privacy_tier TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      skills TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      api_key_encrypted TEXT,
      api_base_url TEXT NOT NULL,
      classification TEXT,
      transport_config TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tier TEXT,
      can_spawn INTEGER,
      orch_level INTEGER,
      reports_to TEXT,
      cant_path TEXT,
      cant_sha256 TEXT,
      installed_from TEXT,
      installed_at TEXT
    );
  `);
  db.close();

  const openDb = (): DatabaseSync => new DatabaseSync(emptyDbPath);
  const cleanup = (): void => {
    rmSync(base, { recursive: true, force: true });
  };
  return { base, metaDir, emptyDbPath, openDb, cleanup };
}

// ---------------------------------------------------------------------------
// Tests — resolveMetaAgent (pure helper)
// ---------------------------------------------------------------------------

describe('resolveMetaAgent (T1239)', () => {
  let env: TmpEnv;

  beforeEach(() => {
    env = makeTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('returns null when the meta-tier file does not exist', () => {
    const result = resolveMetaAgent('missing-meta-agent', env.metaDir);
    expect(result).toBeNull();
  });

  it('synthesises a ResolvedAgent envelope when the meta-tier file exists', () => {
    writeFileSync(join(env.metaDir, 'agent-architect.cant'), META_ARCHITECT_CANT, 'utf8');
    const result = resolveMetaAgent('agent-architect', env.metaDir);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe('agent-architect');
    expect(result?.cantPath).toBe(join(env.metaDir, 'agent-architect.cant'));
    expect(result?.cantSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.canSpawn).toBe(true);
  });

  it('returns null when the meta directory itself cannot be located', () => {
    // Pass an override that definitely does not exist.
    const result = resolveMetaAgent('anything', join(env.base, 'does-not-exist'));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — CoreAgentDispatcher
// ---------------------------------------------------------------------------

describe('CoreAgentDispatcher (T1239)', () => {
  let env: TmpEnv;

  beforeEach(() => {
    env = makeTmpEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  function makeContext(agentId: string): DispatchContext {
    return {
      runId: 'run-test',
      nodeId: 'node-test',
      agentId,
      taskId: 'task-test',
      context: {},
      iteration: 1,
    };
  }

  it('returns failure when no tier resolves the agent', async () => {
    const db = env.openDb();
    try {
      const dispatcher = new CoreAgentDispatcher({ db, metaDir: env.metaDir });
      const result = await dispatcher.dispatch(makeContext('definitely-not-here'));
      expect(result.status).toBe('failure');
      expect(result.error).toContain('not found');
    } finally {
      db.close();
    }
  });

  it('resolves meta-tier agents ahead of the wrapped resolver', async () => {
    writeFileSync(join(env.metaDir, 'agent-architect.cant'), META_ARCHITECT_CANT, 'utf8');

    const db = env.openDb();
    try {
      const dispatcher = new CoreAgentDispatcher({ db, metaDir: env.metaDir });
      const result = await dispatcher.dispatch(makeContext('agent-architect'));
      expect(result.status).toBe('success');
      expect(result.output['agent']).toBeDefined();
      const agent = result.output['agent'] as Record<string, unknown>;
      expect(agent['agentId']).toBe('agent-architect');
      // Meta-tier is signalled via the 5-tier `tier` field; `source` mirrors
      // the underlying ResolvedAgent contract ('fallback' for filesystem-only
      // resolutions).
      expect(agent['tier']).toBe(AGENT_TIER_META);
      expect(dispatcher.resolveTier('agent-architect')).toBe(AGENT_TIER_META);
    } finally {
      db.close();
    }
  });

  it('resolve() returns null without throwing on a miss', async () => {
    const db = env.openDb();
    try {
      const dispatcher = new CoreAgentDispatcher({ db, metaDir: env.metaDir });
      expect(dispatcher.resolve('also-missing')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('delegates to a custom executor when provided', async () => {
    writeFileSync(join(env.metaDir, 'agent-architect.cant'), META_ARCHITECT_CANT, 'utf8');
    const db = env.openDb();
    try {
      let executorCalls = 0;
      const dispatcher = new CoreAgentDispatcher({
        db,
        metaDir: env.metaDir,
        executor: async (agent) => {
          executorCalls++;
          return {
            status: 'success',
            output: { executed: true, agentId: agent.agentId },
          };
        },
      });
      const result = await dispatcher.dispatch(makeContext('agent-architect'));
      expect(executorCalls).toBe(1);
      expect(result.status).toBe('success');
      expect(result.output['executed']).toBe(true);
      expect(result.output['agentId']).toBe('agent-architect');
    } finally {
      db.close();
    }
  });

  it('catches executor exceptions and returns a failure envelope', async () => {
    writeFileSync(join(env.metaDir, 'agent-architect.cant'), META_ARCHITECT_CANT, 'utf8');
    const db = env.openDb();
    try {
      const dispatcher = new CoreAgentDispatcher({
        db,
        metaDir: env.metaDir,
        executor: async () => {
          throw new Error('boom');
        },
      });
      const result = await dispatcher.dispatch(makeContext('agent-architect'));
      expect(result.status).toBe('failure');
      expect(result.error).toBe('boom');
    } finally {
      db.close();
    }
  });

  it('invokes onResolve hook exactly once per successful resolution', async () => {
    writeFileSync(join(env.metaDir, 'agent-architect.cant'), META_ARCHITECT_CANT, 'utf8');
    const db = env.openDb();
    try {
      let calls = 0;
      const dispatcher = new CoreAgentDispatcher({
        db,
        metaDir: env.metaDir,
        onResolve: () => {
          calls++;
        },
      });
      await dispatcher.dispatch(makeContext('agent-architect'));
      expect(calls).toBe(1);
    } finally {
      db.close();
    }
  });

  it('createAgentDispatcher factory returns a ready-to-dispatch instance', async () => {
    const db = env.openDb();
    try {
      const dispatcher = createAgentDispatcher(db);
      expect(dispatcher).toBeInstanceOf(CoreAgentDispatcher);
    } finally {
      db.close();
    }
  });
});
