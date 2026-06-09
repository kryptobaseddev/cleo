/**
 * Tests for T11929 — the pure worker-stream fold + meter formatting.
 *
 * Covers per-frame folding (output tail cap, usage latch, checkpoint accrual,
 * connection state), the compact usage-meter formatter, and the staleness
 * detector. Pure functions, node environment, no Svelte mount.
 *
 * @task T11929
 * @epic T11559
 */

import { describe, expect, it } from 'vitest';
import {
  applyWorkerStreamFrame,
  emptyWorkerStreamView,
  formatUsageMeter,
  isStreamStalled,
  type WorkerStreamFrame,
  type WorkerStreamView,
} from '../worker-stream.js';

const TS = '2026-06-09T20:00:00.000Z';

/** Fold a list of frames from the empty view. */
function fold(frames: WorkerStreamFrame[], maxTail?: number): WorkerStreamView {
  return frames.reduce((v, f) => applyWorkerStreamFrame(v, f, maxTail), emptyWorkerStreamView());
}

describe('applyWorkerStreamFrame — folds frames into a view (T11929)', () => {
  it('starts connecting and goes live on connected', () => {
    expect(emptyWorkerStreamView().status).toBe('connecting');
    const v = applyWorkerStreamFrame(emptyWorkerStreamView(), { kind: 'connected', ts: TS });
    expect(v.status).toBe('live');
    expect(v.lastFrameTs).toBe(TS);
  });

  it('appends output lines most-recent-last', () => {
    const v = fold([
      { kind: 'output', ts: TS, line: 'a' },
      { kind: 'output', ts: TS, line: 'b' },
    ]);
    expect(v.outputTail).toEqual(['a', 'b']);
  });

  it('caps the output tail, rolling oldest off', () => {
    const frames: WorkerStreamFrame[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'output',
      ts: TS,
      line: `l${i}`,
    }));
    const v = fold(frames, 3);
    expect(v.outputTail).toEqual(['l2', 'l3', 'l4']);
  });

  it('latches the latest usage snapshot', () => {
    const v = fold([
      {
        kind: 'usage',
        ts: TS,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, records: 1 },
      },
      {
        kind: 'usage',
        ts: TS,
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, records: 3 },
      },
    ]);
    expect(v.usage).toEqual({ inputTokens: 30, outputTokens: 12, totalTokens: 42, records: 3 });
  });

  it('accrues checkpoints in order', () => {
    const v = fold([
      { kind: 'checkpoint', ts: TS, checkpoint: { kind: 'commit', label: 'abc1234', ts: TS } },
      { kind: 'checkpoint', ts: TS, checkpoint: { kind: 'pr', label: '#42', ts: TS } },
    ]);
    expect(v.checkpoints.map((c) => c.kind)).toEqual(['commit', 'pr']);
  });

  it('marks ended on done', () => {
    const v = fold([
      { kind: 'connected', ts: TS },
      { kind: 'done', ts: TS, reason: 'session-ended' },
    ]);
    expect(v.status).toBe('ended');
  });

  it('does not mutate the input view (pure)', () => {
    const base = emptyWorkerStreamView();
    const next = applyWorkerStreamFrame(base, { kind: 'output', ts: TS, line: 'x' });
    expect(base.outputTail).toEqual([]);
    expect(next.outputTail).toEqual(['x']);
  });
});

describe('formatUsageMeter (T11929)', () => {
  it('renders a dash when no usage', () => {
    expect(formatUsageMeter(null)).toBe('— tokens');
    expect(formatUsageMeter({ inputTokens: 0, outputTokens: 0, totalTokens: 0, records: 0 })).toBe(
      '— tokens',
    );
  });

  it('renders raw tokens below 1k', () => {
    expect(
      formatUsageMeter({ inputTokens: 300, outputTokens: 120, totalTokens: 420, records: 1 }),
    ).toBe('420 tok · 1 call');
  });

  it('renders k-suffixed tokens at/above 1k with pluralised calls', () => {
    expect(
      formatUsageMeter({
        inputTokens: 8000,
        outputTokens: 4400,
        totalTokens: 12_400,
        records: 3,
      }),
    ).toBe('12.4k tok · 3 calls');
  });
});

describe('isStreamStalled (T11929)', () => {
  const live: WorkerStreamView = { ...emptyWorkerStreamView(), status: 'live', lastFrameTs: TS };

  it('is stalled when silent past the window', () => {
    const now = Date.parse(TS) + 10_000;
    expect(isStreamStalled(live, now, 5000)).toBe(true);
  });

  it('is not stalled within the window', () => {
    const now = Date.parse(TS) + 2000;
    expect(isStreamStalled(live, now, 5000)).toBe(false);
  });

  it('is never stalled once ended', () => {
    const ended: WorkerStreamView = { ...live, status: 'ended' };
    expect(isStreamStalled(ended, Date.parse(TS) + 999_999, 5000)).toBe(false);
  });

  it('is not stalled before the first frame', () => {
    expect(isStreamStalled(emptyWorkerStreamView(), Date.now(), 5000)).toBe(false);
  });
});
