/**
 * T1944 (M4 cantbook done-gate) — `PlaybookAgenticNode.inputs` →
 * `AgentDispatchInput.bindings` wiring + mustache resolution at the dispatch
 * boundary.
 *
 * Two layers of coverage:
 *
 *  1. Pure-unit tests of {@link resolveStepBindings} — precedence, shadowing,
 *     dot-path resolution, and the lenient missing-key rule, exercised in
 *     isolation with no DB.
 *  2. In-process `executePlaybook` end-to-end — a `.cantbook`-equivalent node
 *     with `inputs: { topic: '{{inputs.epicId}}' }` resolves and the bound
 *     value reaches {@link AgentDispatchInput.bindings} at dispatch time.
 *
 * No `@cleocode/*` module is mocked — the resolver is the real canonical
 * T1238 engine and the runtime runs against an in-memory `node:sqlite` DB.
 *
 * @task T1944 — wire PlaybookAgenticNode.inputs → AgentDispatchInput.bindings
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { PlaybookAgenticNode, PlaybookDefinition } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  executePlaybook,
  resolveStepBindings,
} from '../runtime.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

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

function agenticNode(
  id: string,
  overrides: Partial<PlaybookAgenticNode> = {},
): PlaybookAgenticNode {
  return { id, type: 'agentic', skill: `skill-${id}`, ...overrides };
}

/** Dispatcher that records the full {@link AgentDispatchInput} per call. */
function makeBindingRecorder(
  handler: (input: AgentDispatchInput) => AgentDispatchResult,
): AgentDispatcher & { calls: AgentDispatchInput[] } {
  const calls: AgentDispatchInput[] = [];
  return {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      // Snapshot bindings/context so later mutation cannot taint the assertion.
      calls.push({
        ...input,
        context: { ...input.context },
        bindings: input.bindings === undefined ? undefined : { ...input.bindings },
      });
      return handler(input);
    },
  };
}

// ---------------------------------------------------------------------------
// resolveStepBindings — pure unit
// ---------------------------------------------------------------------------

describe('T1944: resolveStepBindings (pure)', () => {
  it('AC5: resolves a {{inputs.epicId}} template from the run context', () => {
    const node = agenticNode('research', { inputs: { topic: '{{inputs.epicId}}' } });
    const context = { inputs: { epicId: 'T1942' } };

    const bound = resolveStepBindings(node, context);

    expect(bound['topic']).toBe('T1942');
    // Original context keys remain present.
    expect(bound['inputs']).toEqual({ epicId: 'T1942' });
  });

  it('AC5: resolves a flat {{epicId}} single-segment template', () => {
    const node = agenticNode('research', { inputs: { topic: '{{epicId}}' } });
    const bound = resolveStepBindings(node, { epicId: 'T1942' });
    expect(bound['topic']).toBe('T1942');
  });

  it('AC6: step bindings shadow playbook bindings for the same key', () => {
    // The run context already carries `topic`; the step input MUST win.
    const node = agenticNode('research', { inputs: { topic: '{{inputs.epicId}}' } });
    const context = { topic: 'stale-context-value', inputs: { epicId: 'T1942' } };

    const bound = resolveStepBindings(node, context);

    expect(bound['topic']).toBe('T1942');
    expect(bound['topic']).not.toBe('stale-context-value');
  });

  it('missing-key rule: unresolved {{path}} is left as a literal placeholder', () => {
    const node = agenticNode('research', { inputs: { topic: '{{inputs.nope}}' } });
    const bound = resolveStepBindings(node, { inputs: { epicId: 'T1942' } });
    expect(bound['topic']).toBe('{{inputs.nope}}');
  });

  it('resolves dot-path nesting deeper than one level', () => {
    const node = agenticNode('research', { inputs: { fw: '{{project.testing.framework}}' } });
    const bound = resolveStepBindings(node, {
      project: { testing: { framework: 'vitest' } },
    });
    expect(bound['fw']).toBe('vitest');
  });

  it('passes literal (non-template) input values through unchanged', () => {
    const node = agenticNode('research', { inputs: { mode: 'fast' } });
    const bound = resolveStepBindings(node, { x: 1 });
    expect(bound['mode']).toBe('fast');
  });

  it('returns a shallow copy of context when the node declares no inputs', () => {
    const node = agenticNode('research');
    const context = { taskId: 'T123', a: 1 };
    const bound = resolveStepBindings(node, context);
    expect(bound).toEqual(context);
    expect(bound).not.toBe(context);
  });

  it('returns a shallow copy of context for an empty inputs map', () => {
    const node = agenticNode('research', { inputs: {} });
    const context = { taskId: 'T123' };
    expect(resolveStepBindings(node, context)).toEqual(context);
  });

  it('does not mutate the source context', () => {
    const node = agenticNode('research', { inputs: { topic: '{{epicId}}' } });
    const context = { epicId: 'T1942' };
    resolveStepBindings(node, context);
    expect(context).toEqual({ epicId: 'T1942' });
    expect(context).not.toHaveProperty('topic');
  });
});

// ---------------------------------------------------------------------------
// executePlaybook — bindings reach the dispatch boundary (in-process e2e)
// ---------------------------------------------------------------------------

describe('T1944: AgentDispatchInput.bindings (in-process)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  it('AC2: resolved step input reaches AgentDispatchInput.bindings at dispatch', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'inputs-bindings',
      nodes: [agenticNode('research', { inputs: { topic: '{{inputs.epicId}}' } })],
      edges: [],
    };
    const dispatcher = makeBindingRecorder(() => ({ status: 'success', output: {} }));

    const result = await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-t1944',
      initialContext: { inputs: { epicId: 'T1942' } },
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(dispatcher.calls).toHaveLength(1);
    // The resolved binding (NOT the raw template) reaches the dispatcher.
    expect(dispatcher.calls[0]?.bindings?.['topic']).toBe('T1942');
    // The raw accumulated context still carries the source object.
    expect(dispatcher.calls[0]?.context['inputs']).toEqual({ epicId: 'T1942' });
  });

  it('AC2: bindings is always populated even when the node declares no inputs', async () => {
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'no-inputs',
      nodes: [agenticNode('plain')],
      edges: [],
    };
    const dispatcher = makeBindingRecorder(() => ({ status: 'success', output: {} }));

    await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-t1944-b',
      initialContext: { taskId: 'T123' },
      dispatcher,
    });

    expect(dispatcher.calls[0]?.bindings).toMatchObject({ taskId: 'T123' });
  });

  it('AC6: step binding shadows a same-named accumulated context key end-to-end', async () => {
    // Node `a` emits `topic`; node `b` declares an `inputs.topic` template that
    // MUST shadow the inherited context value when dispatched.
    const playbook: PlaybookDefinition = {
      version: '1.0',
      name: 'shadowing',
      nodes: [agenticNode('a'), agenticNode('b', { inputs: { topic: '{{inputs.epicId}}' } })],
      edges: [{ from: 'a', to: 'b' }],
    };
    const dispatcher = makeBindingRecorder((input) =>
      input.nodeId === 'a'
        ? { status: 'success', output: { topic: 'from-node-a' } }
        : { status: 'success', output: {} },
    );

    await executePlaybook({
      db,
      playbook,
      playbookHash: 'hash-t1944-c',
      initialContext: { inputs: { epicId: 'T1942' } },
      dispatcher,
    });

    const callB = dispatcher.calls.find((c) => c.nodeId === 'b');
    // Accumulated context still has node-a's value...
    expect(callB?.context['topic']).toBe('from-node-a');
    // ...but the step binding shadows it.
    expect(callB?.bindings?.['topic']).toBe('T1942');
  });
});
