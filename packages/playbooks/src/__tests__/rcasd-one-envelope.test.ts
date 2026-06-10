/**
 * T11803 (M4 cantbook done-gate) — prove the vertical slice: `rcasd.cantbook`
 * execution terminates with EXACTLY ONE LAFS `RenderableEnvelope`, and there is
 * NO GenKit import anywhere in the execution call graph.
 *
 * ## What this proves
 *
 *  - **AC1** — the REAL starter `rcasd.cantbook` is parsed and driven end-to-end
 *    through {@link executePlaybook} (parse → execute → terminal envelope). The
 *    five agentic stages are stubbed by a DETERMINISTIC recording dispatcher (no
 *    LLM backend authenticates on CI, and the point of this gate is the ENVELOPE
 *    SHAPE + the import graph — NOT a live model round-trip).
 *  - **AC2** — the terminal result is folded into exactly ONE LAFS envelope (the
 *    ADR-077 `RenderableEnvelope<T>` `{ kind: 'single', data }` wrapped by the
 *    canonical `createEnvelope` SSoT) and that envelope passes the
 *    `@cleocode/lafs` `validateEnvelope` schema validator. Exactly one — the run
 *    produces one `ExecutePlaybookResult`, which maps to one envelope.
 *  - **AC3** — NO `@genkit-ai` / GenKit import in the execution call graph: a
 *    static module-graph walk over every playbooks `src/` file reachable from
 *    `runtime.ts` (the executePlaybook entry) via intra-package imports asserts
 *    zero GenKit specifiers, and the runtime entry imports none directly.
 *  - **AC5** — the test is NOT skipped (no `.skip`, no `it.skipIf`).
 *
 * ## Determinism + isolation
 *
 *  - IN-PROCESS only — vitest source, NO subprocess (tsx unresolvable in CI).
 *  - daemon-OFF — an in-memory `node:sqlite` DB, no daemon, no live LLM.
 *  - The dispatcher emits each stage's `ensures.schema`-satisfying output so the
 *    rcasd contract gates pass and the run reaches `completed` — a faithful
 *    full-pipeline traversal, deterministically.
 *
 * @epic T11391
 * @task T11803
 * @saga T11387
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { RenderableEnvelope } from '@cleocode/contracts';
import { createEnvelope, validateEnvelope } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlaybook } from '../parser.js';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  type ExecutePlaybookResult,
  executePlaybook,
} from '../runtime.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_SRC = resolve(__dirname, '..');

const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);
const RCASD_CANTBOOK = resolve(__dirname, '../../starter/rcasd.cantbook');

function applyMigration(db: DatabaseSync, sql: string): void {
  const statements = sql
    .split(/--> statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const lines = stmt.split('\n');
    const hasSql = lines.some((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (hasSql) db.exec(stmt);
  }
}

/**
 * Deterministic recording dispatcher that emits each rcasd stage's
 * `ensures.schema`-satisfying output + the `requires`/edge fields the next stage
 * needs, so the full five-stage pipeline reaches `completed` with NO LLM. Keyed
 * by `nodeId` (the rcasd stage names).
 */
function makeRcasdDispatcher(): AgentDispatcher & { nodes: string[] } {
  const nodes: string[] = [];
  // Per-stage outputs satisfying rcasd.cantbook ensures.schema + downstream
  // requires/edge contracts. The first four stages' ensures.schema names
  // (research_summary | consensus_decision | architecture_plan |
  // specification_document) are registered passthrough; the terminal
  // `decomposition` stage's `task_tree` is STRICT — it validates
  // `context['task_tree']` as a non-empty array of { title, acceptance[] }
  // entries — so we emit a conformant `task_tree` to clear the contract gate.
  const STAGE_OUTPUT: Record<string, Record<string, unknown>> = {
    research: {
      summary: 'research summary for the epic',
      risks: ['risk-a', 'risk-b'],
    },
    consensus: {
      decision: 'proceed with approach X',
    },
    architecture: {
      patterns: ['pattern-1', 'pattern-2'],
      adrs: ['ADR-001'],
    },
    specification: {
      acceptance: ['AC1', 'AC2'],
      requirements: ['REQ-1'],
    },
    decomposition: {
      // `children` satisfies the specification→decomposition edge.ensures.
      children: ['T1001', 'T1002'],
      acceptance: ['AC1'],
      requirements: ['REQ-1'],
      // `task_tree` satisfies the strict ensures.schema on the terminal stage.
      task_tree: [
        { id: 'T1001', title: 'Implement feature A', acceptance: ['AC1'] },
        { id: 'T1002', title: 'Implement feature B', acceptance: ['AC2'] },
      ],
    },
  };
  return {
    nodes,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      nodes.push(input.nodeId);
      return { status: 'success', output: STAGE_OUTPUT[input.nodeId] ?? {} };
    },
  };
}

