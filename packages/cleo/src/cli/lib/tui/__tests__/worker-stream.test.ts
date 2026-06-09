/**
 * Tests for the pure worker-stream fold + panel renderer (T11936).
 *
 * Verifies the gateway `GatewayStreamEvent` → worker-view fold (output tail,
 * usage meter, checkpoints, heartbeat, terminal done/error) and the plain-text
 * panel render. No socket, no pi-tui, no TTY required.
 *
 * @task T11936
 * @epic T11916
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';
import { describe, expect, it } from 'vitest';
import {
  applyWorkerStreamFrame,
  emptyWorkerStreamView,
  formatUsageMeter,
  isStreamStalled,
  renderWorkerStreamPanel,
  type WorkerStreamView,
} from '../worker-stream.js';

/** Build a `data` frame with the given payload. */
function dataFrame(seq: number, data: unknown): GatewayStreamEvent {
  return { kind: 'data', seq, data, requestId: 'req-1' };
}

describe('applyWorkerStreamFrame — frame folding (T11936)', () => {
  it('starts in the connecting state with empty slots', () => {
    const v = emptyWorkerStreamView();
    expect(v.status).toBe('connecting');
    expect(v.outputTail).toEqual([]);
    expect(v.usage).toBeNull();
    expect(v.checkpoints).toEqual([]);
    expect(v.error).toBeNull();
  });

  it('appends an output line and goes live', () => {
    const v = applyWorkerStreamFrame(
      emptyWorkerStreamView(),
      dataFrame(0, { line: 'compiling…', ts: '2026-06-09T00:00:00.000Z' }),
    );
    expect(v.status).toBe('live');
    expect(v.outputTail).toEqual(['compiling…']);
    expect(v.lastFrameTs).toBe('2026-06-09T00:00:00.000Z');
  });

  it('accepts the `output` field as an alias for a line', () => {
    const v = applyWorkerStreamFrame(emptyWorkerStreamView(), dataFrame(0, { output: 'hi' }));
    expect(v.outputTail).toEqual(['hi']);
  });

  it('caps the output tail to maxTail (oldest roll off)', () => {
    let v = emptyWorkerStreamView();
    for (let i = 0; i < 5; i++) v = applyWorkerStreamFrame(v, dataFrame(i, { line: `l${i}` }), 3);
    expect(v.outputTail).toEqual(['l2', 'l3', 'l4']);
  });

  it('folds a nested usage snapshot into the meter', () => {
    const v = applyWorkerStreamFrame(
      emptyWorkerStreamView(),
      dataFrame(0, { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, records: 2 } }),
    );
    expect(v.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      records: 2,
    });
  });

  it('derives totalTokens from input+output when absent', () => {
    const v = applyWorkerStreamFrame(
      emptyWorkerStreamView(),
      dataFrame(0, { inputTokens: 10, outputTokens: 5 }),
    );
    expect(v.usage?.totalTokens).toBe(15);
    expect(v.usage?.records).toBe(1);
  });

  it('records a checkpoint of a known kind', () => {
    const v = applyWorkerStreamFrame(
      emptyWorkerStreamView(),
      dataFrame(0, { checkpoint: { kind: 'commit', label: 'abc1234' } }),
    );
    expect(v.checkpoints).toEqual([{ kind: 'commit', label: 'abc1234' }]);
  });

  it('ignores an unknown checkpoint kind (treats frame as heartbeat)', () => {
    const v = applyWorkerStreamFrame(
      emptyWorkerStreamView(),
      dataFrame(0, { checkpoint: { kind: 'bogus', label: 'x' } }),
    );
    expect(v.checkpoints).toEqual([]);
    expect(v.status).toBe('live');
  });

  it('treats an unrecognised data payload (tick heartbeat) as a live heartbeat', () => {
    const v = applyWorkerStreamFrame(emptyWorkerStreamView(), dataFrame(0, { tick: 1, ts: 'X' }));
    expect(v.status).toBe('live');
    expect(v.outputTail).toEqual([]);
    expect(v.lastFrameTs).toBe('X');
  });

  it('ends on a done frame', () => {
    const done: GatewayStreamEvent = { kind: 'done', seq: 9, data: {}, requestId: 'r' };
    const v = applyWorkerStreamFrame(emptyWorkerStreamView(), done);
    expect(v.status).toBe('ended');
  });

  it('captures the error message on an error frame', () => {
    const errFrame: GatewayStreamEvent = {
      kind: 'error',
      seq: 1,
      error: { code: 'E_X', message: 'boom' },
      requestId: 'r',
    };
    const v = applyWorkerStreamFrame(emptyWorkerStreamView(), errFrame);
    expect(v.status).toBe('error');
    expect(v.error).toBe('boom');
  });

  it('never mutates the input view (pure fold)', () => {
    const base = emptyWorkerStreamView();
    const next = applyWorkerStreamFrame(base, dataFrame(0, { line: 'x' }));
    expect(base.outputTail).toEqual([]);
    expect(next).not.toBe(base);
  });
});

describe('formatUsageMeter (T11936)', () => {
  it('dashes when there is no usage', () => {
    expect(formatUsageMeter(null)).toBe('— tokens');
  });

  it('renders a compact token + call meter', () => {
    expect(
      formatUsageMeter({ inputTokens: 0, outputTokens: 0, totalTokens: 12_400, records: 3 }),
    ).toBe('12.4k tok · 3 calls');
  });

  it('uses the singular call form for one record', () => {
    expect(
      formatUsageMeter({ inputTokens: 0, outputTokens: 0, totalTokens: 500, records: 1 }),
    ).toBe('500 tok · 1 call');
  });
});

describe('renderWorkerStreamPanel (T11936)', () => {
  it('renders a header with the task id, status, and usage meter', () => {
    const lines = renderWorkerStreamPanel('T42', emptyWorkerStreamView());
    expect(lines[0]).toContain('T42');
    expect(lines[0]).toContain('connecting');
    expect(lines.join('\n')).toContain('waiting for worker output');
  });

  it('renders the output tail and checkpoint chips', () => {
    let v = emptyWorkerStreamView();
    v = applyWorkerStreamFrame(v, dataFrame(0, { line: 'line-1' }));
    v = applyWorkerStreamFrame(v, dataFrame(1, { checkpoint: { kind: 'pr', label: '#7' } }));
    const text = renderWorkerStreamPanel('T7', v).join('\n');
    expect(text).toContain('line-1');
    expect(text).toContain('pr:#7');
  });
});

describe('isStreamStalled (T11936)', () => {
  it('reports stalled when no frame has arrived past the window', () => {
    const v: WorkerStreamView = {
      ...emptyWorkerStreamView(),
      lastFrameTs: '2026-06-09T00:00:00.000Z',
    };
    const now = Date.parse('2026-06-09T00:00:30.000Z');
    expect(isStreamStalled(v, now, 10_000)).toBe(true);
    expect(isStreamStalled(v, now, 60_000)).toBe(false);
  });

  it('is never stalled once ended or errored', () => {
    const ended: WorkerStreamView = { ...emptyWorkerStreamView(), status: 'ended' };
    expect(isStreamStalled(ended, Date.now(), 1)).toBe(false);
  });
});
