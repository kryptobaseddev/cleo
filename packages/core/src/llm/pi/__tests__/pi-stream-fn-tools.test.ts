/**
 * Tool wire-through for the Cleo-owned Pi `StreamFn` (T1739 — registry
 * consumability).
 *
 * The agent registry (T1739) emits OpenAI-format tools via `toOpenAITools()`; the
 * Pi loop carries them on `Context.tools`. {@link createPiStreamFn} MUST project
 * those tools onto the per-call `SendOptions.tools` so `ConcreteSession` forwards
 * them onto `TransportRequest.tools` and the wire-level transport advertises them
 * to the model.
 *
 * These tests prove the `Context.tools → SendOptions.tools` link: the mocked
 * transport session records the `SendOptions` it receives, and we assert the
 * registry-shaped tools arrived (and that a tool-free context omits the field).
 * The resolver + ModelRunner are mocked — no real credential / network is needed.
 *
 * @epic T10403
 * @task T1739
 */

import type { NormalizedDelta } from '@cleocode/contracts';
import type { TransportTool } from '@cleocode/contracts/llm/normalized-response.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Mocks: resolver returns a credentialed envelope; ModelRunner returns a
//     session whose stream is a FINITE generator that records its SendOptions. ---

let receivedSendOptions: { tools?: readonly TransportTool[]; signal?: AbortSignal } | undefined;

vi.mock('../../system-resolver.js', () => ({
  resolveLLMForSystem: vi.fn(async () => ({
    provider: 'anthropic',
    model: 'mock-model',
    client: null,
    credential: {
      provider: 'anthropic',
      source: 'env',
      authType: 'api_key',
    },
    sealedCredential: {
      provider: 'anthropic',
      account: 'mock',
      fetch: async () => ({ __decryptedToken: 'DecryptedToken' as const, value: 'sk-mock' }),
    },
    source: 'role-config',
    apiMode: 'anthropic_messages',
    baseUrl: null,
    authType: 'api_key',
  })),
}));

vi.mock('../../model-runner.js', () => ({
  ModelRunner: {
    build: vi.fn(async () => ({
      languageModel: null,
      session: {
        // A finite stream: one chunk, then done. Records the SendOptions so the
        // test can assert the tool wire-through.
        stream(
          _messages: unknown,
          opts?: { tools?: readonly TransportTool[]; signal?: AbortSignal },
        ): AsyncIterable<NormalizedDelta> {
          receivedSendOptions = opts;
          let yielded = false;
          return {
            [Symbol.asyncIterator](): AsyncIterator<NormalizedDelta> {
              return {
                async next(): Promise<IteratorResult<NormalizedDelta>> {
                  if (yielded) return { done: true, value: undefined };
                  yielded = true;
                  return {
                    done: false,
                    value: { text: 'ok', reasoning: '', stopReason: 'stop', usage: null },
                  };
                },
              };
            },
          };
        },
      },
    })),
  },
}));

// Imported AFTER the mocks so the producer binds to the mocked modules.
const { createPiStreamFn } = await import('../pi-stream-fn.js');

afterEach(() => {
  receivedSendOptions = undefined;
  vi.clearAllMocks();
});

/** Drain a Pi event stream until its terminal `done`/`error`/`end`. */
async function drain(stream: {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string }>;
}): Promise<string[]> {
  const types: string[] = [];
  for await (const ev of stream as AsyncIterable<{ type: string }>) {
    types.push(ev.type);
  }
  return types;
}

describe('createPiStreamFn — tool wire-through (T1739 registry consumability)', () => {
  it('projects Context.tools onto SendOptions.tools → the transport', async () => {
    const streamFn = createPiStreamFn({
      system: 'task-executor',
      sessionId: 's-tools-1',
      agentId: null,
      parentSessionId: null,
    });
    // A registry-shaped Pi tool: { name, description, parameters: <JSON-schema> }.
    const piTool = {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    };
    const out = streamFn(
      { id: 'm', name: 'm', api: 'anthropic-messages', provider: 'p' } as never,
      { messages: [], tools: [piTool] } as never,
    );
    const types = await drain(out as never);
    expect(types).toContain('done');
    expect(receivedSendOptions?.tools).toHaveLength(1);
    const wired = receivedSendOptions?.tools?.[0];
    expect(wired?.name).toBe('read_file');
    expect(wired?.description).toBe('Read a file from disk');
    // The Pi Tool's `parameters` (TypeBox TSchema = JSON-schema object) passes
    // through verbatim onto `inputSchema` — no typebox value-import at the boundary.
    expect(wired?.inputSchema).toEqual(piTool.parameters);
  });

  it('omits SendOptions.tools when the context carries no tools', async () => {
    const streamFn = createPiStreamFn({
      system: 'task-executor',
      sessionId: 's-tools-2',
      agentId: null,
      parentSessionId: null,
    });
    const out = streamFn(
      { id: 'm', name: 'm', api: 'anthropic-messages', provider: 'p' } as never,
      { messages: [] } as never,
    );
    const types = await drain(out as never);
    expect(types).toContain('done');
    // A tool-free context MUST NOT set `tools` (so providers that reject an empty
    // tool list are unaffected).
    expect(receivedSendOptions?.tools).toBeUndefined();
  });
});