/**
 * Recursively collect every `*.ts` source file under `dir` (excluding tests),
 * so the no-GenKit assertion covers the WHOLE playbooks runtime package surface
 * reachable by the execution path — not just the entry file.
 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('T11803 (M4): rcasd.cantbook → exactly ONE LAFS envelope, no GenKit', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  it('AC1+AC2: parse→execute→envelope yields exactly ONE valid LAFS RenderableEnvelope', async () => {
    const { definition, sourceHash } = parsePlaybook(readFileSync(RCASD_CANTBOOK, 'utf8'));
    expect(definition.name).toBe('rcasd');
    expect(definition.nodes.map((n) => n.id)).toEqual([
      'research',
      'consensus',
      'architecture',
      'specification',
      'decomposition',
    ]);

    const dispatcher = makeRcasdDispatcher();
    const result: ExecutePlaybookResult = await executePlaybook({
      db,
      playbook: definition,
      playbookHash: sourceHash,
      initialContext: { taskId: 'T999', epicId: 'T999', scope: 'global' },
      dispatcher,
    });

    // The full five-stage pipeline ran deterministically to completion.
    expect(dispatcher.nodes).toEqual([
      'research',
      'consensus',
      'architecture',
      'specification',
      'decomposition',
    ]);
    expect(result.terminalStatus).toBe('completed');
    // No silent contract violation hid behind the completion.
    expect(result.finalContext['__ensuresSchemaViolation']).toBeUndefined();
    expect(result.finalContext['__contractViolation']).toBeUndefined();

    // Fold the single terminal result into ONE ADR-077 RenderableEnvelope, then
    // into ONE canonical LAFS envelope (the SSoT `createEnvelope`).
    const renderable: RenderableEnvelope<ExecutePlaybookResult> = {
      kind: 'single',
      data: result,
    };
    const lafsEnvelope = createEnvelope({
      success: true,
      result: renderable as unknown as Record<string, unknown>,
      meta: { operation: 'playbook.run', requestId: `rcasd-${result.runId}` },
    });

    // EXACTLY ONE — a single object, not an array of envelopes.
    expect(Array.isArray(lafsEnvelope)).toBe(false);
    expect(lafsEnvelope.success).toBe(true);
    expect(lafsEnvelope.result).toMatchObject({ kind: 'single' });

    // Validated by the @cleocode/lafs schema validator.
    const validation = validateEnvelope(lafsEnvelope);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('AC3: NO @genkit-ai / GenKit import in the execution call graph', () => {
    // The execution call graph for executePlaybook (runtime → state, approval,
    // parser, schema) lives entirely under packages/playbooks/src. Walk every
    // non-test source file and assert zero GenKit specifiers.
    const files = collectSourceFiles(PLAYBOOKS_SRC);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const GENKIT_IMPORT =
      /(?:import|from|require)\s*(?:\(\s*)?['"]@?genkit(?:-ai)?(?:\/[^'"]*)?['"]/;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (GENKIT_IMPORT.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    // And the runtime entry — the executePlaybook module itself — imports no
    // GenKit specifier directly (belt-and-suspenders against a future edit).
    const runtimeSrc = readFileSync(resolve(PLAYBOOKS_SRC, 'runtime.ts'), 'utf8');
    expect(runtimeSrc).not.toMatch(/@?genkit/i);
  });
});
