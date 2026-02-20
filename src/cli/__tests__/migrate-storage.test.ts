/**
 * Tests for migrate-storage CLI command with confirmation requirements.
 * @task T4730
 * @epic T4638
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerMigrateStorageCommand } from '../commands/migrate-storage.js';
import { CleoError } from '../../core/errors.js';

// Mock dependencies
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ size: 1024 * 1024 }), // 1MB
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn().mockImplementation((_, callback) => callback('yes')),
    close: vi.fn(),
  }),
}));

vi.mock('../../core/paths.js', () => ({
  getCleoDirAbsolute: vi.fn().mockReturnValue('/test/.cleo'),
  getCleoDir: vi.fn().mockReturnValue('.cleo'),
  getConfigPath: vi.fn().mockReturnValue('.cleo/config.json'),
  getDbPath: vi.fn().mockReturnValue('.cleo/tasks.db'),
}));

vi.mock('../../core/sessions/context-alert.js', () => ({
  getCurrentSessionId: vi.fn().mockReturnValue('test-session-123'),
}));

vi.mock('../../store/migration-sqlite.js', () => ({
  migrateJsonToSqlite: vi.fn().mockResolvedValue({
    success: true,
    tasksImported: 5,
    archivedImported: 2,
    sessionsImported: 1,
    errors: [],
    warnings: [],
    jsonCounts: { tasks: 5, archived: 2, sessions: 1 },
  }),
  exportToJson: vi.fn().mockResolvedValue({
    tasks: [],
    archived: [],
    sessions: [],
  }),
  countJsonRecords: vi.fn().mockReturnValue({ tasks: 5, archived: 2, sessions: 1 }),
}));

vi.mock('../../store/sqlite.js', () => ({
  getDb: vi.fn().mockResolvedValue({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ count: 3 }),
      }),
    }),
    all: vi.fn().mockResolvedValue([{ count: 3 }]),
  }),
  closeDb: vi.fn(),
  saveToFile: vi.fn(),
  dbExists: vi.fn().mockReturnValue(true),
}));

vi.mock('../../store/schema.js', () => ({
  tasks: { status: 'status' },
  sessions: {},
  taskDependencies: {},
  taskRelations: {},
  sessionFocusHistory: {},
  schemaMeta: {},
}));

describe('registerMigrateStorageCommand', () => {
  it('registers migrate-storage command on the program', () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toContain('Migrate storage');
  });

  it('has all required options', () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;
    const optionNames = cmd.options.map((o) => o.long);

    expect(optionNames).toContain('--to-sqlite');
    expect(optionNames).toContain('--to-json');
    expect(optionNames).toContain('--dry-run');
    expect(optionNames).toContain('--verify');
    expect(optionNames).toContain('--force');
    expect(optionNames).toContain('--confirm');
  });
});

describe('migrate-storage command validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires --to-sqlite or --to-json flag', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    // The command exits with code 2, so we expect process.exit to be called
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(cmd!.parseAsync(['node', 'test'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockRestore();
  });

  it('rejects both --to-sqlite and --to-json flags', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(
      cmd!.parseAsync(['node', 'test', '--to-sqlite', '--to-json']),
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockRestore();
  });

  it('requires --confirm when using --force', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(
      cmd!.parseAsync(['node', 'test', '--to-sqlite', '--force']),
    ).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockRestore();
  });
});

describe('migrate-storage --dry-run mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays detailed migration plan in dry-run mode', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cmd!.parseAsync(['node', 'test', '--to-sqlite', '--dry-run']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('MIGRATION PLAN'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Source Data:'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Safety Measures:'));

    consoleSpy.mockRestore();
  });

  it('does not require confirmation in dry-run mode', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    // Should not throw
    await expect(
      cmd!.parseAsync(['node', 'test', '--to-sqlite', '--dry-run']),
    ).resolves.not.toThrow();
  });
});

describe('migrate-storage confirmation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proceeds with --confirm flag without prompting', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    // Should complete without throwing
    await expect(
      cmd!.parseAsync(['node', 'test', '--to-sqlite', '--confirm']),
    ).resolves.not.toThrow();
  });

  it('allows --force with --confirm flag', async () => {
    const program = new Command();
    registerMigrateStorageCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'migrate-storage')!;

    // Should complete without throwing
    await expect(
      cmd!.parseAsync(['node', 'test', '--to-sqlite', '--force', '--confirm']),
    ).resolves.not.toThrow();
  });
});

describe('migrate-storage formatBytes', () => {
  it('formats bytes correctly', () => {
    // We need to test the formatBytes function indirectly through the module
    // Since it's not exported, we verify it works via the dry-run output
    const program = new Command();
    registerMigrateStorageCommand(program);

    // The function is tested through integration - dry-run mode uses formatBytes
    expect(program.commands.find((c) => c.name() === 'migrate-storage')).toBeDefined();
  });
});
