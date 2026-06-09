/**
 * Unit tests for the agent tool-call dispatch engine (T1740 · AC7 · epic T11456).
 *
 * Covers the full pipeline against a REAL registered tool (`read_file_paged`
 * over a temp dir through the deny-first guard) plus every error class, the
 * sync/async handler support, the budget caps (count + per-call timeout), and
 * the LLM-safe result formatting + redaction.
 *
 * @task T1740
 * @epic T11456
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentToolRegistry, createAgentToolRegistry } from '../agent-registry.js';
import {
  flattenZodIssues,
  formatToolResultForLlm,
  formatToolValueForLlm,
  MAX_TOOL_RESULT_CHARS,
  redactErrorMessage,
  ToolCallBudget,
  ToolDispatchEngine,
} from '../dispatch.js';
import { createToolGuard } from '../guard.js';

// ---------------------------------------------------------------------------
// Temp workspace + registry helpers
// ---------------------------------------------------------------------------

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'cleo-dispatch-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** A registry with the built-ins + a couple of synthetic tools for edge cases. */
async function buildRegistry(): Promise<AgentToolRegistry> {
  const registry = new AgentToolRegistry();
  // A synchronous (non-async) handler returning a plain value (AC2).
  registry.register({
    name: 'echo_sync',
    class: 'search',
    description: 'Echo the message back synchronously.',
    toolset: 'agent',
    stateless: true,
    parameters: z.object({ message: z.string() }),
    // NOTE: not declared async — returns a plain value, not a promise.
    execute: ((args: Record<string, unknown>) => ({ echoed: args.message })) as never,
  });
  // A handler that throws a raw error carrying a secret-looking token (AC3 redaction).
  registry.register({
    name: 'boom',
    class: 'search',
    description: 'Always throws.',
    toolset: 'agent',
    stateless: true,
    parameters: z.object({}),
    execute: async () => {
      throw new Error('exploded with key sk-ABCDEF1234567890SECRET trailing');
    },
  });
  // A slow async handler to exercise the per-call timeout (AC5).
  registry.register({
    name: 'slow',
    class: 'search',
    description: 'Sleeps.',
    toolset: 'agent',
    stateless: true,
    parameters: z.object({ ms: z.number() }),
    execute: async (args) =>
      new Promise((resolve) => setTimeout(() => resolve({ slept: args.ms }), Number(args.ms))),
  });
  // An availability-gated tool (AC5 — registry availability).
  registry.register({
    name: 'net_only',
    class: 'net',
    description: 'Only available with network egress.',
    toolset: 'web',
    stateless: true,
    available: (ctx) => ctx.networkEgressAllowed === true,
    parameters: z.object({}),
    execute: async () => ({ ok: true }),
  });
  await registry.init(); // also registers the real built-ins (read_file_paged, …)
  return registry;
}

/** Build an engine over the registry + an enforce-mode guard scoped to `workspace`. */
function buildEngine(registry: AgentToolRegistry, budget?: ToolCallBudget): ToolDispatchEngine {
  const tools = createToolGuard({ allowedRoots: [workspace], mode: 'enforce' });
  return new ToolDispatchEngine({ registry, tools, ...(budget ? { budget } : {}) });
}

// ---------------------------------------------------------------------------
// AC1 + AC2 + AC4 — dispatch a real registered tool
// ---------------------------------------------------------------------------

