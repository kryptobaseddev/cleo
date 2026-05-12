/**
 * Tests for the CLEO observability event bus (ADR-071 / T1651).
 *
 * Shape and contract tests — verifies that appendEvent emits the correct
 * event shape to the file transport (conduit transport is integration-only).
 *
 * @task T1651
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendEvent,
  type CleoAgentEvent,
  type CleoAgentEventKind,
  resolveEventTransportMode,
} from '../event-bus.js';

const TMP_ROOT = '/tmp/cleo-event-bus-test';

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  // Force file transport for unit tests (no Conduit setup needed).
  process.env['CLEO_EVENTS_TRANSPORT'] = 'file';
});

afterEach(async () => {
  delete process.env['CLEO_EVENTS_TRANSPORT'];
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe('resolveEventTransportMode', () => {
  it('defaults to conduit when env is unset', () => {
    delete process.env['CLEO_EVENTS_TRANSPORT'];
    expect(resolveEventTransportMode()).toBe('conduit');
  });

  it('returns file when CLEO_EVENTS_TRANSPORT=file', () => {
    process.env['CLEO_EVENTS_TRANSPORT'] = 'file';
    expect(resolveEventTransportMode()).toBe('file');
  });

  it('returns conduit for any other value', () => {
    process.env['CLEO_EVENTS_TRANSPORT'] = 'something-unknown';
    expect(resolveEventTransportMode()).toBe('conduit');
  });
});

describe('appendEvent — file transport', () => {
  const kinds: CleoAgentEventKind[] = [
    'spawn',
    'heartbeat',
    'tool-start',
    'tool-end',
    'commit',
    'blocked',
    'complete',
  ];

  for (const kind of kinds) {
    it(`appends a valid ${kind} event to the agent log file`, async () => {
      const agentId = `test-agent-${kind}`;
      await appendEvent(kind, 'T9000', agentId, TMP_ROOT);

      const logPath = join(TMP_ROOT, '.cleo', 'agent-events', `${agentId}.jsonl`);
      expect(existsSync(logPath)).toBe(true);

      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);

      const event = JSON.parse(lines[0] as string) as CleoAgentEvent;
      expect(event.kind).toBe(kind);
      expect(event.taskId).toBe('T9000');
      expect(event.agentId).toBe(agentId);
      expect(typeof event.timestamp).toBe('string');
      expect(() => new Date(event.timestamp)).not.toThrow();
    });
  }

  it('appends multiple events to the same file', async () => {
    const agentId = 'test-multi-agent';
    await appendEvent('spawn', 'T9001', agentId, TMP_ROOT);
    await appendEvent('heartbeat', 'T9001', agentId, TMP_ROOT);
    await appendEvent('complete', 'T9001', agentId, TMP_ROOT);

    const logPath = join(TMP_ROOT, '.cleo', 'agent-events', `${agentId}.jsonl`);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);

    const events = lines.map((l) => JSON.parse(l) as CleoAgentEvent);
    expect(events[0]?.kind).toBe('spawn');
    expect(events[1]?.kind).toBe('heartbeat');
    expect(events[2]?.kind).toBe('complete');
  });

  it('stores payload when provided', async () => {
    const agentId = 'test-payload-agent';
    await appendEvent('tool-start', 'T9002', agentId, TMP_ROOT, { tool: 'Bash', call: 42 });

    const logPath = join(TMP_ROOT, '.cleo', 'agent-events', `${agentId}.jsonl`);
    const event = JSON.parse(readFileSync(logPath, 'utf-8').trim()) as CleoAgentEvent;
    expect(event.payload).toEqual({ tool: 'Bash', call: 42 });
  });

  it('omits payload key when payload is undefined', async () => {
    const agentId = 'test-nopayload-agent';
    await appendEvent('heartbeat', 'T9003', agentId, TMP_ROOT);

    const logPath = join(TMP_ROOT, '.cleo', 'agent-events', `${agentId}.jsonl`);
    const event = JSON.parse(readFileSync(logPath, 'utf-8').trim()) as CleoAgentEvent;
    expect(event.payload).toBeUndefined();
  });

  it('creates separate log files per agentId', async () => {
    await appendEvent('spawn', 'T9004', 'agent-alpha', TMP_ROOT);
    await appendEvent('spawn', 'T9004', 'agent-beta', TMP_ROOT);

    const dir = join(TMP_ROOT, '.cleo', 'agent-events');
    expect(existsSync(join(dir, 'agent-alpha.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'agent-beta.jsonl'))).toBe(true);
  });

  it('does not throw when project root is non-existent (best-effort)', async () => {
    await expect(
      appendEvent('heartbeat', 'T9005', 'ghost-agent', '/nonexistent/path/abc'),
    ).resolves.not.toThrow();
  });
});

describe('appendEvent — conduit fallback to file', () => {
  it('falls back to file when conduit is unavailable', async () => {
    // Conduit transport but in test env it will fail to init → fallback.
    process.env['CLEO_EVENTS_TRANSPORT'] = 'conduit';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const agentId = 'fallback-agent';
    await expect(appendEvent('heartbeat', 'T9006', agentId, TMP_ROOT)).resolves.not.toThrow();

    // Should have logged a warning about conduit fallback.
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[events] WARN'));

    stderrSpy.mockRestore();
  });
});
