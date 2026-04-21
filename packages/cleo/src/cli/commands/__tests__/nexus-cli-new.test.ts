/**
 * Tests for T1013 / T1006 Nexus CLI additions:
 *   - `cleo nexus top-entries [--limit N] [--kind K]`
 *   - `cleo nexus impact <symbol> --why`
 *
 * We exercise both the Citty subcommand tree (shape + flag presence) and the
 * dispatch-layer handlers (`top-entries` + `impact`) directly against an
 * isolated nexus.db seeded via `CLEO_HOME`. Direct handler exercise is the
 * cheapest way to assert LAFS envelope shapes without launching a subprocess.
 *
 * The impact --why CLI test asserts that the BFS output carries `reasons[]`
 * path-strings per affected symbol and that `reasons` is absent from the
 * JSON envelope when the flag is not set (backward compat).
 *
 * @task T1013
 * @epic T1006
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getNexusDb,
  nexusSchema,
  resetNexusDbState,
} from '../../../../../core/src/store/nexus-sqlite.js';
import { NexusHandler } from '../../../dispatch/domains/nexus.js';
import { nexusCommand } from '../nexus.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Insert a test node into nexus_nodes. Returns the node id for ergonomics.
 */
function seedNode(
  db: Awaited<ReturnType<typeof getNexusDb>>,
  projectId: string,
  overrides: {
    id: string;
    kind: string;
    label: string;
    name?: string | null;
    filePath?: string | null;
  },
): string {
  db.insert(nexusSchema.nexusNodes)
    .values({
      id: overrides.id,
      projectId,
      kind: overrides.kind as never,
      label: overrides.label,
      name: overrides.name ?? overrides.label,
      filePath: overrides.filePath ?? 'src/example.ts',
      language: 'typescript',
      isExported: true,
      indexedAt: new Date().toISOString(),
    })
    .run();
  return overrides.id;
}

/**
 * Insert a test relation with optional `weight` (T998 plasticity column).
 */
function seedRelation(
  db: Awaited<ReturnType<typeof getNexusDb>>,
  projectId: string,
  overrides: {
    sourceId: string;
    targetId: string;
    type: 'calls' | 'imports' | 'accesses';
    weight?: number;
    coAccessedCount?: number;
  },
): void {
  db.insert(nexusSchema.nexusRelations)
    .values({
      id: randomUUID(),
      projectId,
      sourceId: overrides.sourceId,
      targetId: overrides.targetId,
      type: overrides.type,
      confidence: 1.0,
      weight: overrides.weight ?? 0,
      coAccessedCount: overrides.coAccessedCount ?? 0,
      indexedAt: new Date().toISOString(),
    })
    .run();
}

// ---------------------------------------------------------------------------
// Test lifecycle — isolate nexus.db via CLEO_HOME
// ---------------------------------------------------------------------------

let suiteDir: string;

beforeEach(async () => {
  suiteDir = await mkdtemp(join(tmpdir(), 'nexus-cli-new-test-'));
  mkdirSync(join(suiteDir, 'cleo-home'), { recursive: true });
  process.env['CLEO_HOME'] = join(suiteDir, 'cleo-home');
  resetNexusDbState();
});

