/**
 * Tests for checkpoint CLI command.
 * @task T4551
 * @epic T4545
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Mock child_process
vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
    execFileSync: vi.fn(),
}));
vi.mock('../../../../core/src/store/json.js', () => ({
    readJson: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../core/src/paths.js', () => ({
    getCleoDir: vi.fn().mockReturnValue('.cleo'),
    getConfigPath: vi.fn().mockReturnValue('.cleo/config.json'),
}));
import { execFileSync } from 'node:child_process';
import { readJson } from '@cleocode/core/internal';
import { ShimCommand as Command } from '../commander-shim.js';
import { registerCheckpointCommand } from '../commands/checkpoint.js';
const mockExecFileSync = vi.mocked(execFileSync);
const mockReadJson = vi.mocked(readJson);
describe('registerCheckpointCommand', () => {
    it('registers a checkpoint command on the program', () => {
        const program = new Command();
        registerCheckpointCommand(program);
        const cmd = program.commands.find((c) => c.name() === 'checkpoint');
        expect(cmd).toBeDefined();
        expect(cmd.description()).toContain('Git checkpoint');
    });
});
describe('checkpoint command integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('command has --status and --dry-run options', () => {
        const program = new Command();
        registerCheckpointCommand(program);
        const cmd = program.commands.find((c) => c.name() === 'checkpoint');
        const optionNames = cmd.options.map((o) => o.long);
        expect(optionNames).toContain('--status');
        expect(optionNames).toContain('--dry-run');
    });
});
//# sourceMappingURL=checkpoint.test.js.map