describe('ToolDispatchEngine.dispatch — real tool over a temp dir', () => {
  it('runs read_file_paged through the guard and formats the result for the LLM', async () => {
    const file = join(workspace, 'note.txt');
    await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
    const registry = await buildRegistry();
    const engine = buildEngine(registry);

    const result = await engine.dispatch({
      id: 'c1',
      name: 'read_file_paged',
      arguments: { path: file, offset: 0, limit: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.name).toBe('read_file_paged');
    // The display is the JSON-rendered paginated result — contains the read lines.
    expect(result.display).toContain('line1');
    expect(result.display).toContain('line2');
    expect(result.display).not.toContain('line3'); // limit honoured
  });

  it('supports a synchronous (non-async) handler returning a plain value (AC2)', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry);
    const result = await engine.dispatch({
      id: 'c2',
      name: 'echo_sync',
      arguments: { message: 'hi there' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.display).toContain('hi there');
  });
});

// ---------------------------------------------------------------------------
// AC3 — error classification (never throws; typed kinds)
// ---------------------------------------------------------------------------

describe('ToolDispatchEngine.dispatch — error classification', () => {
  it('classifies an unknown tool as tool-not-found', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry);
    const result = await engine.dispatch({ id: 'x', name: 'no_such_tool', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('tool-not-found');
    expect(result.code).toBe('E_TOOL_NOT_FOUND');
  });

  it('classifies bad arguments as invalid-args with flattened issues', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry);
    // read_file_paged requires `path: string`; omit it.
    const result = await engine.dispatch({ id: 'x', name: 'read_file_paged', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('invalid-args');
    expect(result.code).toBe('E_TOOL_INVALID_ARGS');
    expect(result.issues?.length).toBeGreaterThan(0);
    expect(result.issues?.[0]?.path).toBe('path');
  });

  it('classifies an unavailable tool as guard-denied', async () => {
    const registry = await buildRegistry();
    // No network egress in the availability context → net_only is hidden.
    const tools = createToolGuard({ allowedRoots: [workspace], mode: 'enforce' });
    const engine = new ToolDispatchEngine({
      registry,
      tools,
      availability: { networkEgressAllowed: false },
    });
    const result = await engine.dispatch({ id: 'x', name: 'net_only', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('guard-denied');
  });

  it('classifies a thrown executable as execution-error and REDACTS secrets (no leak)', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry);
    const result = await engine.dispatch({ id: 'x', name: 'boom', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('execution-error');
    expect(result.code).toBe('E_TOOL_EXECUTION_ERROR');
    // The raw error embedded a key-shaped token — it must be masked.
    expect(result.message).not.toContain('sk-ABCDEF1234567890SECRET');
    expect(result.message).toContain('[redacted]');
  });

  it('denies a guard violation DURING execution (path escape) as execution-error', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry); // guard scoped to `workspace`
    // read_file_paged a path OUTSIDE the allowed root → the guard throws inside execution.
    const result = await engine.dispatch({
      id: 'x',
      name: 'read_file_paged',
      arguments: { path: '/etc/hostname' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('execution-error');
    expect(result.message).toMatch(/allowed roots|denied|outside/i);
  });

  it('never throws — every failure mode is a returned result', async () => {
    const registry = await buildRegistry();
    const engine = buildEngine(registry);
    await expect(
      engine.dispatch({ id: 'x', name: 'no_such_tool', arguments: {} }),
    ).resolves.toBeDefined();
    await expect(engine.dispatch({ id: 'x', name: 'boom', arguments: {} })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC5 — budget tracking (count + per-call timeout)
// ---------------------------------------------------------------------------

describe('ToolCallBudget — call-count + timeout caps (AC5)', () => {
  it('denies a call once the maxCalls ceiling is reached', async () => {
    const registry = await buildRegistry();
    const budget = new ToolCallBudget({ maxCalls: 2 });
    const engine = buildEngine(registry, budget);
    const call = { id: 'c', name: 'echo_sync', arguments: { message: 'x' } };

    const r1 = await engine.dispatch(call);
    const r2 = await engine.dispatch(call);
    const r3 = await engine.dispatch(call);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    if (r3.ok) throw new Error('expected denial');
    expect(r3.kind).toBe('guard-denied');
    expect(r3.message).toMatch(/budget exhausted/i);

    const snap = engine.budgetSnapshot();
    expect(snap.callsUsed).toBe(2); // the denied 3rd call was NOT charged
    expect(snap.callsRemaining).toBe(0);
  });

  it('yields a timeout result when a call exceeds the per-call ceiling', async () => {
    const registry = await buildRegistry();
    const budget = new ToolCallBudget({ perCallTimeoutMs: 20 });
    const engine = buildEngine(registry, budget);
    const result = await engine.dispatch({ id: 't', name: 'slow', arguments: { ms: 200 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected timeout');
    expect(result.kind).toBe('timeout');
    expect(result.code).toBe('E_TOOL_TIMEOUT');
  });

  it('reports remaining headroom in the snapshot', async () => {
    const registry = await buildRegistry();
    const budget = new ToolCallBudget({ maxCalls: 5 });
    const engine = buildEngine(registry, budget);
    await engine.dispatch({ id: 'c', name: 'echo_sync', arguments: { message: 'x' } });
    const snap = engine.budgetSnapshot();
    expect(snap.callsUsed).toBe(1);
    expect(snap.callsRemaining).toBe(4);
    expect(snap.timeRemainingMs).toBe(Number.POSITIVE_INFINITY); // no time cap set
  });
});

// ---------------------------------------------------------------------------
// AC4 — result formatting + AC3 redaction helpers
// ---------------------------------------------------------------------------

describe('result formatting + redaction helpers', () => {
  it('formats a string value verbatim and an object as JSON', () => {
    expect(formatToolValueForLlm('hello')).toBe('hello');
    expect(formatToolValueForLlm({ a: 1 })).toContain('"a": 1');
    expect(formatToolValueForLlm(undefined)).toBe('');
  });

  it('truncates an oversized value with a marker', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 100);
    const out = formatToolValueForLlm(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
  });

  it('degrades a circular value instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatToolValueForLlm(circular)).not.toThrow();
  });

  it('projects a success result onto the tool_result payload (AC4)', async () => {
    const payload = formatToolResultForLlm(
      { id: 'c1' },
      { ok: true, name: 'echo_sync', value: { x: 1 }, display: '{"x":1}' },
    );
    expect(payload).toEqual({
      toolCallId: 'c1',
      toolName: 'echo_sync',
      content: '{"x":1}',
      isError: false,
    });
  });

  it('projects a failure result onto an error-flagged payload with the code', () => {
    const payload = formatToolResultForLlm(
      { id: 'c1' },
      {
        ok: false,
        name: 'read_file_paged',
        kind: 'invalid-args',
        code: 'E_TOOL_INVALID_ARGS',
        message: 'arguments failed validation',
        issues: [{ path: 'path', message: 'Required' }],
      },
    );
    expect(payload.isError).toBe(true);
    expect(payload.content).toContain('E_TOOL_INVALID_ARGS');
    expect(payload.content).toContain('path: Required');
  });

  it('redactErrorMessage strips secrets, stacks, and non-Error throws', () => {
    expect(redactErrorMessage(new Error('leak sk-1234567890ABCDEF here'))).toContain('[redacted]');
    expect(redactErrorMessage(new Error('Bearer abcdefghijkl1234 token'))).toContain(
      'Bearer [redacted]',
    );
    // Only the first line survives (no stack lines).
    expect(redactErrorMessage(new Error('one\ntwo\nthree'))).toBe('one');
    expect(redactErrorMessage(42)).toBe('tool execution failed');
  });

  it('flattenZodIssues produces path + message tuples', () => {
    const schema = z.object({ path: z.string(), n: z.number() });
    const parsed = schema.safeParse({ n: 'not-a-number' });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected parse failure');
    const issues = flattenZodIssues(parsed.error);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('path');
    expect(paths).toContain('n');
  });
});

// ---------------------------------------------------------------------------
// Convenience factory parity
// ---------------------------------------------------------------------------

describe('createAgentToolRegistry parity', () => {
  it('dispatches against a registry built via the convenience factory', async () => {
    const file = join(workspace, 'f.txt');
    await writeFile(file, 'abc\n', 'utf8');
    const registry = await createAgentToolRegistry();
    const tools = createToolGuard({ allowedRoots: [workspace], mode: 'enforce' });
    const engine = new ToolDispatchEngine({ registry, tools });
    const result = await engine.dispatch({ id: 'c', name: 'read_file', arguments: { path: file } });
    expect(result.ok).toBe(true);
  });
});
