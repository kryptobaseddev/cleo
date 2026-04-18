/**
 * T937 — Harness interop sandbox.
 *
 * Proves the Vercel-AI-SDK-backed provider adapters shipped in T933 can drive
 * the T930 playbook runtime end-to-end, and that the runtime itself stays
 * provider-agnostic (ADR-052 invariant).
 *
 * Test shape:
 *
 *  1. Three {@link AgentDispatcher} wrappers — `claude-sdk`, `openai-sdk`, and
 *     a zero-SDK "generic" dispatcher — each execute the `rcasd.cantbook`
 *     starter playbook end-to-end against an in-memory SQLite DB.
 *  2. A meta-test grep-asserts that `packages/playbooks/src/runtime.ts` does
 *     not import any provider SDK, locking down the architectural boundary
 *     that the SDK consolidation decision (ADR-052) depends on.
 *
 * Vercel AI SDK modules (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `ai`) are
 * mocked at the module level so no real network calls or credentials are
 * required. The `@cleocode/playbooks` runtime is imported from source via a
 * test-only Vitest alias (see `vitest.config.ts`) — NOT mocked — so the
 * dispatchers exercise real state-machine code.
 *
 * @task T937
 * @see T930 — Playbook runtime state machine
 * @see T933 — Vercel AI SDK migration for provider adapters
 * @see T934 — rcasd.cantbook starter playbook
 * @see ADR-052 — SDK consolidation decision
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import {
  type AgentDispatcher,
  type AgentDispatchInput,
  type AgentDispatchResult,
  executePlaybook,
  parsePlaybook,
} from '@cleocode/playbooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state — shared across all Vitest factory hoists
// ---------------------------------------------------------------------------

const { anthropicCalls, openaiCalls, mockState } = vi.hoisted(() => {
  return {
    anthropicCalls: [] as Array<{ model: unknown; prompt: string }>,
    openaiCalls: [] as Array<{ model: unknown; system?: string; prompt: string }>,
    mockState: {
      anthropicText: 'mocked anthropic response',
      openaiText: 'mocked openai response',
      shouldThrow: false,
    },
  };
});

// ---------------------------------------------------------------------------
// Vercel AI SDK mocks — no network, no credentials
// ---------------------------------------------------------------------------

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((_config: { apiKey: string }) => {
    return (modelId: string) => ({ __cleoMockModel: 'anthropic', modelId });
  }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((_config: { apiKey: string }) => {
    return (modelId: string) => ({ __cleoMockModel: 'openai', modelId });
  }),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(
    async ({ model, system, prompt }: { model: unknown; system?: string; prompt: string }) => {
      // Route by provider handle so each dispatcher's output is predictable.
      const handle = model as { __cleoMockModel?: string } | null;
      if (handle?.__cleoMockModel === 'anthropic') {
        anthropicCalls.push({ model, prompt });
        if (mockState.shouldThrow) throw new Error('mock anthropic SDK error');
        return { text: mockState.anthropicText };
      }
      if (handle?.__cleoMockModel === 'openai') {
        openaiCalls.push({ model, system, prompt });
        if (mockState.shouldThrow) throw new Error('mock openai SDK error');
        return { text: mockState.openaiText };
      }
      throw new Error('unexpected model handle passed to mock generateText');
    },
  ),
}));

// CANT enrichment is exercised by the real spawn providers. Stub it so tests
// don't require the cleo CLI to be installed in the sandbox.
vi.mock('../cant-context.js', () => ({
  buildCantEnrichedPrompt: vi.fn(
    async ({ basePrompt }: { basePrompt: string }) => `[CANT] ${basePrompt}`,
  ),
}));

// Disable conduit trace writes so the openai-sdk provider never spawns the
// `cleo` CLI from inside a test run.
vi.mock('../providers/shared/conduit-trace-writer.js', () => ({
  writeSpanToConduit: vi.fn(async () => ({ written: true })),
  writeSpanBatchToConduit: vi.fn(async () => 0),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks so factories take effect)
// ---------------------------------------------------------------------------

import { ClaudeSDKSpawnProvider } from '../providers/claude-sdk/spawn.js';
import { OpenAiSdkSpawnProvider } from '../providers/openai-sdk/spawn.js';

// ---------------------------------------------------------------------------
// node:sqlite bootstrap (mirrors runtime.test.ts pattern)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the T889 playbook-tables migration shipped with
 * `@cleocode/core`. Loading the SQL directly keeps the test hermetic without
 * re-implementing the schema inline.
 */
const MIGRATION_SQL = resolve(
  __dirname,
  '../../../core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/migration.sql',
);

/** Absolute path to the rcasd.cantbook starter playbook (T934). */
const RCASD_CANTBOOK = resolve(__dirname, '../../../playbooks/starter/rcasd.cantbook');

/** Absolute path to the runtime source we assert is SDK-free. */
const RUNTIME_SOURCE = resolve(__dirname, '../../../playbooks/src/runtime.ts');

