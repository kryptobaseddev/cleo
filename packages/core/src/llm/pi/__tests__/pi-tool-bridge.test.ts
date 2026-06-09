/**
 * Pi ↔ dispatch-engine bridge tests (T1740 · AC6 · AC7 · epic T11456).
 *
 * Proves the CLOSED tool-call loop for the in-process Pi runner: when the model
 * emits a tool call, the `AgentTool.execute` the bridge built routes the call
 * THROUGH the T1740 dispatch engine, runs the real registered tool over the
 * guarded surface, and returns the formatted result the loop feeds back. This is
 * the deterministic proof of AC6 that needs no live LLM credential — it simulates
 * exactly what `pi-agent-core`'s loop does when it invokes a tool the model named.
 *
 * @task T1740
 * @epic T11456
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentToolRegistry } from '../../../tools/agent-registry.js';
import { ToolCallBudget, ToolDispatchEngine } from '../../../tools/dispatch.js';
import { createToolGuard } from '../../../tools/guard.js';
import { buildPiAgentTools } from '../pi-tool-bridge.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'cleo-pi-bridge-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Build the engine + projected AgentTools exactly as PiAgentAdapter does. */
async function buildBridge(budget?: ToolCallBudget) {
  const registry = await createAgentToolRegistry();
  const tools = createToolGuard({ allowedRoots: [workspace], mode: 'enforce' });
  const engine = new ToolDispatchEngine({ registry, tools, ...(budget ? { budget } : {}) });
  const agentTools = buildPiAgentTools(engine, registry);
  return { engine, agentTools };
}

describe('buildPiAgentTools — closes the tool-call loop (AC6)', () => {
  it('projects every registry tool into an executable AgentTool with a JSON-schema', async () => {
    const { agentTools } = await buildBridge();
    expect(agentTools.length).toBeGreaterThan(0);
    const readPaged = agentTools.find((t) => t.name === 'read_file_paged');
    expect(readPaged).toBeDefined();
    expect(readPaged?.label).toBe('read_file_paged');
    // The schema is a plain JSON-Schema object (Gate-10 — no typebox).
    expect(readPaged?.parameters).toMatchObject({ type: 'object' });
    expect(typeof readPaged?.execute).toBe('function');
  });

  it('a model tool-call (execute) actually RUNS the registered tool through the guard', async () => {
    const file = join(workspace, 'doc.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8');
    const { agentTools } = await buildBridge();
    const readPaged = agentTools.find((t) => t.name === 'read_file_paged');
    if (!readPaged) throw new Error('read_file_paged missing');

    // Simulate exactly what the Pi loop does: invoke execute with the toolCallId
    // + the model-validated params object.
    const result = await readPaged.execute('call-1', { path: file, offset: 0, limit: 2 });

    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('alpha');
    expect(result.content[0]?.text).toContain('beta');
    expect(result.details.ok).toBe(true);
  });

  it('feeds back a classified, redacted error when the tool call is denied (never throws)', async () => {
    const { agentTools } = await buildBridge();
    const readPaged = agentTools.find((t) => t.name === 'read_file_paged');
    if (!readPaged) throw new Error('read_file_paged missing');
    // Path OUTSIDE the workspace → the guard denies it during execution.
    const result = await readPaged.execute('call-2', { path: '/etc/hostname' });
    expect(result.details.ok).toBe(false);
    if (result.details.ok) throw new Error('expected failure detail');
    expect(result.details.kind).toBe('execution-error');
    // The content carries the classified code for the model.
    expect(result.content[0]?.text).toContain('E_TOOL_EXECUTION_ERROR');
  });

  it('reports invalid-args back to the model with the field path', async () => {
    const { agentTools } = await buildBridge();
    const readPaged = agentTools.find((t) => t.name === 'read_file_paged');
    if (!readPaged) throw new Error('read_file_paged missing');
    // Missing required `path`.
    const result = await readPaged.execute('call-3', {});
    expect(result.details.ok).toBe(false);
    if (result.details.ok) throw new Error('expected failure');
    expect(result.details.kind).toBe('invalid-args');
    expect(result.content[0]?.text).toContain('path');
  });

  it('shares ONE run-scoped budget across all projected tools (AC5)', async () => {
    const file = join(workspace, 'b.txt');
    await writeFile(file, 'x\n', 'utf8');
    const budget = new ToolCallBudget({ maxCalls: 1 });
    const { engine, agentTools } = await buildBridge(budget);
    const readPaged = agentTools.find((t) => t.name === 'read_file_paged');
    const readFile = agentTools.find((t) => t.name === 'read_file');
    if (!readPaged || !readFile) throw new Error('tools missing');

    const r1 = await readPaged.execute('c1', { path: file });
    // Second call (a DIFFERENT tool) is denied — the budget is shared, not per-tool.
    const r2 = await readFile.execute('c2', { path: file });
    expect(r1.details.ok).toBe(true);
    expect(r2.details.ok).toBe(false);
    if (r2.details.ok) throw new Error('expected denial');
    expect(r2.details.kind).toBe('guard-denied');
    expect(engine.budgetSnapshot().callsRemaining).toBe(0);
  });
});