afterEach(async () => {
  resetNexusDbState();
  delete process.env['CLEO_HOME'];
  await rm(suiteDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Group 1: Command tree + flag wiring
// ---------------------------------------------------------------------------

describe('nexus top-entries — CLI registration', () => {
  it('registers `top-entries` as a subcommand of `nexus`', () => {
    const sub = nexusCommand.subCommands?.['top-entries'];
    expect(sub).toBeDefined();
  });

  it('top-entries declares --limit and --kind flags', () => {
    const sub = nexusCommand.subCommands?.['top-entries'];
    expect(sub).toBeDefined();
    if (!sub) return;
    const argMap = sub.args as Record<string, Record<string, unknown>> | undefined;
    expect(argMap).toBeDefined();
    expect(argMap?.['limit']).toBeDefined();
    expect(argMap?.['kind']).toBeDefined();
    expect(argMap?.['json']).toBeDefined();
  });
});

describe('nexus impact — CLI --why flag', () => {
  it('impact command declares --why as a boolean flag', () => {
    const sub = nexusCommand.subCommands?.['impact'];
    expect(sub).toBeDefined();
    if (!sub) return;
    const argMap = sub.args as Record<string, Record<string, unknown>> | undefined;
    expect(argMap?.['why']).toBeDefined();
    expect(argMap?.['why']?.['type']).toBe('boolean');
  });

  it('--why description mentions "reasons" so operators discover the semantics', () => {
    const sub = nexusCommand.subCommands?.['impact'];
    if (!sub) return;
    const argMap = sub.args as Record<string, Record<string, unknown>> | undefined;
    const desc = String(argMap?.['why']?.['description'] ?? '').toLowerCase();
    expect(desc).toContain('reasons');
  });
});

// ---------------------------------------------------------------------------
// Group 2: top-entries dispatch handler
// ---------------------------------------------------------------------------

describe('nexus.top-entries — dispatch handler', () => {
  it('empty nexus returns empty entries with a note (no crash)', async () => {
    const handler = new NexusHandler();
    const result = await handler.query('top-entries', { limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as {
      entries: unknown[];
      count: number;
      limit: number;
      kind: string | null;
      note?: string;
    };
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries).toHaveLength(0);
    expect(data.count).toBe(0);
    expect(data.limit).toBe(5);
    expect(data.kind).toBeNull();
    expect(data.note).toBeDefined();
    expect(typeof data.note).toBe('string');
  });

  it('returns entries sorted by totalWeight DESC', async () => {
    const projectId = 'proj-top-entries';
    const db = await getNexusDb();
    // Seed three source nodes with different aggregate weights.
    const alpha = seedNode(db, projectId, {
      id: 'src/a.ts::alpha',
      kind: 'function',
      label: 'alpha',
    });
    const beta = seedNode(db, projectId, {
      id: 'src/b.ts::beta',
      kind: 'function',
      label: 'beta',
    });
    const gamma = seedNode(db, projectId, {
      id: 'src/c.ts::gamma',
      kind: 'method',
      label: 'gamma',
    });
    // Targets only — not aggregated as source.
    seedNode(db, projectId, {
      id: 'src/z.ts::target',
      kind: 'function',
      label: 'target',
    });

    // alpha: total weight 0.9
    seedRelation(db, projectId, {
      sourceId: alpha,
      targetId: 'src/z.ts::target',
      type: 'calls',
      weight: 0.5,
    });
    seedRelation(db, projectId, {
      sourceId: alpha,
      targetId: 'src/z.ts::target',
      type: 'imports',
      weight: 0.4,
    });
    // beta: total weight 0.3
    seedRelation(db, projectId, {
      sourceId: beta,
      targetId: 'src/z.ts::target',
      type: 'calls',
      weight: 0.3,
    });
    // gamma: total weight 0.6 (single edge)
    seedRelation(db, projectId, {
      sourceId: gamma,
      targetId: 'src/z.ts::target',
      type: 'calls',
      weight: 0.6,
    });

    const handler = new NexusHandler();
    const result = await handler.query('top-entries', { limit: 20 });
    expect(result.success).toBe(true);
    const data = result.data as {
      entries: Array<{ nodeId: string; totalWeight: number; kind: string }>;
      count: number;
    };

    expect(data.count).toBeGreaterThanOrEqual(3);
    // The top-3 by weight should be alpha(0.9), gamma(0.6), beta(0.3) in order.
    const topThree = data.entries.slice(0, 3).map((e) => e.nodeId);
    expect(topThree).toEqual([alpha, gamma, beta]);
    // Weights monotonically non-increasing.
    for (let i = 1; i < data.entries.length; i++) {
      expect(data.entries[i]!.totalWeight).toBeLessThanOrEqual(data.entries[i - 1]!.totalWeight);
    }
  });

  it('respects --limit', async () => {
    const projectId = 'proj-top-entries-limit';
    const db = await getNexusDb();
    for (let i = 0; i < 5; i++) {
      const id = `src/limit-${i}.ts::fn${i}`;
      seedNode(db, projectId, { id, kind: 'function', label: `fn${i}` });
      seedRelation(db, projectId, {
        sourceId: id,
        targetId: 'src/z.ts::target',
        type: 'calls',
        weight: 0.1 + i * 0.1,
      });
    }

    const handler = new NexusHandler();
    const result = await handler.query('top-entries', { limit: 2 });
    expect(result.success).toBe(true);
    const data = result.data as { entries: unknown[]; limit: number };
    expect(data.entries.length).toBeLessThanOrEqual(2);
    expect(data.limit).toBe(2);
  });

  it('respects --kind filter', async () => {
    const projectId = 'proj-top-entries-kind';
    const db = await getNexusDb();
    seedNode(db, projectId, { id: 'src/fn.ts::fnX', kind: 'function', label: 'fnX' });
    seedNode(db, projectId, { id: 'src/m.ts::methodX', kind: 'method', label: 'methodX' });
    seedRelation(db, projectId, {
      sourceId: 'src/fn.ts::fnX',
      targetId: 'src/z.ts::t',
      type: 'calls',
      weight: 0.8,
    });
    seedRelation(db, projectId, {
      sourceId: 'src/m.ts::methodX',
      targetId: 'src/z.ts::t',
      type: 'calls',
      weight: 0.9,
    });

    const handler = new NexusHandler();
    const result = await handler.query('top-entries', { limit: 10, kind: 'method' });
    expect(result.success).toBe(true);
    const data = result.data as {
      entries: Array<{ kind: string }>;
      kind: string | null;
    };
    expect(data.kind).toBe('method');
    // Every returned entry must have kind=method (kind filter is STRICT).
    for (const entry of data.entries) {
      expect(entry.kind).toBe('method');
    }
  });

  it('defaults limit to 20 when not provided', async () => {
    const handler = new NexusHandler();
    const result = await handler.query('top-entries', {});
    expect(result.success).toBe(true);
    const data = result.data as { limit: number };
    expect(data.limit).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Group 3: impact dispatch handler with `why`
// ---------------------------------------------------------------------------

describe('nexus.impact — dispatch handler (--why)', () => {
  it('rejects when symbol is missing', async () => {
    const handler = new NexusHandler();
    const result = await handler.query('impact', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('why=false returns empty reasons[] per affected symbol (backward compat)', async () => {
    const projectId = 'proj-impact-nowhy';
    const db = await getNexusDb();
    const target = seedNode(db, projectId, {
      id: 'src/svc.ts::targetSvc',
      kind: 'function',
      label: 'targetSvc',
      name: 'targetSvc',
    });
    const caller = seedNode(db, projectId, {
      id: 'src/app.ts::callerFn',
      kind: 'function',
      label: 'callerFn',
      name: 'callerFn',
    });
    seedRelation(db, projectId, {
      sourceId: caller,
      targetId: target,
      type: 'calls',
      weight: 0.42,
    });

    const handler = new NexusHandler();
    const result = await handler.query('impact', {
      symbol: 'targetSvc',
      projectId,
      why: false,
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      why: boolean;
      affected: Array<{ reasons: string[] }>;
    };
    expect(data.why).toBe(false);
    expect(data.affected.length).toBeGreaterThan(0);
    for (const node of data.affected) {
      expect(Array.isArray(node.reasons)).toBe(true);
      expect(node.reasons).toHaveLength(0);
    }
  });

  it('why=true returns reasons[] with caller-count + strength + depth strings', async () => {
    const projectId = 'proj-impact-why';
    const db = await getNexusDb();
    const target = seedNode(db, projectId, {
      id: 'src/svc.ts::targetWhy',
      kind: 'function',
      label: 'targetWhy',
      name: 'targetWhy',
    });
    const caller = seedNode(db, projectId, {
      id: 'src/app.ts::callerWhy',
      kind: 'function',
      label: 'callerWhy',
      name: 'callerWhy',
    });
    seedRelation(db, projectId, {
      sourceId: caller,
      targetId: target,
      type: 'calls',
      weight: 0.75,
    });

    const handler = new NexusHandler();
    const result = await handler.query('impact', {
      symbol: 'targetWhy',
      projectId,
      why: true,
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      why: boolean;
      affected: Array<{ reasons: string[]; nodeId: string }>;
    };
    expect(data.why).toBe(true);
    expect(data.affected.length).toBeGreaterThan(0);
    const first = data.affected[0]!;
    expect(first.nodeId).toBe(caller);
    expect(first.reasons.length).toBeGreaterThanOrEqual(2);
    // At least one reason should mention the edge strength or plasticity note.
    const joined = first.reasons.join(' | ');
    expect(joined).toMatch(/strength=|weight=0/);
    // A depth-hop reason is always emitted when why=true.
    expect(joined).toMatch(/depth=/);
  });

  it('unknown symbol returns success with targetNodeId=null and empty affected[]', async () => {
    const handler = new NexusHandler();
    const result = await handler.query('impact', {
      symbol: 'DEFINITELY_NOT_A_REAL_SYMBOL_XYZ',
      projectId: 'proj-no-such',
      why: true,
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      targetNodeId: string | null;
      affected: unknown[];
      riskLevel: string;
    };
    expect(data.targetNodeId).toBeNull();
    expect(data.affected).toHaveLength(0);
    expect(data.riskLevel).toBe('NONE');
  });
});
