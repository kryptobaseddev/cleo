import { describe, expect, it } from "vitest";
import type { SpawnAdapter, SpawnOptions, SpawnResult } from "../../src/core/registry/spawn-adapter.js";
import type { Provider } from "../../src/types.js";

describe("SpawnAdapter interface", () => {
  it("allows implementing the SpawnAdapter interface", () => {
    // Verify the interface compiles correctly with a mock implementation
    const mockAdapter: SpawnAdapter = {
      canSpawn: (_provider: Provider) => true,
      spawn: async (_provider: Provider, _options: SpawnOptions): Promise<SpawnResult> => ({
        instanceId: "test-123",
        status: "running",
      }),
      listRunning: async (_provider: Provider): Promise<SpawnResult[]> => [],
      terminate: async (_provider: Provider, _instanceId: string): Promise<void> => {},
    };

    expect(mockAdapter.canSpawn).toBeDefined();
    expect(mockAdapter.spawn).toBeDefined();
    expect(mockAdapter.listRunning).toBeDefined();
    expect(mockAdapter.terminate).toBeDefined();
  });

  it("mock adapter returns expected shapes", async () => {
    const mockAdapter: SpawnAdapter = {
      canSpawn: () => true,
      spawn: async () => ({ instanceId: "abc", status: "completed", output: "done" }),
      listRunning: async () => [{ instanceId: "abc", status: "running" }],
      terminate: async () => {},
    };

    const result = await mockAdapter.spawn({} as Provider, { prompt: "test" });
    expect(result.instanceId).toBe("abc");
    expect(result.status).toBe("completed");
    expect(result.output).toBe("done");

    const running = await mockAdapter.listRunning({} as Provider);
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
  });

  it("SpawnOptions has correct shape", () => {
    const opts: SpawnOptions = {
      prompt: "Hello",
      model: "claude-opus-4-6",
      tools: ["read", "write"],
      timeout: 30000,
      isolate: true,
    };
    expect(opts.prompt).toBe("Hello");
    expect(opts.tools).toHaveLength(2);
  });
});