/**
 * Apply a Drizzle migration split on `statement-breakpoint` to an in-memory
 * SQLite handle. Identical to the helper in `runtime.test.ts`.
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

// ---------------------------------------------------------------------------
// Dispatcher factories — wrap each SpawnProvider in the AgentDispatcher shape
// ---------------------------------------------------------------------------

/**
 * Coerce a {@link SpawnResult} into an {@link AgentDispatchResult}. Success
 * carries the output string under `output`, plus a per-dispatcher marker so
 * the playbook runtime can merge provenance into context on every node hop.
 */
function spawnResultToDispatch(
  result: SpawnResult,
  providerId: string,
  nodeId: string,
): AgentDispatchResult {
  if (result.status === 'completed') {
    return {
      status: 'success',
      output: {
        [`${nodeId}_output`]: result.output ?? '',
        [`${nodeId}_provider`]: providerId,
        lastProvider: providerId,
      },
    };
  }
  return {
    status: 'failure',
    output: {},
    error: result.error ?? `spawn failed on ${providerId}`,
  };
}

/**
 * Build an {@link AgentDispatcher} that routes every playbook `agentic` node
 * through the given {@link AdapterSpawnProvider}. Used to stand up the three
 * harness dispatchers exercised by this suite.
 *
 * @param provider - Real provider adapter (claude-sdk | openai-sdk).
 * @param providerId - Static id echoed into the merged context.
 * @returns An {@link AgentDispatcher} plus a `calls` trace for assertions.
 */
function mkProviderDispatcher(
  provider: AdapterSpawnProvider,
  providerId: string,
): AgentDispatcher & { calls: AgentDispatchInput[] } {
  const calls: AgentDispatchInput[] = [];
  return {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      calls.push(input);
      const context: SpawnContext = {
        taskId: input.taskId,
        prompt: `Execute node ${input.nodeId} for task ${input.taskId} (agent=${input.agentId}).`,
        options: { tier: 'worker', tracingDisabled: true, agentName: input.agentId },
      };
      const result = await provider.spawn(context);
      return spawnResultToDispatch(result, providerId, input.nodeId);
    },
  };
}

/**
 * Build an {@link AgentDispatcher} that has zero provider-SDK imports. This
 * emulates the "Pi / generic harness" shape — the playbook runtime must be
 * able to drive any dispatcher that satisfies the interface, which is the
 * invariant ADR-052 depends on.
 */
