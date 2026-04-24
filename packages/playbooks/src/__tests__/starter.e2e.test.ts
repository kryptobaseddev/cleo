/**
 * T934 — Starter playbook E2E integration tests.
 *
 * Each starter `.cantbook` shipped under `packages/playbooks/starter/` is:
 *   1. Loaded from disk (so the shipped file is what we test).
 *   2. Parsed via the real {@link parsePlaybook}.
 *   3. Executed end-to-end against a real in-memory `node:sqlite` DB with the
 *      T889 migration applied.
 *   4. Driven by an in-process stub {@link AgentDispatcher} so every node is
 *      exercised without touching a real agent runtime.
 *
 * No `@cleocode/*` module is mocked. The only injected surface is the
 * dispatcher, which matches what production code passes to
 * {@link executePlaybook}. This proves the starter playbooks actually reach
 * their documented terminal states via the T930 runtime state machine.
 *
 * @task T934 — Starter Playbooks
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PlaybookDefinition } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveGate } from '../approval.js';
import { parsePlaybook } from '../parser.js';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  executePlaybook,
  resumePlaybook,
} from '../runtime.js';
import { getPlaybookRun, listPlaybookApprovals } from '../state.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the T889 playbook-tables migration SQL. */
const MIGRATION_SQL_PATH = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

/** Absolute path to the `starter/` directory shipped with this package. */
const STARTER_DIR = resolve(__dirname, '../../starter');

// -- DB helpers --------------------------------------------------------------

/**
 * Apply a multi-statement Drizzle migration file (split on the
 * `--> statement-breakpoint` token emitted by `drizzle-kit generate`).
 * Comment-only statements are skipped so the loop never feeds SQLite an
 * empty block.
 */
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

// -- Stub dispatcher ---------------------------------------------------------

/**
 * Recorded call shape used to assert that each node ran the expected number
 * of times and observed the expected accumulated context.
 */
interface RecordedCall {
  nodeId: string;
  agentId: string;
  iteration: number;
  contextSnapshot: Record<string, unknown>;
}

/**
 * Build a stub {@link AgentDispatcher} that records every call and delegates
 * the success/failure decision to a user-supplied handler. The handler gets
 * the full {@link AgentDispatchInput} so it can react to node id, iteration,
 * or accumulated context.
 */
function makeRecordingDispatcher(
  handler: (input: AgentDispatchInput) => AgentDispatchResult | Promise<AgentDispatchResult>,
): AgentDispatcher & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      calls.push({
        nodeId: input.nodeId,
        agentId: input.agentId,
        iteration: input.iteration,
        contextSnapshot: { ...input.context },
      });
      return handler(input);
    },
  };
}

/**
 * Default "always succeed" handler that echoes the node id into the context
 * via `{<nodeId>_done: true}`, plus enough fields to satisfy the ivtr/rcasd
 * `requires` contracts so the E4 contract enforcement (T1261) doesn't fire.
 *
 * Fields added per-node follow the starter playbook schemas:
 *   - implement → diff (validate.requires.fields includes 'diff')
 *   - validate  → passed (test.requires.fields includes 'passed')
 *   - research  → summary, risks (consensus.requires.fields)
 *   - consensus → decision (architecture.requires.fields)
 *   - architecture → patterns, adrs (specification.requires.fields)
 *   - specification → acceptance, requirements (decomposition.requires.fields)
 *   - version_bump → versionBumped (changelog.requires.fields)
 *   - changelog → changelogUpdated (approval edge.contract.ensures)
 */
