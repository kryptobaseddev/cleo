/**
 * Client-side helpers for progressive Brain graph loading.
 *
 * Consumed by `src/routes/brain/+page.svelte` (Agent E's shell) from
 * `onMount` to fetch tier-1 and tier-2 node batches after the tier-0
 * first-paint payload is rendered.
 *
 * ## Usage (Agent E integration contract)
 *
 * ```svelte
 * <script lang="ts">
 *   import { onMount } from 'svelte';
 *   import {
 *     streamRemainingNodes,
 *     createWarmupProgressSignal,
 *     type StreamCallbacks,
 *   } from '$lib/brain-streaming.js';
 *   import type { BrainGraph } from '@cleocode/brain';
 *
 *   let { data } = $props();
 *   let rawGraph = $state<BrainGraph>(data.graph);
 *   let warmupProgress = $state(0);       // 0–1; wire to a progress bar
 *
 *   onMount(() => {
 *     const { progress$, markComplete } = createWarmupProgressSignal();
 *
 *     // Wire the reactive progress signal.
 *     progress$.subscribe((v) => { warmupProgress = v; });
 *
 *     // Fetch remaining tiers.
 *     streamRemainingNodes({
 *       currentGraph: data.graph,
 *       onNodes: (nodes, edges) => {
 *         rawGraph = {
 *           ...rawGraph,
 *           nodes: [...rawGraph.nodes, ...nodes],
 *           edges: [...rawGraph.edges, ...edges],
 *         };
 *       },
 *       onTierComplete: (tier) => {
 *         warmupProgress = tier === 1 ? 0.6 : 1.0;
 *         if (tier === 2) markComplete();
 *       },
 *       onError: console.warn,
 *     });
 *   });
 * </script>
 * ```
 *
 * @module
 * @task T990
 */

import type { BrainEdge, BrainGraph, BrainNode } from '@cleocode/brain';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callbacks invoked by {@link streamRemainingNodes} as data arrives. */
export interface StreamCallbacks {
  /**
   * Called with each batch of newly-arrived nodes and edges.
   * Merge these into your reactive graph state.
   */
  onNodes: (nodes: BrainNode[], edges: BrainEdge[]) => void;

  /**
   * Called when a full tier has finished loading.
   *
   * @param tier - The tier that just completed (1 or 2).
   * @param totalNodes - Total nodes received in this tier.
   * @param elapsedMs - Server-reported duration in milliseconds.
   */
  onTierComplete: (tier: 1 | 2, totalNodes: number, elapsedMs: number) => void;

  /**
   * Called if any network or parse error occurs.
   * The stream is abandoned after the first error.
   */
  onError: (error: unknown) => void;
}

/** Options for {@link streamRemainingNodes}. */
export interface StreamOptions extends StreamCallbacks {
  /** The tier-0 graph already rendered — used to check whether more nodes exist. */
  currentGraph: BrainGraph;
  /**
   * Whether to also fetch tier 2 after tier 1 completes.
   * Defaults to `true` when `currentGraph.truncated` is `true`.
   */
  fetchTier2?: boolean;
  /**
   * Comma-separated substrate filter forwarded to the chunks endpoint.
   * Omit to fetch all substrates.
   */
  substrates?: string;
  /** Minimum weight filter forwarded to the chunks endpoint. */
  minWeight?: number;
}

/** Return handle from {@link streamRemainingNodes}. */
export interface StreamHandle {
  /** Abort the in-progress stream fetch. */
  abort: () => void;
}

// ---------------------------------------------------------------------------
// NDJSON chunk types (wire format from /api/brain/chunks)
// ---------------------------------------------------------------------------

interface ChunkEvent {
  kind: 'chunk';
  tier: 1 | 2;
  nodes: BrainNode[];
  edges: BrainEdge[];
  truncated: boolean;
}

interface DoneEvent {
  kind: 'done';
  tier: 1 | 2;
  totalNodes: number;
  elapsed: number;
}

interface ErrorEvent {
  kind: 'error';
  message: string;
}

type ChunkLine = ChunkEvent | DoneEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// Streaming implementation
// ---------------------------------------------------------------------------

