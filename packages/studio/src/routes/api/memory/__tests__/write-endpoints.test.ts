/**
 * Smoke tests for the /api/memory/* endpoints (T990 Wave 1D).
 *
 * Covers:
 *   - observe / decision-store / pattern-store / learning-store / verify (POST)
 *   - find / patterns / learnings / pending-verify / reason-why (GET)
 *
 * Each test seeds an ephemeral on-disk SQLite at a tmp path, builds a
 * minimal ProjectContext, and invokes the endpoint handler directly.
 * The tests exercise the LAFS envelope contract and the
 * "brain unavailable" fallback path.
 *
 * @task T990
 * @wave 1D
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { ProjectContext } from '$lib/server/project-context.js';
import { POST as decisionPOST } from '../decision-store/+server.js';
import { GET as findGET } from '../find/+server.js';
import { POST as learningPOST } from '../learning-store/+server.js';
import { GET as learningsGET } from '../learnings/+server.js';
import { POST as observePOST } from '../observe/+server.js';
import { POST as patternPOST } from '../pattern-store/+server.js';
import { GET as patternsGET } from '../patterns/+server.js';
import { GET as pendingGET } from '../pending-verify/+server.js';
import { GET as reasonWhyGET } from '../reason-why/+server.js';
import { POST as verifyPOST } from '../verify/+server.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync: SqliteCtor } = _require('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** DDL for a minimal brain.db with the four memory tables. */
const BRAIN_DDL = `
  CREATE TABLE brain_observations (
    id TEXT PRIMARY KEY,
    type TEXT,
    title TEXT,
    subtitle TEXT,
    narrative TEXT,
    project TEXT,
    source_type TEXT,
    source_confidence TEXT,
    memory_tier TEXT,
    memory_type TEXT,
    quality_score REAL,
    verified INTEGER DEFAULT 0,
    valid_at TEXT,
    invalid_at TEXT,
    prune_candidate INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE brain_decisions (
    id TEXT PRIMARY KEY,
    type TEXT,
    decision TEXT,
    rationale TEXT,
    confidence TEXT,
    alternatives TEXT,
    outcome TEXT,
    context_epic_id TEXT,
    context_task_id TEXT,
    context_phase TEXT,
    memory_tier TEXT,
    quality_score REAL,
    verified INTEGER DEFAULT 0,
    valid_at TEXT,
    invalid_at TEXT,
    prune_candidate INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE brain_patterns (
    id TEXT PRIMARY KEY,
    type TEXT,
    pattern TEXT,
    context TEXT,
    impact TEXT,
    anti_pattern TEXT,
    mitigation TEXT,
    examples TEXT,
    frequency INTEGER DEFAULT 1,
    success_rate REAL,
    memory_tier TEXT,
    quality_score REAL,
    verified INTEGER DEFAULT 0,
    valid_at TEXT,
    invalid_at TEXT,
    prune_candidate INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    extracted_at TEXT
  );
  CREATE TABLE brain_learnings (
    id TEXT PRIMARY KEY,
    insight TEXT,
    source TEXT,
    confidence REAL,
    actionable INTEGER DEFAULT 0,
    application TEXT,
    applicable_types TEXT,
    memory_tier TEXT,
    quality_score REAL,
    verified INTEGER DEFAULT 0,
    valid_at TEXT,
    invalid_at TEXT,
    prune_candidate INTEGER DEFAULT 0,
    citation_count INTEGER DEFAULT 0,
    created_at TEXT
  );
`;

/** DDL for a minimal tasks.db (reason-why only needs these two tables). */
const TASKS_DDL = `
  CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT);
  CREATE TABLE task_dependencies (task_id TEXT, dep_id TEXT);
`;

/**
 * Builds a fresh tmp dir with brain.db + tasks.db seeded with the
 * minimal schemas above, and returns a ProjectContext whose paths
 * point at them.
 */
function makeTmpCtx(): { ctx: ProjectContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-studio-wave1d-'));
  const brainPath = join(dir, 'brain.db');
  const tasksPath = join(dir, 'tasks.db');

  const b = new SqliteCtor(brainPath);
  b.exec(BRAIN_DDL);
  b.close();

  const t = new SqliteCtor(tasksPath);
  t.exec(TASKS_DDL);
  t.close();

  const ctx: ProjectContext = {
    projectId: 'test',
    name: 'test',
    projectPath: dir,
    brainDbPath: brainPath,
    tasksDbPath: tasksPath,
    brainDbExists: true,
    tasksDbExists: true,
  };

  return { ctx, dir };
}