function alwaysSucceed(input: AgentDispatchInput): AgentDispatchResult {
  const extraFields: Record<string, unknown> = {};
  switch (input.nodeId) {
    case 'implement':
      extraFields.diff = `diff-${input.runId}`;
      break;
    case 'validate':
      extraFields.passed = true;
      break;
    case 'research':
      extraFields.summary = 'research summary';
      extraFields.risks = [];
      break;
    case 'consensus':
      extraFields.decision = 'consensus decision';
      break;
    case 'architecture':
      extraFields.patterns = [];
      extraFields.adrs = [];
      break;
    case 'specification':
      extraFields.acceptance = [];
      extraFields.requirements = [];
      break;
    case 'version_bump':
      extraFields.versionBumped = true;
      break;
    case 'changelog':
      extraFields.changelogUpdated = true;
      extraFields.published = false;
      break;
    case 'publish':
      extraFields.published = true;
      break;
    default:
      break;
  }
  return {
    status: 'success',
    output: {
      [`${input.nodeId}_done`]: true,
      lastNode: input.nodeId,
      lastAgent: input.agentId,
      ...extraFields,
    },
  };
}

// -- Shared loader -----------------------------------------------------------

/**
 * Load and parse a starter `.cantbook` by filename stem. Returns both the
 * validated definition and its SHA-256 source hash so callers can feed
 * executePlaybook without duplicating the fs read.
 */
function loadStarter(stem: 'rcasd' | 'ivtr' | 'release'): {
  definition: PlaybookDefinition;
  sourceHash: string;
} {
  const src = readFileSync(resolve(STARTER_DIR, `${stem}.cantbook`), 'utf8');
  const { definition, sourceHash } = parsePlaybook(src);
  return { definition, sourceHash };
}

// ---------------------------------------------------------------------------

