/**
 * T11759 (M4 cantbook done-gate) — `PlaybookAgenticNode.profile` / `.model` /
 * `.provider` reach the dispatch boundary so a cantbook stage can pin its LLM.
 *
 * Two layers:
 *  1. Parser → runtime forwarding: a `.cantbook` node with `profile:` is parsed
 *     and the pin reaches {@link AgentDispatchInput} (with `playbookName`) at
 *     dispatch time — asserted with a recorder dispatcher (no live backend).
 *  2. Default (un-pinned) nodes carry NO pin — the dispatch path is unchanged.
 *
 * The dispatcher's E9 resolution itself (cantbook system key + profile pin) is
 * covered in-process by `@cleocode/core`'s `cantbook-profile.test.ts`; this
 * suite proves the runtime hands the pin to the dispatcher so that resolution
 * can occur. No `@cleocode/*` module is mocked.
 *
 * @task T11759
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

describe('T11759: node profile pin reaches the dispatch boundary', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));
  });
  afterEach(() => db.close());

  it('AC3: a `.cantbook` stage with `profile:` forwards the pin + playbookName', async () => {
    const yaml = `
version: "1.0"
name: pinned-flow
nodes:
  - id: review
    type: agentic
    skill: ct-validator
    profile: frontier-review
    model: claude-opus-4-8
    provider: anthropic
`;
    const { definition } = parsePlaybook(yaml);
    const dispatcher = makeRecorder();

    const result = await executePlaybook({
      db,
      playbook: definition,
      playbookHash: 'hash-t11759',
      initialContext: { taskId: 'T11759' },
      dispatcher,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(dispatcher.calls).toHaveLength(1);
    const call = dispatcher.calls[0];
    // The cantbook node identity reaches the dispatcher so it can build the
    // `cantbook:<playbook>#<nodeId>` system key (AC2 resolution input).
    expect(call?.playbookName).toBe('pinned-flow');
    expect(call?.nodeId).toBe('review');
    // The per-stage LLM pin is forwarded verbatim (the dispatcher resolves it
    // through `resolveCantbookNodeProfile` → E9).
    expect(call?.profile).toBe('frontier-review');
    expect(call?.model).toBe('claude-opus-4-8');
    expect(call?.provider).toBe('anthropic');
  });

  it('AC3: an un-pinned stage carries NO profile/model/provider (additive)', async () => {
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
      playbookHash: 'hash-t11759-b',
      initialContext: { taskId: 'T123' },
      dispatcher,
    });

    const call = dispatcher.calls[0];
    expect(call?.playbookName).toBe('plain-flow');
    expect(call?.profile).toBeUndefined();
    expect(call?.model).toBeUndefined();
    expect(call?.provider).toBeUndefined();
  });
});