/**
 * Fetches tier-1 (and optionally tier-2) brain graph data from
 * `/api/brain/chunks` and merges it into the caller's reactive graph.
 *
 * Each response is a newline-delimited JSON (NDJSON) stream.
 * The function reads the stream line-by-line and fires callbacks as
 * data arrives so the renderer can append nodes without waiting for
 * the full response.
 *
 * @param opts - Configuration and callback handlers.
 * @returns A {@link StreamHandle} that can be used to abort the fetch.
 */
export function streamRemainingNodes(opts: StreamOptions): StreamHandle {
  const controller = new AbortController();
  const { signal } = controller;

  // Start tier-1 fetch; chain tier-2 if needed.
  void fetchTier(1, opts, signal).then((shouldFetchTier2) => {
    if (!signal.aborted && shouldFetchTier2 && (opts.fetchTier2 ?? opts.currentGraph.truncated)) {
      return fetchTier(2, opts, signal);
    }
  });

  return {
    abort: () => controller.abort(),
  };
}

/**
 * Fetches a single tier from `/api/brain/chunks` and processes the NDJSON stream.
 *
 * @param tier - Tier to fetch (1 or 2).
 * @param opts - Stream options (callbacks, filter params).
 * @param signal - AbortSignal to cancel the request.
 * @returns Promise resolving to `true` when tier-2 should follow, `false` otherwise.
 */
async function fetchTier(tier: 1 | 2, opts: StreamOptions, signal: AbortSignal): Promise<boolean> {
  const params = new URLSearchParams({ tier: String(tier) });
  if (opts.substrates) params.set('substrates', opts.substrates);
  if (opts.minWeight !== undefined) params.set('min_weight', String(opts.minWeight));

  let response: Response;
  try {
    response = await fetch(`/api/brain/chunks?${params.toString()}`, { signal });
  } catch (err) {
    if (!signal.aborted) opts.onError(err);
    return false;
  }

  if (!response.ok || !response.body) {
    opts.onError(new Error(`HTTP ${response.status} fetching tier-${tier}`));
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let hadNodes = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process all complete lines in the buffer.
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: ChunkLine;
        try {
          parsed = JSON.parse(trimmed) as ChunkLine;
        } catch {
          // Malformed line — skip.
          continue;
        }

        if (parsed.kind === 'error') {
          opts.onError(new Error(parsed.message));
          return false;
        }

        if (parsed.kind === 'chunk') {
          if (parsed.nodes.length > 0 || parsed.edges.length > 0) {
            opts.onNodes(parsed.nodes, parsed.edges);
            hadNodes = true;
          }
        }

        if (parsed.kind === 'done') {
          opts.onTierComplete(tier, parsed.totalNodes, parsed.elapsed);
          // tier-2 follow-up depends on whether tier-1 was truncated.
          return tier === 1 && parsed.totalNodes >= 1000;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return hadNodes && tier === 1;
}

// ---------------------------------------------------------------------------
// Warmup progress signal
// ---------------------------------------------------------------------------

/** Subscriber callback type. */
type ProgressSubscriber = (value: number) => void;

/** A minimal reactive signal for warmup progress (0–1). */
export interface WarmupProgressSignal {
  /** Subscribe to progress updates. Returns an unsubscribe function. */
  subscribe: (fn: ProgressSubscriber) => () => void;
  /** Mark warmup as complete (sets progress to 1.0). */
  markComplete: () => void;
  /** Read the current progress value without subscribing. */
  current: () => number;
}

/**
 * Creates a simple pub/sub warmup progress signal.
 *
 * Agent E wires this into a `$state` variable and optionally into a
 * progress bar component.  The signal starts at `0` (tier-0 rendered)
 * and progresses to `1.0` when all tiers have loaded.
 *
 * Expected milestone values (suggested — Agent E may override):
 * - `0`   — tier-0 rendered (initial state)
 * - `0.6` — tier-1 complete
 * - `1.0` — tier-2 complete (or markComplete called)
 *
 * @returns {@link WarmupProgressSignal}
 */
export function createWarmupProgressSignal(): WarmupProgressSignal {
  let _value = 0;
  const _subscribers = new Set<ProgressSubscriber>();

  function notify(): void {
    for (const fn of _subscribers) {
      fn(_value);
    }
  }

  return {
    subscribe(fn) {
      _subscribers.add(fn);
      fn(_value); // fire immediately with current value
      return () => {
        _subscribers.delete(fn);
      };
    },
    markComplete() {
      _value = 1.0;
      notify();
    },
    current() {
      return _value;
    },
  };
}
