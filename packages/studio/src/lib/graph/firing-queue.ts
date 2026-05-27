/**
 * CLEO Studio — synapse firing queue.
 *
 * A small, allocation-frugal queue that tracks active "edge fires" and
 * returns per-frame travel progress + a resolved WebGL colour tuple.
 * The renderer uses the output to draw travelling sparks along each
 * firing edge.
 *
 * @task T990
 * @wave 1A
 */

import { resolveEdgeStyleForWebGL } from './edge-kinds.js';
import { FIRE_DURATION_MS, type FireEvent, type GraphEdge } from './types.js';

/**
 * One active fire, as reported by {@link FiringQueue.tick}.
 */
export interface ActiveFire {
  /** Edge id currently firing. */
  edgeId: string;
  /** 0..1 travel progress along the edge. */
  t: number;
  /** Linear-sRGB colour tuple (matches the edge kind's style). */
  colorRgb: [number, number, number];
  /** 0..1 intensity, echoed from the original {@link FireEvent}. */
  intensity: number;
}

/**
 * Queue holding every in-flight synapse fire.
 *
 * Implementation notes:
 * - Entries are kept in insertion order in a plain array. Expired
 *   entries are filtered out on each `tick`.
 * - `tick` takes a `nowMs` argument so tests (and the renderer) can
 *   inject a deterministic clock.
 * - The queue is edge-aware: if the caller passes a
 *   `Map<string, GraphEdge>` into {@link FiringQueue.tick}, the result
 *   includes colour resolved from the edge's kind. Otherwise a neutral
 *   white fallback is used.
 */
export class FiringQueue {
  private readonly queue: FireEvent[] = [];

  /** Duration in ms every fire travels from source to target. */
  readonly duration: number;

  /**
   * @param duration - Override travel duration in ms.
   *   Defaults to {@link FIRE_DURATION_MS}.
   */
  constructor(duration: number = FIRE_DURATION_MS) {
    this.duration = duration;
  }

  /** Number of currently-tracked fires. */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a new fire. Safe to call every frame — duplicates on the
   * same edge are permitted and render as multiple sparks in flight.
   *
   * @param ev - The fire event to enqueue.
   */
  enqueue(ev: FireEvent): void {
    this.queue.push(ev);
  }

  /** Drop every in-flight fire. Used on teardown. */
  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Advance the queue to `nowMs` and return every fire still in
   * flight, with its normalised travel progress.
   *
   * Expired entries are removed in-place. The returned array is a
   * fresh allocation each call — the renderer is free to retain refs.
   *
   * @param nowMs - Current timestamp (`performance.now()` or
   *   `Date.now()`). Must be monotonic across calls.
   * @param edgesById - Optional edge lookup for colour resolution.
   */
  tick(nowMs: number, edgesById?: ReadonlyMap<string, GraphEdge>): ActiveFire[] {
    const out: ActiveFire[] = [];
    const duration = this.duration;
    // Compact the queue from the front as we go — retains O(n) time.
    let write = 0;
    for (let read = 0; read < this.queue.length; read++) {
      const ev = this.queue[read];
      const age = nowMs - ev.emittedAt;
      if (age < 0) {
        // Future-emitted event (clock skew) — keep but skip rendering.
        if (write !== read) this.queue[write] = ev;
        write++;
        continue;
      }
      if (age >= duration) {
        // Expired — drop.
        continue;
      }
      const t = age / duration;
      const edge = edgesById?.get(ev.edgeId);
      const colorRgb: [number, number, number] = edge
        ? resolveEdgeStyleForWebGL(edge.kind)
        : [1, 1, 1];
      out.push({ edgeId: ev.edgeId, t, colorRgb, intensity: ev.intensity });
      if (write !== read) this.queue[write] = ev;
      write++;
    }
    this.queue.length = write;
    return out;
  }
}

/**
 * Convenience factory — returns a fresh {@link FiringQueue} with the
 * default {@link FIRE_DURATION_MS} duration. Prefer `new FiringQueue()`
 * when you need a custom duration for tests.
 */
export function createFiringQueue(): FiringQueue {
  return new FiringQueue();
}