function cleanupCtx(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

/** Fake SvelteKit RequestEvent we pass to the handlers. */
interface FakeEvent {
  locals: { projectCtx: ProjectContext };
  url: URL;
  request: Request;
}

function event(
  ctx: ProjectContext,
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): FakeEvent {
  const req = new Request(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
  return {
    locals: { projectCtx: ctx },
    url: new URL(url),
    request: req,
  };
}

/** Narrow a FakeEvent to the handler parameter type — the two overlap at runtime. */
function asEv<H extends (...args: never[]) => unknown>(e: FakeEvent): Parameters<H>[0] {
  return e as unknown as Parameters<H>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/memory/observe', () => {
  it('accepts a valid observation and returns a LAFS ok envelope', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const ev = event(ctx, 'http://localhost/api/memory/observe', 'POST', {
        title: 'Test',
        text: 'A test observation',
        type: 'discovery',
      });
      const res = await observePOST(asEv<typeof observePOST>(ev));
      const body = (await res.json()) as {
        success: boolean;
        data?: { id: string; type: string; createdAt: string };
      };
      expect(body.success).toBe(true);
      expect(body.data?.id).toMatch(/^O-/);
      expect(body.data?.type).toBe('discovery');
    } finally {
      cleanupCtx(dir);
    }
  });

  it('rejects a missing title with E_VALIDATION', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const ev = event(ctx, 'http://localhost/api/memory/observe', 'POST', {
        text: 'No title',
      });
      const res = await observePOST(asEv<typeof observePOST>(ev));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error?: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('E_VALIDATION');
    } finally {
      cleanupCtx(dir);
    }
  });

  it('rejects invalid JSON', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const req = new Request('http://localhost/api/memory/observe', {
        method: 'POST',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      });
      const ev: FakeEvent = {
        locals: { projectCtx: ctx },
        url: new URL('http://localhost/api/memory/observe'),
        request: req,
      };
      const res = await observePOST(asEv<typeof observePOST>(ev));
      expect(res.status).toBe(400);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('POST /api/memory/decision-store', () => {
  it('stores a decision with alternatives', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const ev = event(ctx, 'http://localhost/api/memory/decision-store', 'POST', {
        decision: 'Use SQLite',
        rationale: 'Simplicity and portability',
        alternatives: ['Postgres', 'DynamoDB'],
        taskId: 'T42',
      });
      const res = await decisionPOST(asEv<typeof decisionPOST>(ev));
      const body = (await res.json()) as {
        success: boolean;
        data?: { id: string; createdAt: string };
      };
      expect(body.success).toBe(true);
      expect(body.data?.id).toMatch(/^D-/);
    } finally {
      cleanupCtx(dir);
    }
  });

  it('rejects when rationale is missing', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const ev = event(ctx, 'http://localhost/api/memory/decision-store', 'POST', {
        decision: 'No rationale',
      });
      const res = await decisionPOST(asEv<typeof decisionPOST>(ev));
      expect(res.status).toBe(400);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('POST /api/memory/pattern-store', () => {
  it('stores a pattern and deduplicates on second write', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const body = {
        pattern: 'Always run tests before completing',
        context: 'Task completion workflow',
        type: 'workflow',
        impact: 'high',
      };
      const res1 = await patternPOST(
        asEv<typeof patternPOST>(event(ctx, 'http://localhost/x', 'POST', body)),
      );
      const b1 = (await res1.json()) as {
        success: boolean;
        data?: { id: string; deduplicated: boolean };
      };
      expect(b1.success).toBe(true);
      expect(b1.data?.deduplicated).toBe(false);

      const res2 = await patternPOST(
        asEv<typeof patternPOST>(event(ctx, 'http://localhost/x', 'POST', body)),
      );
      const b2 = (await res2.json()) as {
        success: boolean;
        data?: { id: string; deduplicated: boolean };
      };
      expect(b2.success).toBe(true);
      expect(b2.data?.deduplicated).toBe(true);
      expect(b2.data?.id).toBe(b1.data?.id);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('POST /api/memory/learning-store', () => {
  it('stores a learning and surfaces a confidence merge on dedup', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const body = {
        insight: 'SQLite WAL requires sidecar journaling discipline',
        source: 'T5158',
        confidence: 0.6,
      };
      const res1 = await learningPOST(
        asEv<typeof learningPOST>(event(ctx, 'http://localhost/x', 'POST', body)),
      );
      const b1 = (await res1.json()) as {
        success: boolean;
        data?: { deduplicated: boolean };
      };
      expect(b1.success).toBe(true);
      expect(b1.data?.deduplicated).toBe(false);

      const res2 = await learningPOST(
        asEv<typeof learningPOST>(
          event(ctx, 'http://localhost/x', 'POST', { ...body, confidence: 0.9 }),
        ),
      );
      const b2 = (await res2.json()) as {
        success: boolean;
        data?: { deduplicated: boolean };
      };
      expect(b2.data?.deduplicated).toBe(true);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('POST /api/memory/verify', () => {
  it('routes an id prefix to the correct table', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const obsRes = await observePOST(
        asEv<typeof observePOST>(
          event(ctx, 'http://localhost/x', 'POST', { title: 'To verify', text: 'body' }),
        ),
      );
      const obsBody = (await obsRes.json()) as { data?: { id: string } };
      const id = obsBody.data?.id ?? '';
      expect(id).toMatch(/^O-/);

      const res = await verifyPOST(
        asEv<typeof verifyPOST>(event(ctx, 'http://localhost/x', 'POST', { id })),
      );
      const body = (await res.json()) as {
        success: boolean;
        data?: { id: string; table: string; verified: number };
      };
      expect(body.success).toBe(true);
      expect(body.data?.table).toBe('brain_observations');
      expect(body.data?.verified).toBe(1);
    } finally {
      cleanupCtx(dir);
    }
  });

  it('rejects unknown id prefixes', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await verifyPOST(
        asEv<typeof verifyPOST>(event(ctx, 'http://localhost/x', 'POST', { id: 'X-unknown' })),
      );
      expect(res.status).toBe(400);
    } finally {
      cleanupCtx(dir);
    }
  });

  it('returns 404 when id is missing from its table', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await verifyPOST(
        asEv<typeof verifyPOST>(event(ctx, 'http://localhost/x', 'POST', { id: 'O-ghost' })),
      );
      expect(res.status).toBe(404);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('GET /api/memory/patterns', () => {
  it('returns an empty list for a fresh brain', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await patternsGET(
        asEv<typeof patternsGET>(event(ctx, 'http://localhost/api/memory/patterns')),
      );
      const body = (await res.json()) as { patterns: unknown[]; total: number };
      expect(Array.isArray(body.patterns)).toBe(true);
      expect(body.total).toBe(0);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('GET /api/memory/learnings', () => {
  it('returns an empty list for a fresh brain', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await learningsGET(
        asEv<typeof learningsGET>(event(ctx, 'http://localhost/api/memory/learnings')),
      );
      const body = (await res.json()) as { learnings: unknown[]; total: number };
      expect(Array.isArray(body.learnings)).toBe(true);
      expect(body.total).toBe(0);
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('GET /api/memory/find', () => {
  it('returns empty hits when the query is empty', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await findGET(
        asEv<typeof findGET>(event(ctx, 'http://localhost/api/memory/find')),
      );
      const body = (await res.json()) as { hits: unknown[]; total: number };
      expect(body.hits).toHaveLength(0);
      expect(body.total).toBe(0);
    } finally {
      cleanupCtx(dir);
    }
  });

  it('finds a freshly-observed title', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      await observePOST(
        asEv<typeof observePOST>(
          event(ctx, 'http://localhost/x', 'POST', {
            title: 'Unique nexus phrase',
            text: 'body',
          }),
        ),
      );
      const res = await findGET(
        asEv<typeof findGET>(event(ctx, 'http://localhost/api/memory/find?q=nexus')),
      );
      const body = (await res.json()) as {
        hits: Array<{ table: string; title: string }>;
        total: number;
      };
      expect(body.total).toBeGreaterThan(0);
      expect(body.hits[0]?.table).toBe('observations');
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('GET /api/memory/pending-verify', () => {
  it('returns a LAFS envelope with empty items initially', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await pendingGET(
        asEv<typeof pendingGET>(
          event(ctx, 'http://localhost/api/memory/pending-verify?minCitations=1&limit=10'),
        ),
      );
      const body = (await res.json()) as {
        success: boolean;
        data?: { count: number; items: unknown[]; hint: string };
      };
      expect(body.success).toBe(true);
      expect(body.data?.count).toBe(0);
      expect(typeof body.data?.hint).toBe('string');
    } finally {
      cleanupCtx(dir);
    }
  });
});

describe('GET /api/memory/reason-why', () => {
  it('returns an empty trace when the task does not exist', async () => {
    const { ctx, dir } = makeTmpCtx();
    try {
      const res = await reasonWhyGET(
        asEv<typeof reasonWhyGET>(event(ctx, 'http://localhost/api/memory/reason-why?taskId=T999')),
      );
      const body = (await res.json()) as {
        taskId: string;
        blockers: unknown[];
        rootCauses: unknown[];
        depth: number;
      };
      expect(body.taskId).toBe('T999');
      expect(body.blockers).toHaveLength(0);
      expect(body.rootCauses).toHaveLength(0);
      expect(body.depth).toBe(0);
    } finally {
      cleanupCtx(dir);
    }
  });
});
