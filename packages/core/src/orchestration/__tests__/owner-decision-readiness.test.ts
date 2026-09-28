/**
 * Needs-human-decision check for the readiness grill gate as ONE System One
 * `noul` question (T12494).
 *
 * Driven against a local HTTP stub of the Jev `/v1/systemone` endpoint — never
 * the real provider.
 *
 * @task T12494
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../../decide/audit.js';
import { createMemoryTokenBucket } from '../../decide/budget.js';
import type { DecideOptions } from '../../decide/client.js';
import { classifyReadiness } from '../classify-readiness.js';
import {
  classifyReadinessWithDecision,
  OWNER_DECISION_BUDGET_MS,
  OWNER_DECISION_SITE,
  resolveOwnerDecisionSignal,
} from '../owner-decision-readiness.js';

// ---------------------------------------------------------------------------
// Local Jev stub
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
/** P(owner decision needed) the stub answers with; `slow` never answers in budget. */
let stub: { p: number; confidence: number; slow?: boolean } = { p: 0.9, confidence: 0.9 };
const received: Array<Record<string, unknown>> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model?: string };
    received.push(body);
    if (stub.slow) await new Promise((r) => setTimeout(r, 2_000));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        model: body.model,
        answers: { owner: { type: 'noul', noul: stub.p, confidence: stub.confidence } },
        meta: { request_id: 'req_stub' },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function memoryAudit(): DecisionAuditSink & { entries: DecisionAuditEntry[] } {
  const entries: DecisionAuditEntry[] = [];
  return { entries, write: (e) => entries.push(e) };
}

function stubWiring(audit: DecisionAuditSink): DecideOptions {
  return {
    connection: { baseUrl, apiKey: 'sk-test-SECRET-1234', model: 'stub-model' },
    budget: createMemoryTokenBucket(),
    cache: null,
    audit,
  };
}

let projectDir: string;
let homeDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  stub = { p: 0.9, confidence: 0.9 };
  received.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-owner-dec-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-owner-dec-home-'));
  savedHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = homeDir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function task(blockedBy: string | undefined, labels: string[] = []): Task {
  return {
    id: 'T900',
    title: 'Pick the vendor integration',
    description: 'Integrate the chosen payments vendor',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    acceptance: ['Vendor integration merged'],
    labels,
    ...(blockedBy !== undefined ? { blockedBy } : {}),
    createdAt: '2026-09-28T00:00:00.000Z',
  } as Task;
}

/** No "owner"/"decision" substring — the rule proceeds; a human must still choose. */
const HUMAN_BLOCK = 'waiting on legal to choose a vendor';
/** Contains "decision" — the rule grills; it is only waiting on another task. */
const TASK_BLOCK = 'blocked on T12 (decision-store refactor) landing';

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

