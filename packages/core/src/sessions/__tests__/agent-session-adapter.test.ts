/**
 * Unit tests for the CLEO AgentSession adapter — T947 Step 2.
 *
 * The adapter delegates to `llmtxt/sdk.AgentSession`, backed by a
 * lightweight `createBackend({ topology: 'standalone' })` instance.
 * That backend requires llmtxt's optional peer deps
 * (`better-sqlite3` + `drizzle-orm/better-sqlite3`); when absent we
 * MUST degrade to `{ result, receipt: null }` without throwing.
 *
 * Test matrix:
 *   1. Happy path (peer deps present)   — result + non-null receipt
 *                                         with shape assertions.
 *   2. Peer-dep missing                  — result + receipt === null.
 *   3. Wrapped function throws           — error propagates, no
 *                                         receipt emitted, no
 *                                         receipts.jsonl line written.
 *   4. Receipt persistence               — line appears in
 *                                         `.cleo/audit/receipts.jsonl`
 *                                         when happy path runs.
 *   5. Explicit sessionId passthrough    — receipt.sessionId matches
 *                                         the caller-supplied id.
 *   6. Multiple sequential wraps         — each produces a unique
 *                                         sessionId, two receipts on
 *                                         disk, independent state.
 *   7. `openAgentSession` /                — handle returned when peer
 *      `closeAgentSession` round-trip      deps present; null
 *                                          otherwise.
 *
 * Peer-dep-gated tests are wrapped in `describe.skipIf(!peerDepsOk)`
 * so CI environments without native modules skip silently rather
 * than fail (mirrors `llmtxt-blob-adapter.test.ts` pattern).
 *
 * @task T947
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeAgentSession,
  getReceiptsAuditPath,
  openAgentSession,
  wrapWithAgentSession,
} from '../agent-session-adapter.js';

/**
 * Probe whether llmtxt can actually open a standalone LocalBackend in
 * this environment. llmtxt resolves `better-sqlite3` from its own
 * nested `node_modules`, so an import probe from `@cleocode/core` is
 * UNRELIABLE (pnpm hoisting may or may not expose the dep to us).
 * The only deterministic probe is to attempt the real open+close.
 *
 * When this returns `false`, the happy-path describe block is skipped
 * and the peer-deps-missing fallback block runs.
 */
