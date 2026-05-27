import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PushNotificationDispatcher,
  PushNotificationConfigStore,
  TaskArtifactAssembler,
  TaskEventBus,
  streamTaskEvents,
} from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A2A streaming runtime (T101)", () => {
  it("publishes and records status/artifact events", () => {
    const bus = new TaskEventBus();

    const statusEvent = {
      taskId: "task_1",
      status: { state: "working" },
    } as unknown;

    const artifactEvent = {
      taskId: "task_1",
      artifact: { artifactId: "art_1" },
    } as unknown;

    bus.publishStatusUpdate(statusEvent as never);
    bus.publishArtifactUpdate(artifactEvent as never);

    const history = bus.getHistory("task_1");
    expect(history).toHaveLength(2);
  });

  it("streams events through async iterator", async () => {
    const bus = new TaskEventBus();
    const iterator = streamTaskEvents(bus, "task_2", { timeoutMs: 50 });

    const pending = iterator.next();
    bus.publishStatusUpdate({ taskId: "task_2", status: { state: "working" } } as never);

    const first = await pending;
    expect(first.done).toBe(false);
    expect((first.value as { taskId?: string }).taskId).toBe("task_2");

    await iterator.return(undefined);
  });
});

describe("A2A push notification config store", () => {
  it("supports set/get/list/delete", () => {
    const store = new PushNotificationConfigStore();

    const config = {
      url: "https://example.com/webhook",
      token: "secret",
    } as unknown;

    store.set("task_1", "cfg_1", config as never);
    expect(store.get("task_1", "cfg_1")).toBeDefined();
    expect(store.list("task_1")).toHaveLength(1);
    expect(store.delete("task_1", "cfg_1")).toBe(true);
    expect(store.list("task_1")).toHaveLength(0);
  });
});

describe("A2A push notification dispatch", () => {
  it("posts task events to webhook subscribers", async () => {
    const store = new PushNotificationConfigStore();
    store.set(
      "task_1",
      "cfg_1",
      {
        id: "cfg_1",
        url: "https://example.com/webhook",
        token: "secret",
      } as never,
    );

    const transport = vi.fn(
      async (_input: string, _init?: { method?: string; headers?: Record<string, string> }) => ({
        ok: true,
        status: 204,
      }),
    );
    const dispatcher = new PushNotificationDispatcher(store, transport);

    const results = await dispatcher.dispatch("task_1", {
      taskId: "task_1",
      status: { state: "working" },
    } as never);

    expect(results).toEqual([
      {
        configId: "cfg_1",
        ok: true,
        status: 204,
      },
    ]);

    expect(transport).toHaveBeenCalledTimes(1);
    const call = transport.mock.calls[0] as
      | [string, { method?: string; headers?: Record<string, string> } | undefined]
      | undefined;
    expect(call?.[0]).toBe("https://example.com/webhook");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.headers?.authorization).toBe("Bearer secret");
  });
});

describe("A2A artifact append/lastChunk assembly", () => {
  it("appends artifact parts and marks final chunk", () => {
    const assembler = new TaskArtifactAssembler();

    assembler.applyUpdate({
      taskId: "task_1",
      artifact: {
        artifactId: "art_1",
        parts: [{ kind: "text", text: "hello" }],
      },
      append: false,
      lastChunk: false,
    } as never);

    const merged = assembler.applyUpdate({
      taskId: "task_1",
      artifact: {
        artifactId: "art_1",
        parts: [{ kind: "text", text: " world" }],
      },
      append: true,
      lastChunk: true,
    } as never);

    expect(merged.parts).toHaveLength(2);
    expect(merged.metadata?.["a2a:last_chunk"]).toBe(true);
  });
});