describe('classifyReadiness — ownerDecision signal', () => {
  it('a confident signal replaces the substring rule, both ways', () => {
    const flag = { required: true, probability: 0.9, confidence: 0.9 };
    const clear = { required: false, probability: 0.1, confidence: 0.9 };
    expect(classifyReadiness(task(HUMAN_BLOCK), { ownerDecision: flag }).triggers).toContain(
      'OWNER_DECISION_REQUIRED',
    );
    expect(classifyReadiness(task(TASK_BLOCK), { ownerDecision: clear }).verdict).toBe('proceed');
  });

  it('below the 0.6 floor the substring rule decides', () => {
    const unsure = { required: false, probability: 0.1, confidence: 0.4 };
    expect(classifyReadiness(task(TASK_BLOCK), { ownerDecision: unsure }).triggers).toContain(
      'OWNER_DECISION_REQUIRED',
    );
  });

  it('the owner-decision label always wins', () => {
    const clear = { required: false, probability: 0.1, confidence: 0.9 };
    expect(
      classifyReadiness(task(TASK_BLOCK, ['owner-decision']), { ownerDecision: clear }).triggers,
    ).toContain('OWNER_DECISION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// System One question
// ---------------------------------------------------------------------------

describe('resolveOwnerDecisionSignal', () => {
  it('no blockedBy: never asks', async () => {
    const signal = await resolveOwnerDecisionSignal(task(undefined), {
      mode: 'on',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(signal).toBeNull();
    expect(received).toHaveLength(0);
  });

  it('owner-decision label: never asks', async () => {
    await resolveOwnerDecisionSignal(task(HUMAN_BLOCK, ['Owner-Decision']), {
      mode: 'on',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(received).toHaveLength(0);
  });

  it('unconfigured: never asks', async () => {
    const signal = await resolveOwnerDecisionSignal(task(HUMAN_BLOCK), {
      decide: { connection: null },
      projectRoot: projectDir,
    });
    expect(signal).toBeNull();
    expect(received).toHaveLength(0);
  });

  it('shadow: ONE noul question, no signal, verdict unchanged, both answers audited', async () => {
    const audit = memoryAudit();
    const t = task(HUMAN_BLOCK);
    const result = await classifyReadinessWithDecision(
      t,
      {},
      { mode: 'shadow', decide: stubWiring(audit), projectRoot: projectDir },
    );

    expect(result).toEqual(classifyReadiness(t));
    expect(result.verdict).toBe('proceed');
    expect(received).toHaveLength(1);
    const questions = received[0]?.['questions'] as Record<string, { criteria: unknown }>;
    expect(Object.keys(questions)).toEqual(['owner']);
    expect(received[0]?.['state']).toMatchObject({ blockedBy: HUMAN_BLOCK });

    const entry = audit.entries[0]!;
    expect(entry.site).toBe(OWNER_DECISION_SITE);
    expect(entry.answers['owner']?.value).toBe(true);
    expect(entry.shadow).toMatchObject({
      mode: 'shadow',
      acted: 'heuristic',
      heuristicVerdict: 'none',
      agree: false,
      subjects: { owner: 'T900' },
    });
  });

  it('on + confident yes: flags a block the substring rule missed, and says to use the ask tool', async () => {
    const result = await classifyReadinessWithDecision(
      task(HUMAN_BLOCK),
      {},
      { mode: 'on', decide: stubWiring(memoryAudit()), projectRoot: projectDir },
    );
    expect(result.verdict).toBe('grill');
    expect(result.triggers).toEqual(['OWNER_DECISION_REQUIRED']);
    expect(result.reason).toContain('System One');
    expect(result.reason).toContain('ask tool');
  });

  it('on + confident no: clears a substring false positive', async () => {
    stub = { p: 0.05, confidence: 0.9 };
    const result = await classifyReadinessWithDecision(
      task(TASK_BLOCK),
      {},
      { mode: 'on', decide: stubWiring(memoryAudit()), projectRoot: projectDir },
    );
    expect(result.verdict).toBe('proceed');
  });

  it('on + below the floor: the substring rule decides', async () => {
    stub = { p: 0.05, confidence: 0.4 };
    const result = await classifyReadinessWithDecision(
      task(TASK_BLOCK),
      {},
      { mode: 'on', decide: stubWiring(memoryAudit()), projectRoot: projectDir },
    );
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
  });

  it('a hanging provider costs at most the budget and the substring rule decides', async () => {
    stub = { p: 0.05, confidence: 0.9, slow: true };
    const audit = memoryAudit();
    const started = performance.now();
    const result = await classifyReadinessWithDecision(
      task(TASK_BLOCK),
      {},
      { mode: 'on', decide: stubWiring(audit), projectRoot: projectDir },
    );
    expect(performance.now() - started).toBeLessThan(OWNER_DECISION_BUDGET_MS + 200);
    expect(result.triggers).toContain('OWNER_DECISION_REQUIRED');
    expect(audit.entries[0]?.fallbackReason).toBe('timeout');
  });

  it('redacts, then clips: a secret straddling the blockedBy cut never leaves the machine', async () => {
    const pad = 'waiting on ops to rotate the deploy credential for the release runner. '
      .repeat(5)
      .slice(0, 280);
    await resolveOwnerDecisionSignal(task(`${pad} token ghp_${'A'.repeat(36)}`), {
      mode: 'shadow',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain('ghp_');
  });
});