async function canOpenLlmtxtBackend(): Promise<boolean> {
  const probeDir = await mkdtemp(join(tmpdir(), 'cleo-adapter-probe-'));
  try {
    const llmtxtMod = await import('llmtxt');
    const backend = await llmtxtMod.createBackend({
      topology: 'standalone',
      storagePath: join(probeDir, '.cleo', 'llmtxt'),
    });
    await backend.open();
    await backend.close();
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

const peerDepsOk = await canOpenLlmtxtBackend();

// ─── Peer-dep-agnostic tests (always run) ────────────────────────────────────

describe('agent-session-adapter — peer-dep-agnostic surface', () => {
  it('getReceiptsAuditPath returns .cleo/audit/receipts.jsonl under root', () => {
    const path = getReceiptsAuditPath('/tmp/my-project');
    expect(path.endsWith('.cleo/audit/receipts.jsonl')).toBe(true);
    expect(path.startsWith('/tmp/my-project')).toBe(true);
  });

  it('wrapWithAgentSession always runs the wrapped fn and returns its value', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-'));
    try {
      const { result } = await wrapWithAgentSession(
        { projectRoot: tempDir, agentId: 'test-agent' },
        async () => 'hello-world',
      );
      expect(result).toBe('hello-world');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapWithAgentSession propagates errors thrown by the wrapped fn', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-'));
    try {
      await expect(
        wrapWithAgentSession({ projectRoot: tempDir, agentId: 'test-agent' }, async () => {
          throw new Error('wrapped failure');
        }),
      ).rejects.toThrow('wrapped failure');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('wrapWithAgentSession does not write receipts.jsonl when fn throws', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-'));
    try {
      await expect(
        wrapWithAgentSession({ projectRoot: tempDir, agentId: 'test-agent' }, async () => {
          throw new Error('wrapped failure');
        }),
      ).rejects.toThrow();
      const receiptsPath = getReceiptsAuditPath(tempDir);
      // File MUST NOT exist: either fs.stat throws ENOENT, OR the
      // file exists but is empty. We assert the ENOENT path because
      // the adapter never calls persistReceipt on the error branch.
      await expect(stat(receiptsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ─── Happy-path tests (require better-sqlite3 + drizzle) ─────────────────────

describe.skipIf(!peerDepsOk)('agent-session-adapter — peer deps present', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-hp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('wrapWithAgentSession returns a ContributionReceipt on happy path', async () => {
    const { result, receipt } = await wrapWithAgentSession(
      { projectRoot: tempDir, agentId: 'test-agent' },
      async () => ({ ok: true }),
    );
    expect(result).toEqual({ ok: true });
    expect(receipt).not.toBeNull();
    if (receipt === null) return; // narrow for TypeScript

    // Shape assertions from llmtxt/sdk/session.ts::ContributionReceipt.
    expect(typeof receipt.sessionId).toBe('string');
    expect(receipt.sessionId.length).toBeGreaterThan(0);
    expect(receipt.agentId).toBe('test-agent');
    expect(Array.isArray(receipt.documentIds)).toBe(true);
    expect(receipt.eventCount).toBe(1); // exactly one contribute() call
    expect(typeof receipt.openedAt).toBe('string');
    expect(typeof receipt.closedAt).toBe('string');
    expect(new Date(receipt.openedAt).getTime()).toBeLessThanOrEqual(
      new Date(receipt.closedAt).getTime(),
    );
    expect(typeof receipt.sessionDurationMs).toBe('number');
    expect(receipt.sessionDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('persists each receipt to .cleo/audit/receipts.jsonl as one JSON line', async () => {
    const { receipt } = await wrapWithAgentSession(
      { projectRoot: tempDir, agentId: 'test-agent' },
      async () => ({}),
    );
    expect(receipt).not.toBeNull();

    const receiptsPath = getReceiptsAuditPath(tempDir);
    const contents = await readFile(receiptsPath, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as { sessionId: string };
    expect(parsed.sessionId).toBe(receipt?.sessionId);
  });

  it('passes caller-supplied sessionId through to the receipt', async () => {
    const explicitId = 'cleo-session-test-12345';
    const { receipt } = await wrapWithAgentSession(
      { projectRoot: tempDir, agentId: 'test-agent', sessionId: explicitId },
      async () => ({}),
    );
    expect(receipt?.sessionId).toBe(explicitId);
  });

  it('multiple sequential wraps produce distinct receipts', async () => {
    const first = await wrapWithAgentSession(
      { projectRoot: tempDir, agentId: 'test-agent' },
      async () => 1,
    );
    const second = await wrapWithAgentSession(
      { projectRoot: tempDir, agentId: 'test-agent' },
      async () => 2,
    );
    expect(first.receipt?.sessionId).not.toBe(second.receipt?.sessionId);
    expect(first.receipt?.eventCount).toBe(1);
    expect(second.receipt?.eventCount).toBe(1);

    const lines = (await readFile(getReceiptsAuditPath(tempDir), 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });

  it('openAgentSession / closeAgentSession round-trip emits a receipt', async () => {
    const handle = await openAgentSession({
      projectRoot: tempDir,
      agentId: 'test-agent',
    });
    expect(handle).not.toBeNull();
    if (handle === null) return;
    expect(handle.session.getState()).toBe('Active');
    expect(handle.projectRoot).toBe(tempDir);

    // Simulate a zero-contribution session — receipt still emits with
    // eventCount=0 (valid per llmtxt spec §4.1).
    const receipt = await closeAgentSession(handle);
    expect(receipt).not.toBeNull();
    expect(receipt?.eventCount).toBe(0);
    expect(receipt?.agentId).toBe('test-agent');
  });
});

// ─── Peer-dep-missing fallback (runs only when deps absent) ──────────────────

describe.skipIf(peerDepsOk)('agent-session-adapter — peer deps missing', () => {
  it('returns {result, receipt: null} without throwing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-nd-'));
    try {
      const { result, receipt } = await wrapWithAgentSession(
        { projectRoot: tempDir, agentId: 'test-agent' },
        async () => 'fallback-ok',
      );
      expect(result).toBe('fallback-ok');
      expect(receipt).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('openAgentSession returns null when peer deps absent', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-agent-adapter-nd-'));
    try {
      const handle = await openAgentSession({ projectRoot: tempDir });
      expect(handle).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
