/**
 * AC3 — one real Anthropic turn through the guarded Pi surface (creds-gated)
 * (T11761 · S2 · T11898).
 *
 * This is the end-to-end proof that the in-process Pi loop resolves a REAL model
 * via the E9 chokepoint (`resolveLLMForSystem` → `ModelRunner`) over the
 * Cleo-owned streamFn, and that one assistant turn completes. The wiring is REAL
 * — the only thing gated is the network call: the test SKIPS when no Anthropic
 * credential is reachable (CI without secrets), and runs locally / in
 * secret-enabled CI.
 *
 * The skip condition is resolved up-front via `resolveLLMForSystem` (the same
 * chokepoint the adapter uses), so the gate tracks the live credential state, not
 * just a raw env var.
 *
 * @epic T10403
 * @task T11761
 * @task T11898
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveLLMForSystem } from '../../system-resolver.js';
import { PiAgentAdapter } from '../pi-agent-adapter.js';

let hasCredential = false;

beforeAll(async () => {
  try {
    const resolved = await resolveLLMForSystem('task-executor');
    // E10 (T11753): the sealed-handle presence is the credential-availability
    // signal — the inline plaintext apiKey no longer exists on the envelope.
    hasCredential = Boolean(resolved.sealedCredential) || resolved.authType === 'aws_sdk';
  } catch {
    hasCredential = false;
  }
});

/** A guarded tool surface that records read calls (proves guard-routed access). */
function recordingTools(reads: string[]): GuardedToolSurface {
  return {
    async readFileText(input) {
      reads.push(input.path);
      return { path: input.path, content: 'CLEO is a task protocol.' };
    },
    async readJson<T>() {
      return {} as T;
    },
    async writeFileAtomic(input) {
      return { path: input.path, bytesWritten: 0 };
    },
    async pathExists() {
      return { exists: true, kind: 'file' };
    },
    async executeShell() {
      return { stdout: '', stderr: '', code: 0 };
    },
    async executePty() {
      return { stdout: '', stderr: '', code: 0, mode: 'spawn' as const, ptyFellBack: false };
    },
    async runGit() {
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

// The whole suite SKIPS when no credential resolves. `it` cannot `skipIf` on a
// value computed in beforeAll, so each test checks `hasCredential` and early-
// returns when absent (vitest still records them as passing no-ops).
describe('AC3: one real Anthropic turn over the guarded Pi surface', () => {
  it('completes a single assistant turn resolved via resolveLLMForSystem → ModelRunner', async () => {
    if (!hasCredential) {
      // No credential reachable — skip the network call. The wiring above is real.
      return;
    }
    const reads: string[] = [];
    const adapter = new PiAgentAdapter({ system: 'task-executor' });
    const result = await adapter.run('Reply with the single word: pong.', recordingTools(reads), {
      system: 'task-executor',
      sessionId: 'integration-session-1',
      agentId: null,
      parentSessionId: null,
    });

    // One real turn completed (resolved + streamed through the cleo chokepoint).
    expect(result.status).toBe('success');
    expect(typeof result.output).toBe('object');
    const text = (result.output as { text?: unknown }).text;
    expect(typeof text).toBe('string');
    expect(String(text).length).toBeGreaterThan(0);
  }, 60_000);
});
