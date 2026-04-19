/**
 * CLEO Studio — SSE bridge for the unified Brain stream.
 *
 * Wraps `EventSource('/api/brain/stream')` with:
 *   - typed event dispatch to a {@link BrainLiveCallbacks} bag,
 *   - exponential-backoff reconnect (2s → 30s cap),
 *   - safe teardown via the returned disposer.
 *
 * The bridge is renderer-agnostic: consumers wire its callbacks into
 * whatever local state shape they maintain (Svelte runes, Vue refs,
 * plain maps).
 *
 * @task T990
 * @wave 1A
 */

import type { BrainLiveCallbacks, BrainLiveEvent, BrainLiveStatus } from './brain-events.js';

/** Handle returned by {@link createSseBridge}. */
export interface SseBridgeHandle {
  /** Close the underlying `EventSource` and stop all reconnects. */
  dispose: () => void;
  /** Current connection status — read-only snapshot. */
  readonly status: () => BrainLiveStatus;
}

/** Options bag for {@link createSseBridge}. */
export interface SseBridgeOptions {
  /** Endpoint to subscribe to. Defaults to `/api/brain/stream`. */
  url?: string;
  /** Initial reconnect delay in ms. Defaults to 2_000. */
  initialReconnectMs?: number;
  /** Max reconnect delay in ms. Defaults to 30_000. */
  maxReconnectMs?: number;
  /** Typed callbacks. */
  callbacks: BrainLiveCallbacks;
}

/**
 * Create and start a Brain SSE bridge.
 *
 * Returns a {@link SseBridgeHandle} the caller MUST dispose in
 * `onDestroy` / component teardown. Calling `dispose` multiple times
 * is safe.
 *
 * @param options - Configuration bag.
 */
export function createSseBridge(options: SseBridgeOptions): SseBridgeHandle {
  const url = options.url ?? '/api/brain/stream';
  const initial = options.initialReconnectMs ?? 2_000;
  const maxDelay = options.maxReconnectMs ?? 30_000;
  const cb = options.callbacks;

  let source: EventSource | null = null;
  let disposed = false;
  let reconnectDelay = initial;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let status: BrainLiveStatus = 'connecting';

  const setStatus = (next: BrainLiveStatus): void => {
    if (status === next) return;
    status = next;
    cb.onStatus?.(next);
  };

  const scheduleReconnect = (): void => {
    if (disposed) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (disposed) return;
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
      open();
    }, reconnectDelay);
  };

  const dispatch = (raw: string): void => {
    let parsed: BrainLiveEvent;
    try {
      parsed = JSON.parse(raw) as BrainLiveEvent;
    } catch (err) {
      cb.onError?.(err instanceof Error ? err : new Error('Malformed SSE payload'));
      return;
    }
    switch (parsed.type) {
      case 'hello':
        setStatus('connected');
        cb.onConnect?.();
        return;
      case 'heartbeat':
        cb.onHeartbeat?.(parsed);
        return;
      case 'node.create':
        cb.onNodeCreate?.(parsed);
        return;
      case 'edge.strengthen':
        cb.onEdgeStrengthen?.(parsed);
        return;
      case 'task.status':
        cb.onTaskStatus?.(parsed);
        return;
      case 'message.send':
        cb.onMessageSend?.(parsed);
        return;
    }
  };

  const open = (): void => {
    if (disposed) return;
    if (typeof EventSource === 'undefined') {
      cb.onError?.(new Error('EventSource is not available in this environment'));
      return;
    }
    setStatus('connecting');
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      if (disposed) {
        es.close();
        return;
      }
      reconnectDelay = initial;
      setStatus('connected');
    };
    es.onmessage = (msg: MessageEvent<string>) => {
      if (disposed) return;
      dispatch(msg.data);
    };
    es.onerror = () => {
      es.close();
      source = null;
      if (disposed) return;
      setStatus('error');
      scheduleReconnect();
    };
  };

  open();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      source?.close();
      source = null;
      setStatus('disconnected');
    },
    status: () => status,
  };
}