describe('T934: starter playbooks — E2E against stubbed dispatcher', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL_PATH, 'utf8'));
  });
  afterEach(() => db.close());

  // -------------------------------------------------------------------------
  // rcasd — 5 linear agentic stages, all must run in declaration order.
  // -------------------------------------------------------------------------
  describe('rcasd.cantbook', () => {
    it('parses cleanly and declares 5 agentic RCASD stages', () => {
      const { definition } = loadStarter('rcasd');
      expect(definition.name).toBe('rcasd');
      expect(definition.nodes).toHaveLength(5);
      expect(definition.edges).toHaveLength(4);
      expect(definition.nodes.map((n) => n.id)).toEqual([
        'research',
        'consensus',
        'architecture',
        'specification',
        'decomposition',
      ]);
      for (const n of definition.nodes) {
        expect(n.type).toBe('agentic');
      }
    });

    it('executes all 5 stages in order and reaches `completed` terminal state', async () => {
      const { definition, sourceHash } = loadStarter('rcasd');
      const dispatcher = makeRecordingDispatcher(alwaysSucceed);

      const result = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { epicId: 'T999', scope: 'global', taskId: 'T999' },
        dispatcher,
      });

      expect(result.terminalStatus).toBe('completed');
      // Every RCASD stage must have fired exactly once, in declaration order.
      expect(dispatcher.calls.map((c) => c.nodeId)).toEqual([
        'research',
        'consensus',
        'architecture',
        'specification',
        'decomposition',
      ]);
      // Every stage observed iteration=1 (no retries on happy path).
      expect(dispatcher.calls.every((c) => c.iteration === 1)).toBe(true);
      // Context carries the initial inputs plus per-stage success markers.
      expect(result.finalContext).toMatchObject({
        epicId: 'T999',
        scope: 'global',
        research_done: true,
        consensus_done: true,
        architecture_done: true,
        specification_done: true,
        decomposition_done: true,
        lastNode: 'decomposition',
      });
      // Later stages see outputs of prior stages in their context snapshot.
      const decompositionCall = dispatcher.calls.find((c) => c.nodeId === 'decomposition');
      expect(decompositionCall?.contextSnapshot).toMatchObject({
        research_done: true,
        consensus_done: true,
        architecture_done: true,
        specification_done: true,
      });

      const run = getPlaybookRun(db, result.runId);
      expect(run?.status).toBe('completed');
      expect(run?.currentNode).toBeNull();
      expect(run?.completedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // ivtr — implement → validate → test, with inject_into wiring for retries.
  // -------------------------------------------------------------------------
  describe('ivtr.cantbook', () => {
    it('parses cleanly and declares implement/validate/test with iteration caps', () => {
      const { definition } = loadStarter('ivtr');
      expect(definition.name).toBe('ivtr');
      expect(definition.nodes).toHaveLength(3);
      expect(definition.nodes.map((n) => n.id)).toEqual(['implement', 'validate', 'test']);

      const implementNode = definition.nodes.find((n) => n.id === 'implement');
      const validateNode = definition.nodes.find((n) => n.id === 'validate');
      const testNode = definition.nodes.find((n) => n.id === 'test');

      // Iteration caps are populated (runtime needs them for loop bounds).
      expect(implementNode?.on_failure?.max_iterations).toBe(3);
      expect(validateNode?.on_failure?.max_iterations).toBe(2);
      expect(testNode?.on_failure?.max_iterations).toBe(2);

      // validate + test both bounce back to implement on sustained failure.
      expect(validateNode?.on_failure?.inject_into).toBe('implement');
      expect(testNode?.on_failure?.inject_into).toBe('implement');
    });

    it('happy path: implement → validate → test completes in one pass', async () => {
      const { definition, sourceHash } = loadStarter('ivtr');
      const dispatcher = makeRecordingDispatcher(alwaysSucceed);

      const result = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { taskId: 'T934', maxAttempts: 3 },
        dispatcher,
      });

      expect(result.terminalStatus).toBe('completed');
      expect(dispatcher.calls.map((c) => c.nodeId)).toEqual(['implement', 'validate', 'test']);
      expect(result.finalContext).toMatchObject({
        taskId: 'T934',
        implement_done: true,
        validate_done: true,
        test_done: true,
      });
    });

    it('loop behavior: validate failure bounces back to implement via inject_into', async () => {
      const { definition, sourceHash } = loadStarter('ivtr');

      // Validate fails on its first attempt, then succeeds after implement
      // re-runs with the enriched context. Test always succeeds.
      let validateCalls = 0;
      const dispatcher = makeRecordingDispatcher((input) => {
        if (input.nodeId === 'validate') {
          validateCalls += 1;
          // First two attempts fail → exhausts validate's max_iterations=2.
          // That triggers inject_into: 'implement'. Implement then reruns,
          // and on the next validate attempt we let it succeed.
          if (validateCalls <= 2) {
            return { status: 'failure', output: {}, error: `validate miss #${validateCalls}` };
          }
          return { status: 'success', output: { validate_done: true, passed: true } };
        }
        return alwaysSucceed(input);
      });

      const result = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { taskId: 'T934-LOOP' },
        dispatcher,
      });

      expect(result.terminalStatus).toBe('completed');
      // implement ran at least twice (original + re-injected), validate three
      // times (two misses + one pass), test once.
      const byNode = dispatcher.calls.reduce<Record<string, number>>((acc, c) => {
        acc[c.nodeId] = (acc[c.nodeId] ?? 0) + 1;
        return acc;
      }, {});
      expect(byNode['implement']).toBeGreaterThanOrEqual(2);
      expect(byNode['validate']).toBe(3);
      expect(byNode['test']).toBe(1);
      // inject_into enriches context with the last error/fail-node markers.
      expect(result.finalContext).toMatchObject({
        __lastError: 'validate miss #2',
        __lastFailedNode: 'validate',
        test_done: true,
      });
    });

    it('iteration cap: sustained failure terminates with exceeded_iteration_cap', async () => {
      const { definition, sourceHash } = loadStarter('ivtr');

      // Force every implement attempt to fail. Implement has cap=3 and no
      // inject_into, so it should retry in-place and then trip the cap.
      const dispatcher = makeRecordingDispatcher((input) => {
        if (input.nodeId === 'implement') {
          return { status: 'failure', output: {}, error: 'impl bust' };
        }
        return alwaysSucceed(input);
      });

      const result = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { taskId: 'T934-FAIL' },
        dispatcher,
      });

      expect(result.terminalStatus).toBe('exceeded_iteration_cap');
      expect(result.exceededNodeId).toBe('implement');
      expect(result.errorContext).toBe('impl bust');
      // implement fired exactly 3 times (its max_iterations), then terminated.
      const implementCalls = dispatcher.calls.filter((c) => c.nodeId === 'implement');
      expect(implementCalls).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // release — version_bump → changelog → APPROVAL → publish.
  // -------------------------------------------------------------------------
  describe('release.cantbook', () => {
    it('parses cleanly with one approval node between changelog and publish', () => {
      const { definition } = loadStarter('release');
      expect(definition.name).toBe('release');
      expect(definition.nodes).toHaveLength(4);
      expect(definition.nodes.map((n) => n.id)).toEqual([
        'version_bump',
        'changelog',
        'approval',
        'publish',
      ]);
      const approvalNode = definition.nodes.find((n) => n.id === 'approval');
      expect(approvalNode?.type).toBe('approval');
      if (approvalNode?.type === 'approval') {
        expect(approvalNode.policy).toBe('conservative');
        expect(approvalNode.prompt).toMatch(/Approve release/);
      }
    });

    it('pauses at approval gate with a signed HMAC resume token', async () => {
      const { definition, sourceHash } = loadStarter('release');
      const dispatcher = makeRecordingDispatcher(alwaysSucceed);

      const result = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { targetVersion: '2026.4.92', channel: 'latest', taskId: 'T934' },
        dispatcher,
        approvalSecret: 't934-test-secret',
      });

      expect(result.terminalStatus).toBe('pending_approval');
      expect(result.approvalToken).toBeDefined();
      // Approval.ts truncates the HMAC to 32 hex chars.
      expect(result.approvalToken).toMatch(/^[0-9a-f]{32}$/);
      // version_bump + changelog ran; publish did not.
      expect(dispatcher.calls.map((c) => c.nodeId)).toEqual(['version_bump', 'changelog']);

      const approvals = listPlaybookApprovals(db, result.runId);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('pending');
      expect(approvals[0]?.nodeId).toBe('approval');
      expect(approvals[0]?.token).toBe(result.approvalToken);

      const run = getPlaybookRun(db, result.runId);
      expect(run?.status).toBe('paused');
      expect(run?.currentNode).toBe('approval');
    });

    it('resume after approval walks through publish to `completed`', async () => {
      const { definition, sourceHash } = loadStarter('release');
      const dispatcher = makeRecordingDispatcher(alwaysSucceed);

      const first = await executePlaybook({
        db,
        playbook: definition,
        playbookHash: sourceHash,
        initialContext: { targetVersion: '2026.4.92', channel: 'latest', taskId: 'T934' },
        dispatcher,
        approvalSecret: 't934-test-secret',
      });
      expect(first.terminalStatus).toBe('pending_approval');
      if (first.approvalToken === undefined) {
        throw new Error('expected approval token from first execution');
      }

      // HITL approves.
      approveGate(db, first.approvalToken, 'keaton@cleo', 'ship it');

      const second = await resumePlaybook({
        db,
        playbook: definition,
        approvalToken: first.approvalToken,
        dispatcher,
        approvalSecret: 't934-test-secret',
      });

      expect(second.terminalStatus).toBe('completed');
      // publish must have fired exactly once after the gate released.
      const publishCalls = dispatcher.calls.filter((c) => c.nodeId === 'publish');
      expect(publishCalls).toHaveLength(1);
      // The resumed run should record an approval trace on the context.
      expect(second.finalContext['__lastApproval']).toMatchObject({
        nodeId: 'approval',
        approver: 'keaton@cleo',
        reason: 'ship it',
      });

      const run = getPlaybookRun(db, first.runId);
      expect(run?.status).toBe('completed');
      expect(run?.currentNode).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-playbook invariants
  // -------------------------------------------------------------------------
  describe('cross-playbook invariants', () => {
    it('each starter has a unique source hash (independent definitions)', () => {
      const hashes = new Set(
        (['rcasd', 'ivtr', 'release'] as const).map((n) => loadStarter(n).sourceHash),
      );
      expect(hashes.size).toBe(3);
    });

    it('each starter uses schema version "1.0"', () => {
      for (const stem of ['rcasd', 'ivtr', 'release'] as const) {
        const { definition } = loadStarter(stem);
        expect(definition.version).toBe('1.0');
      }
    });
  });
});