function mkGenericDispatcher(): AgentDispatcher & { calls: AgentDispatchInput[] } {
  const calls: AgentDispatchInput[] = [];
  return {
    calls,
    async dispatch(input: AgentDispatchInput): Promise<AgentDispatchResult> {
      calls.push(input);
      return {
        status: 'success',
        output: {
          [`${input.nodeId}_output`]: `generic:${input.nodeId}:ok`,
          [`${input.nodeId}_provider`]: 'generic',
          lastProvider: 'generic',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture — parsed rcasd.cantbook (starter playbook from T934)
// ---------------------------------------------------------------------------

const rcasdSource = readFileSync(RCASD_CANTBOOK, 'utf8');
const rcasdParsed = parsePlaybook(rcasdSource);
const rcasdDefinition = rcasdParsed.definition;
const rcasdHash = rcasdParsed.sourceHash;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('T937 — harness interop: playbook runtime across provider adapters', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigration(db, readFileSync(MIGRATION_SQL, 'utf8'));

    anthropicCalls.length = 0;
    openaiCalls.length = 0;
    mockState.shouldThrow = false;
    mockState.anthropicText = 'anthropic node output';
    mockState.openaiText = 'openai node output';

    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-test';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
  });

  afterEach(() => {
    db.close();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1 · claude-sdk adapter drives rcasd.cantbook end-to-end
  // -------------------------------------------------------------------------
  it('claude-sdk adapter dispatches rcasd.cantbook to completion', async () => {
    const provider = new ClaudeSDKSpawnProvider();
    const dispatcher = mkProviderDispatcher(provider, 'claude-sdk');

    const result = await executePlaybook({
      db,
      playbook: rcasdDefinition,
      playbookHash: rcasdHash,
      initialContext: { taskId: 'T937-claude', epicId: 'T910' },
      dispatcher,
      approvalSecret: 'harness-interop-test',
    });

    expect(result.terminalStatus).toBe('completed');
    // Every rcasd node must have been dispatched exactly once (happy path).
    expect(dispatcher.calls.map((c) => c.nodeId)).toEqual([
      'research',
      'consensus',
      'architecture',
      'specification',
      'decomposition',
    ]);
    // The last-merged provider marker confirms the dispatcher actually ran.
    expect(result.finalContext['lastProvider']).toBe('claude-sdk');
    // Per-node provider markers are merged into context.
    expect(result.finalContext['research_provider']).toBe('claude-sdk');
    expect(result.finalContext['decomposition_provider']).toBe('claude-sdk');
    // Each node triggered exactly one generateText call (no retries required).
    expect(anthropicCalls).toHaveLength(5);
    expect(openaiCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2 · openai-sdk adapter drives rcasd.cantbook end-to-end
  // -------------------------------------------------------------------------
  it('openai-sdk adapter dispatches rcasd.cantbook to completion', async () => {
    const provider = new OpenAiSdkSpawnProvider();
    const dispatcher = mkProviderDispatcher(provider, 'openai-sdk');

    const result = await executePlaybook({
      db,
      playbook: rcasdDefinition,
      playbookHash: rcasdHash,
      initialContext: { taskId: 'T937-openai', epicId: 'T910' },
      dispatcher,
      approvalSecret: 'harness-interop-test',
    });

    expect(result.terminalStatus).toBe('completed');
    expect(dispatcher.calls.map((c) => c.nodeId)).toEqual([
      'research',
      'consensus',
      'architecture',
      'specification',
      'decomposition',
    ]);
    expect(result.finalContext['lastProvider']).toBe('openai-sdk');
    expect(result.finalContext['consensus_provider']).toBe('openai-sdk');
    expect(result.finalContext['specification_provider']).toBe('openai-sdk');
    // openai-sdk uses standalone agents (no handoffs here) so 1 call per node.
    expect(openaiCalls).toHaveLength(5);
    expect(anthropicCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3 · generic dispatcher proves the runtime is provider-agnostic
  // -------------------------------------------------------------------------
  it('generic (zero-SDK) dispatcher executes rcasd.cantbook end-to-end', async () => {
    const dispatcher = mkGenericDispatcher();

    const result = await executePlaybook({
      db,
      playbook: rcasdDefinition,
      playbookHash: rcasdHash,
      initialContext: { taskId: 'T937-generic', epicId: 'T910' },
      dispatcher,
      approvalSecret: 'harness-interop-test',
    });

    expect(result.terminalStatus).toBe('completed');
    expect(dispatcher.calls.map((c) => c.nodeId)).toEqual([
      'research',
      'consensus',
      'architecture',
      'specification',
      'decomposition',
    ]);
    expect(result.finalContext['lastProvider']).toBe('generic');
    // Generic path MUST NOT invoke either SDK.
    expect(anthropicCalls).toHaveLength(0);
    expect(openaiCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4 · Cross-provider run matrix — single playbook parse, three adapters
  // -------------------------------------------------------------------------
  it('same parsed playbook executes identically across all three adapters', async () => {
    const providers: Array<[string, AgentDispatcher & { calls: AgentDispatchInput[] }]> = [
      ['claude-sdk', mkProviderDispatcher(new ClaudeSDKSpawnProvider(), 'claude-sdk')],
      ['openai-sdk', mkProviderDispatcher(new OpenAiSdkSpawnProvider(), 'openai-sdk')],
      ['generic', mkGenericDispatcher()],
    ];

    const results: Array<{ providerId: string; terminal: string; nodeCount: number }> = [];
    for (const [providerId, dispatcher] of providers) {
      // Reset per-provider state so DB rows don't collide.
      const freshDb = new DatabaseSync(':memory:');
      freshDb.exec('PRAGMA foreign_keys=ON');
      applyMigration(freshDb, readFileSync(MIGRATION_SQL, 'utf8'));

      const result = await executePlaybook({
        db: freshDb,
        playbook: rcasdDefinition,
        playbookHash: rcasdHash,
        initialContext: { taskId: `T937-${providerId}`, epicId: 'T910' },
        dispatcher,
        approvalSecret: 'harness-interop-test',
      });

      results.push({
        providerId,
        terminal: result.terminalStatus,
        nodeCount: dispatcher.calls.length,
      });
      freshDb.close();
    }

    for (const r of results) {
      expect(r.terminal).toBe('completed');
      expect(r.nodeCount).toBe(5);
    }
  });

  // -------------------------------------------------------------------------
  // 5 · Architectural invariant — runtime code is SDK-free (ADR-052)
  // -------------------------------------------------------------------------
  it('zero provider-SDK imports leak into @cleocode/playbooks runtime', () => {
    const runtimeSource = readFileSync(RUNTIME_SOURCE, 'utf8');

    // Strip comments/docstrings before grepping so narrative mentions of the
    // SDKs in TSDoc don't create false positives. Keep it conservative — we
    // only strip /** ... */ and // ... EOL; inline string literals are fine.
    const codeOnly = runtimeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    // Banned substrings — must not appear in non-comment source.
    const banned: ReadonlyArray<{ needle: string; hint: string }> = [
      { needle: '@ai-sdk/', hint: 'Vercel AI SDK provider packages' },
      { needle: '@anthropic-ai/claude-agent-sdk', hint: 'legacy Claude agent SDK' },
      { needle: '@anthropic-ai/sdk', hint: 'Anthropic raw SDK' },
      { needle: '@openai/agents', hint: 'legacy OpenAI agents SDK' },
      { needle: 'openai', hint: 'OpenAI client package' },
      { needle: "from 'ai'", hint: 'Vercel AI SDK root package' },
      { needle: 'from "ai"', hint: 'Vercel AI SDK root package (double-quoted)' },
    ];

    const leaks = banned.filter(({ needle }) => codeOnly.includes(needle));
    expect(
      leaks,
      `SDK leakage detected in runtime.ts — ADR-052 invariant violated: ${leaks
        .map((l) => `${l.needle} (${l.hint})`)
        .join(', ')}`,
    ).toEqual([]);
  });
});
