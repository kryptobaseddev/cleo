/**
 * T1947 (M4 cantbook done-gate, Gap E/F) — `PlaybookAgenticNode.allowed_skills`
 * / `.allowed_tools` are parsed (AC1) and reach the dispatch boundary as
 * `AgentDispatchInput.allowedSkills` / `.allowedTools` (AC5) so the dispatcher
 * can intersect them against the Tier-0/1/2 baseline at spawn time.
 *
 * Two layers:
 *  1. Parser → runtime forwarding: a `.cantbook` node with `allowed_skills:` /
 *     `allowed_tools:` is parsed and the lists reach {@link AgentDispatchInput}
 *     at dispatch time — asserted with a recorder dispatcher (no live backend).
 *  2. Default (un-restricted) nodes carry NO allowlist — the dispatch path is
 *     unchanged (additive).
 *
 * The intersection enforcement itself lives in `@cleocode/core`'s
 * `composeSpawnPayload` and is covered by `spawn.test.ts`; this suite proves the
 * runtime hands the allowlists to the dispatcher so that enforcement can occur.
 * No `@cleocode/*` module is mocked.
 *
 * @task T1947
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlaybook } from '../parser.js';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  executePlaybook,
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

/** Records the full {@link AgentDispatchInput} per call. */
function makeRecorder(): AgentDispatcher & { calls: AgentDispatchInput[] } {
  const calls: AgentDispatchInput[] = [];
  return {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      calls.push({ ...input, context: { ...input.context } });
      return { status: 'success', output: {} };
    },
  };
}

describe('T1947: AC1 — parser accepts allowed_skills / allowed_tools', () => {
  it('parses string[] allowlists onto the agentic node', () => {
    const yaml = `
version: "1.0"
name: gated-flow
nodes:
  - id: review
    type: agentic
    skill: ct-validator
    allowed_skills: [ct-validator, ct-cleo]
    allowed_tools: [Read, Grep]
`;
    const { definition } = parsePlaybook(yaml);
    const node = definition.nodes[0];
    expect(node?.type).toBe('agentic');
    if (node?.type !== 'agentic') throw new Error('expected agentic node');
    expect(node.allowed_skills).toEqual(['ct-validator', 'ct-cleo']);
    expect(node.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('omits both fields when the node declares neither (additive)', () => {
    const yaml = `
version: "1.0"
name: plain-flow
nodes:
  - id: research
    type: agentic
    skill: ct-research-agent
`;
    const { definition } = parsePlaybook(yaml);
    const node = definition.nodes[0];
    if (node?.type !== 'agentic') throw new Error('expected agentic node');
    expect(node.allowed_skills).toBeUndefined();
    expect(node.allowed_tools).toBeUndefined();
  });

  it('rejects a non-string entry in allowed_skills', () => {
    const yaml = `
version: "1.0"
name: bad-flow
nodes:
  - id: review
    type: agentic
    skill: ct-validator
    allowed_skills: [ct-validator, 42]
`;
    expect(() => parsePlaybook(yaml)).toThrow(/allowed_skills/);
  });
});

describe('T1947: AC5 — allowlists reach the dispatch boundary', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  it('forwards allowed_skills/allowed_tools as allowedSkills/allowedTools', async () => {
    const yaml = `
version: "1.0"
name: gated-flow
nodes:
  - id: review
    type: agentic
    skill: ct-validator
    allowed_skills: [ct-validator]
    allowed_tools: [Read, Grep]
`;
    const { definition } = parsePlaybook(yaml);
    const dispatcher = makeRecorder();

    const result = await executePlaybook({
      db,
      playbook: definition,
      playbookHash: 'hash-t1947',
      initialContext: { taskId: 'T1947' },
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(dispatcher.calls).toHaveLength(1);
    const call = dispatcher.calls[0];
    expect(call?.nodeId).toBe('review');
    expect(call?.allowedSkills).toEqual(['ct-validator']);
    expect(call?.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('an un-restricted stage carries NO allowedSkills/allowedTools (additive)', async () => {
    const yaml = `
version: "1.0"
name: plain-flow
nodes:
  - id: research
    type: agentic
    skill: ct-research-agent
`;
    const { definition } = parsePlaybook(yaml);
    const dispatcher = makeRecorder();

    await executePlaybook({
      db,
      playbook: definition,
      playbookHash: 'hash-t1947-b',
      initialContext: { taskId: 'T123' },
      dispatcher,
    });

    const call = dispatcher.calls[0];
    expect(call?.allowedSkills).toBeUndefined();
    expect(call?.allowedTools).toBeUndefined();
  });
});
