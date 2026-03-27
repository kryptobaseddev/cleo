import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    registerMcpInstall: vi.fn(),
    registerMcpRemove: vi.fn(),
    registerMcpList: vi.fn(),
    registerMcpDetect: vi.fn(),
    registerMcpCleoCommands: vi.fn(),
    registerMcpCleoCompatibilityCommands: vi.fn(),
}));
vi.mock("../../src/commands/mcp/install.js", () => ({
    registerMcpInstall: mocks.registerMcpInstall,
}));
vi.mock("../../src/commands/mcp/remove.js", () => ({
    registerMcpRemove: mocks.registerMcpRemove,
}));
vi.mock("../../src/commands/mcp/list.js", () => ({
    registerMcpList: mocks.registerMcpList,
}));
vi.mock("../../src/commands/mcp/detect.js", () => ({
    registerMcpDetect: mocks.registerMcpDetect,
}));
vi.mock("../../src/commands/mcp/cleo.js", () => ({
    registerMcpCleoCommands: mocks.registerMcpCleoCommands,
    registerMcpCleoCompatibilityCommands: mocks.registerMcpCleoCompatibilityCommands,
}));
import { registerMcpCommands } from "../../src/commands/mcp/index.js";
describe("mcp command index", () => {
    it("registers all MCP subcommands on the mcp group", () => {
        const program = new Command();
        registerMcpCommands(program);
        expect(mocks.registerMcpInstall).toHaveBeenCalledTimes(1);
        expect(mocks.registerMcpRemove).toHaveBeenCalledTimes(1);
        expect(mocks.registerMcpList).toHaveBeenCalledTimes(1);
        expect(mocks.registerMcpDetect).toHaveBeenCalledTimes(1);
        expect(mocks.registerMcpCleoCommands).toHaveBeenCalledTimes(1);
        expect(mocks.registerMcpCleoCompatibilityCommands).toHaveBeenCalledTimes(1);
        const mcpCommand = mocks.registerMcpInstall.mock.calls[0]?.[0];
        expect(mcpCommand.name()).toBe("mcp");
    });
});
//# sourceMappingURL=mcp-command-index.test.js.map