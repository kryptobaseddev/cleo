/**
 * A2A streaming and async runtime primitives (T101).
 *
 * Provides an in-memory event bus for task status/artifact updates and
 * push-notification config storage helpers.
 */

import type {
  Artifact,
  PushNotificationConfig,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

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
 */
export class TaskEventBus {
  private history = new Map<string, TaskStreamEvent[]>();
  private listeners = new Map<string, Set<StreamListener>>();

  publishStatusUpdate(event: TaskStatusUpdateEvent): void {
    this.publish(event);
  }

  publishArtifactUpdate(event: TaskArtifactUpdateEvent): void {
    this.publish(event);
  }

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

  getHistory(taskId: string): TaskStreamEvent[] {
    return [...(this.history.get(taskId) ?? [])];
  }
}

export interface StreamIteratorOptions {
  timeoutMs?: number;
}

/**
 * Build an async iterator for real-time task stream events.
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
 */
export class PushNotificationConfigStore {
  private configs = new Map<string, Map<string, PushNotificationConfig>>();

  set(taskId: string, configId: string, config: PushNotificationConfig): void {
    let taskConfigs = this.configs.get(taskId);
    if (!taskConfigs) {
      taskConfigs = new Map();
      this.configs.set(taskId, taskConfigs);
    }
    taskConfigs.set(configId, config);
  }

  get(taskId: string, configId: string): PushNotificationConfig | undefined {
    return this.configs.get(taskId)?.get(configId);
  }

  list(taskId: string): PushNotificationConfig[] {
    return [...(this.configs.get(taskId)?.values() ?? [])];
  }

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

export interface PushNotificationDeliveryResult {
  configId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

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
 */
export class PushNotificationDispatcher {
  constructor(
    private readonly store: PushNotificationConfigStore,
    private readonly transport: PushTransport = async (input, init) => {
      if (typeof fetch !== 'function') {
        throw new Error('Global fetch is not available for push dispatch');
      }
      return fetch(input, init);
    },
  ) {}

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
 */
export class TaskArtifactAssembler {
  private artifacts = new Map<string, Map<string, Artifact>>();

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

  get(taskId: string, artifactId: string): Artifact | undefined {
    return this.artifacts.get(taskId)?.get(artifactId);
  }

  list(taskId: string): Artifact[] {
    return [...(this.artifacts.get(taskId)?.values() ?? [])];
  }

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
