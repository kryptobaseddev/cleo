import { describe, expect, it } from "vitest";
describe("SpawnAdapter interface", () => {
    it("allows implementing the SpawnAdapter interface", () => {
        // Verify the interface compiles correctly with a mock implementation
        const mockAdapter = {
            canSpawn: (_provider) => true,
            spawn: async (_provider, _options) => ({
                instanceId: "test-123",
                status: "running",
            }),
            listRunning: async (_provider) => [],
            terminate: async (_provider, _instanceId) => { },
        };
        expect(mockAdapter.canSpawn).toBeDefined();
        expect(mockAdapter.spawn).toBeDefined();
        expect(mockAdapter.listRunning).toBeDefined();
        expect(mockAdapter.terminate).toBeDefined();
    });
    it("mock adapter returns expected shapes", async () => {
        const mockAdapter = {
            canSpawn: () => true,
            spawn: async () => ({ instanceId: "abc", status: "completed", output: "done" }),
            listRunning: async () => [{ instanceId: "abc", status: "running" }],
            terminate: async () => { },
        };
        const result = await mockAdapter.spawn({}, { prompt: "test" });
        expect(result.instanceId).toBe("abc");
        expect(result.status).toBe("completed");
        expect(result.output).toBe("done");
        const running = await mockAdapter.listRunning({});
        expect(running).toHaveLength(1);
        expect(running[0]?.status).toBe("running");
    });
    it("SpawnOptions has correct shape", () => {
        const opts = {
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
//# sourceMappingURL=spawn-adapter.test.js.map