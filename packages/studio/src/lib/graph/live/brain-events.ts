/**
 * CLEO Studio — typed Brain SSE event union.
 *
 * Thin wrapper over {@link import('@cleocode/brain').BrainStreamEvent}
 * that re-exports the union under a kit-local name so downstream
 * renderers + bridges depend on this module rather than reaching into
 * `@cleocode/brain` directly. Keeps the kit self-contained.
 *
 * @task T990
 * @wave 1A
 */

import type { BrainConnectionStatus, BrainStreamEvent } from '@cleocode/brain';

/** Canonical SSE event union emitted by `GET /api/brain/stream`. */
export type BrainLiveEvent = BrainStreamEvent;

/** Connection state for the SSE bridge. */
export type BrainLiveStatus = BrainConnectionStatus;

/**
 * Callback bag consumed by {@link import('./sse-bridge.js').createSseBridge}.
 *
 * All callbacks are optional — consumers subscribe only to the events
 * they care about. The bridge itself does not mutate graph state.
 */
export interface BrainLiveCallbacks {
  /** Fires on SSE open (after the initial `hello` handshake). */
  onConnect?: () => void;
  /** Fires every time the bridge status changes. */
  onStatus?: (status: BrainLiveStatus) => void;
  /** Fires on `node.create` events. */
  onNodeCreate?: (e: Extract<BrainLiveEvent, { type: 'node.create' }>) => void;
  /** Fires on `edge.strengthen` events. */
  onEdgeStrengthen?: (e: Extract<BrainLiveEvent, { type: 'edge.strengthen' }>) => void;
  /** Fires on `task.status` events. */
  onTaskStatus?: (e: Extract<BrainLiveEvent, { type: 'task.status' }>) => void;
  /** Fires on `message.send` events. */
  onMessageSend?: (e: Extract<BrainLiveEvent, { type: 'message.send' }>) => void;
  /** Fires on 30s `heartbeat` keepalive. */
  onHeartbeat?: (e: Extract<BrainLiveEvent, { type: 'heartbeat' }>) => void;
  /** Fires on transport-level errors (the bridge auto-reconnects). */
  onError?: (err: Error) => void;
}
