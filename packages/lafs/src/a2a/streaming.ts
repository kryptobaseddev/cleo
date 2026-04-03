/**
 * A2A streaming and async runtime primitives (T101).
 *
 * @remarks
 * Provides an in-memory event bus for task status/artifact updates,
 * push-notification config storage helpers, webhook dispatch, and
 * artifact delta assembly. All classes are designed for in-memory use
 * and do not persist state across process restarts.
 */

import type {
  Artifact,
  PushNotificationConfig,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

/**
 * Union type of task stream events emitted by the event bus.
 *
 * @remarks
 * Encompasses both status update and artifact update events from the A2A SDK.
 */
export type TaskStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

type StreamListener = (event: TaskStreamEvent) => void;

function resolveTaskId(event: TaskStreamEvent): string {
  const candidate = event as unknown as {
    taskId?: string;
    task?: { id?: string };
  };

  const taskId = candidate.taskId ?? candidate.task?.id;
  if (!taskId) {
    throw new Error('Task stream event is missing task identifier');
  }
  return taskId;
}

/**
 * In-memory event bus for task lifecycle streaming events.
 *
 * @remarks
 * Maintains per-task event history and per-task listener sets. Events are
 * delivered synchronously to all registered listeners for the task. The
 * history can be replayed via {@link TaskEventBus.getHistory} for catch-up
 * semantics.
 */
export class TaskEventBus {
  /** Map of task ID to ordered event history */
  private history = new Map<string, TaskStreamEvent[]>();
  /** Map of task ID to active listener callbacks */
  private listeners = new Map<string, Set<StreamListener>>();

  /**
   * Publish a task status update event.
   *
   * @remarks
   * Convenience wrapper that delegates to {@link TaskEventBus.publish}.
   *
   * @param event - Status update event to publish
   *
   * @example
   * ```typescript
   * bus.publishStatusUpdate({ kind: 'status-update', taskId: 'task-1', status: { state: 'working', timestamp: new Date().toISOString() }, final: false });
   * ```
   */
  publishStatusUpdate(event: TaskStatusUpdateEvent): void {
    this.publish(event);
  }

  /**
   * Publish a task artifact update event.
   *
   * @remarks
   * Convenience wrapper that delegates to {@link TaskEventBus.publish}.
   *
   * @param event - Artifact update event to publish
   *
   * @example
   * ```typescript
   * bus.publishArtifactUpdate({ kind: 'artifact-update', taskId: 'task-1', artifact: myArtifact });
   * ```
   */
  publishArtifactUpdate(event: TaskArtifactUpdateEvent): void {
    this.publish(event);
  }

  /**
   * Publish a task stream event to all listeners and history.
   *
   * @remarks
   * Appends the event to the task's history, then synchronously delivers
   * it to all registered listeners for that task.
   *
   * @param event - Task stream event to publish
   *
   * @example
   * ```typescript
   * bus.publish(statusUpdateEvent);
   * ```
   */
  publish(event: TaskStreamEvent): void {
    const taskId = resolveTaskId(event);
    const events = this.history.get(taskId) ?? [];
    events.push(event);
    this.history.set(taskId, events);

    const listeners = this.listeners.get(taskId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  /**
   * Subscribe to events for a specific task.
   *
   * @remarks
   * Returns an unsubscribe function that removes the listener. Automatically
   * cleans up the listener set when the last listener is removed.
   *
   * @param taskId - ID of the task to subscribe to
   * @param listener - Callback invoked for each event
   * @returns Unsubscribe function that removes this listener
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribe('task-1', (event) => {
   *   console.log('Event:', event);
   * });
   * // Later: unsubscribe();
   * ```
   */
  subscribe(taskId: string, listener: StreamListener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);

    return () => {
      const active = this.listeners.get(taskId);
      if (!active) return;
      active.delete(listener);
      if (active.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  /**
   * Get the full event history for a task.
   *
   * @remarks
   * Returns a shallow copy of the history array. Useful for catch-up
   * replay when a new subscriber connects.
   *
   * @param taskId - ID of the task to retrieve history for
   * @returns Array of past events for the task, or empty array if none
   *
   * @example
   * ```typescript
   * const events = bus.getHistory('task-1');
   * ```
   */
  getHistory(taskId: string): TaskStreamEvent[] {
    return [...(this.history.get(taskId) ?? [])];
  }
}

/** Options for the stream task events async iterator */
export interface StreamIteratorOptions {
  /**
   * Timeout in milliseconds before the iterator yields control.
   * @defaultValue undefined
   */
  timeoutMs?: number;
}

/**
 * Build an async iterator for real-time task stream events.
 *
 * @remarks
 * First replays the existing event history for catch-up, then yields
 * new events as they arrive via the bus subscription. Uses a timeout
 * (default 30s) to periodically yield control when no events arrive.
 *
 * @param bus - TaskEventBus to subscribe to
 * @param taskId - ID of the task to stream events for
 * @param options - Iterator options including timeout
 * @returns Async generator yielding task stream events
 *
 * @example
 * ```typescript
 * for await (const event of streamTaskEvents(bus, 'task-1', { timeoutMs: 5000 })) {
 *   console.log('Received:', event);
 * }
 * ```
 */
export async function* streamTaskEvents(
  bus: TaskEventBus,
  taskId: string,
  options: StreamIteratorOptions = {},
): AsyncGenerator<TaskStreamEvent> {
  const queue: TaskStreamEvent[] = [];
  let wakeUp: (() => void) | null = null;

  const unsubscribe = bus.subscribe(taskId, (event) => {
    queue.push(event);
    if (wakeUp) {
      wakeUp();
      wakeUp = null;
    }
  });

  const timeoutMs = options.timeoutMs ?? 30_000;

  try {
    // Emit existing history first for catch-up behavior.
    for (const event of bus.getHistory(taskId)) {
      yield event;
    }

    while (true) {
      if (queue.length > 0) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (wakeUp === resolve) {
            wakeUp = null;
          }
          resolve();
        }, timeoutMs);

        wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    unsubscribe();
  }
}

/**
 * In-memory manager for async push-notification configs.
 *
 * @remarks
 * Stores push-notification configurations keyed by task ID and config ID.
 * Provides CRUD operations for registering, retrieving, listing, and
 * removing webhook configurations.
 */
export class PushNotificationConfigStore {
  /** Nested map of task ID to config ID to push notification config */
  private configs = new Map<string, Map<string, PushNotificationConfig>>();

  /**
   * Store a push-notification config for a task.
   *
   * @remarks
   * Overwrites any existing config with the same task ID and config ID.
   *
   * @param taskId - ID of the task the config applies to
   * @param configId - Unique identifier for this config within the task
   * @param config - Push notification configuration to store
   *
   * @example
   * ```typescript
   * store.set('task-1', 'webhook-1', { url: 'https://example.com/hook', token: 'abc' });
   * ```
   */
  set(taskId: string, configId: string, config: PushNotificationConfig): void {
    let taskConfigs = this.configs.get(taskId);
    if (!taskConfigs) {
      taskConfigs = new Map();
      this.configs.set(taskId, taskConfigs);
    }
    taskConfigs.set(configId, config);
  }

  /**
   * Retrieve a push-notification config by task and config ID.
   *
   * @param taskId - ID of the task
   * @param configId - ID of the config to retrieve
   * @returns The push notification config, or undefined if not found
   *
   * @example
   * ```typescript
   * const config = store.get('task-1', 'webhook-1');
   * ```
   */
  get(taskId: string, configId: string): PushNotificationConfig | undefined {
    return this.configs.get(taskId)?.get(configId);
  }

  /**
   * List all push-notification configs for a task.
   *
   * @param taskId - ID of the task to list configs for
   * @returns Array of push notification configs, or empty array if none
   *
   * @example
   * ```typescript
   * const configs = store.list('task-1');
   * ```
   */
  list(taskId: string): PushNotificationConfig[] {
    return [...(this.configs.get(taskId)?.values() ?? [])];
  }

  /**
   * Delete a push-notification config.
   *
   * @remarks
   * Removes the config and cleans up the task entry if no configs remain.
   *
   * @param taskId - ID of the task
   * @param configId - ID of the config to delete
   * @returns True if the config was found and removed, false otherwise
   *
   * @example
   * ```typescript
   * const removed = store.delete('task-1', 'webhook-1');
   * ```
   */
  delete(taskId: string, configId: string): boolean {
    const taskConfigs = this.configs.get(taskId);
    if (!taskConfigs) {
      return false;
    }

    const removed = taskConfigs.delete(configId);
    if (taskConfigs.size === 0) {
      this.configs.delete(taskId);
    }
    return removed;
  }
}

/** Result of delivering a push notification to a single webhook */
export interface PushNotificationDeliveryResult {
  /** Identifier of the config that was dispatched to */
  configId: string;
  /** Whether the delivery succeeded */
  ok: boolean;
  /**
   * HTTP status code from the webhook response.
   * @defaultValue undefined
   */
  status?: number;
  /**
   * Error message if delivery failed.
   * @defaultValue undefined
   */
  error?: string;
}

/**
 * Transport function for sending HTTP requests to push-notification webhooks.
 *
 * @remarks
 * Abstracts the HTTP transport layer to allow injection of custom fetch
 * implementations or test doubles.
 */
export type PushTransport = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Deliver task updates to registered push-notification webhooks.
 *
 * @remarks
 * Dispatches events to all push-notification configs registered for a task
 * via the configured transport. Builds authentication headers from the
 * config's token and authentication fields. Falls back to global `fetch`
 * if no transport is provided.
 */
export class PushNotificationDispatcher {
  /**
   * Create a PushNotificationDispatcher.
   *
   * @param store - Config store to look up webhook registrations
   * @param transport - HTTP transport function for sending webhook requests
   */
  constructor(
    private readonly store: PushNotificationConfigStore,
    private readonly transport: PushTransport = async (input, init) => {
      if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available for push dispatch');
      }
      return fetch(input, init);
    },
  ) {}

  /**
   * Dispatch a task event to all registered webhooks for the task.
   *
   * @remarks
   * Sends the event payload as JSON to each registered push-notification
   * URL in parallel. Captures delivery results including HTTP status and
   * errors for each webhook.
   *
   * @param taskId - ID of the task whose webhooks to dispatch to
   * @param event - Task stream event to deliver
   * @returns Array of delivery results, one per registered config
   *
   * @example
   * ```typescript
   * const results = await dispatcher.dispatch('task-1', statusUpdateEvent);
   * for (const r of results) {
   *   if (!r.ok) console.error(`Failed to deliver to ${r.configId}: ${r.error}`);
   * }
   * ```
   */
  async dispatch(
    taskId: string,
    event: TaskStreamEvent,
  ): Promise<PushNotificationDeliveryResult[]> {
    const configs = this.store.list(taskId);
    if (configs.length === 0) {
      return [];
    }

    const payload = {
      taskId,
      event,
      timestamp: new Date().toISOString(),
    };

    const deliveries = configs.map(async (config, index) => {
      const configId = config.id ?? `${taskId}:${index}`;
      if (!config.url) {
        return {
          configId,
          ok: false,
          error: 'Push notification config is missing url',
        } satisfies PushNotificationDeliveryResult;
      }

      const headers = this.buildHeaders(config);

      try {
        const response = await this.transport(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        return {
          configId,
          ok: response.ok,
          status: response.status,
          ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        } satisfies PushNotificationDeliveryResult;
      } catch (error) {
        return {
          configId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies PushNotificationDeliveryResult;
      }
    });

    return Promise.all(deliveries);
  }

  /** Build HTTP headers for push notification delivery including auth tokens. */
  private buildHeaders(config: PushNotificationConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (config.token) {
      headers['x-a2a-task-token'] = config.token;
    }

    const scheme = config.authentication?.schemes?.[0];
    const credentials = config.authentication?.credentials;

    if (scheme && credentials) {
      headers.authorization = `${scheme} ${credentials}`;
    } else if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }

    return headers;
  }
}

/**
 * Applies append/lastChunk artifact deltas into task-local snapshots.
 *
 * @remarks
 * Maintains in-memory snapshots of artifacts per task. When an artifact
 * update event with `append: true` arrives, parts are merged with the
 * existing snapshot. The `lastChunk` flag is tracked in artifact metadata
 * as `a2a:last_chunk`.
 */
export class TaskArtifactAssembler {
  /** Map of task ID to map of artifact ID to assembled artifact snapshot */
  private artifacts = new Map<string, Map<string, Artifact>>();

  /**
   * Apply an artifact update event to the assembled snapshot.
   *
   * @remarks
   * If `append` is true and a prior snapshot exists, parts are concatenated.
   * Otherwise the artifact is replaced. The `lastChunk` flag is always
   * written to metadata.
   *
   * @param event - Artifact update event containing the delta
   * @returns The merged artifact snapshot after applying the update
   *
   * @example
   * ```typescript
   * const assembler = new TaskArtifactAssembler();
   * const merged = assembler.applyUpdate(artifactUpdateEvent);
   * ```
   */
  applyUpdate(event: TaskArtifactUpdateEvent): Artifact {
    if (!event.artifact?.artifactId) {
      throw new Error('Task artifact update is missing artifactId');
    }

    const taskId = resolveTaskId(event);
    const artifactId = event.artifact.artifactId;

    let taskArtifacts = this.artifacts.get(taskId);
    if (!taskArtifacts) {
      taskArtifacts = new Map<string, Artifact>();
      this.artifacts.set(taskId, taskArtifacts);
    }

    const prior = taskArtifacts.get(artifactId);
    const merged = this.mergeArtifact(prior, event);
    taskArtifacts.set(artifactId, merged);
    return merged;
  }

  /**
   * Get a specific assembled artifact by task and artifact ID.
   *
   * @param taskId - ID of the task
   * @param artifactId - ID of the artifact to retrieve
   * @returns The assembled artifact snapshot, or undefined if not found
   *
   * @example
   * ```typescript
   * const artifact = assembler.get('task-1', 'art-1');
   * ```
   */
  get(taskId: string, artifactId: string): Artifact | undefined {
    return this.artifacts.get(taskId)?.get(artifactId);
  }

  /**
   * List all assembled artifacts for a task.
   *
   * @param taskId - ID of the task to list artifacts for
   * @returns Array of assembled artifact snapshots, or empty array if none
   *
   * @example
   * ```typescript
   * const artifacts = assembler.list('task-1');
   * ```
   */
  list(taskId: string): Artifact[] {
    return [...(this.artifacts.get(taskId)?.values() ?? [])];
  }

  /** Merge a new artifact update event into an existing artifact snapshot, handling append semantics. */
  private mergeArtifact(prior: Artifact | undefined, event: TaskArtifactUpdateEvent): Artifact {
    const next = event.artifact as Artifact;
    const append = Boolean(event.append);
    const lastChunk = Boolean(event.lastChunk);

    if (!append || !prior) {
      return {
        ...next,
        metadata: this.withLastChunk(next.metadata, lastChunk),
      };
    }

    return {
      ...prior,
      ...next,
      parts: [...(prior.parts ?? []), ...(next.parts ?? [])],
      metadata: this.withLastChunk(
        {
          ...(prior.metadata ?? {}),
          ...(next.metadata ?? {}),
        },
        lastChunk,
      ),
    };
  }

  /** Inject the `a2a:last_chunk` marker into artifact metadata. */
  private withLastChunk(
    metadata: Record<string, unknown> | undefined,
    lastChunk: boolean,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      'a2a:last_chunk': lastChunk,
    };
  }
}
