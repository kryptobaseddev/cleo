/**
 * Startup migration hook tests (T360 / T310 epic).
 *
 * Verifies that `migrateSignaldockToConduit` is invoked at CLI startup when
 * `needsSignaldockToConduitMigration` returns true, and is skipped when it
 * returns false. Also verifies that `ensureConduitDb`, `ensureGlobalSignaldockDb`,
 * and `validateGlobalSalt` are called as part of the startup sequence.
 *
 * Because `packages/cleo/src/cli/index.ts` executes its startup block at
 * module-load time, we use `vi.resetModules()` + dynamic import to exercise
 * the startup code with fresh mocks on each test.
 *
 * @task T360
 * @epic T310
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports so vi can hoist them.
// ---------------------------------------------------------------------------
const {
  detectAndRemoveLegacyGlobalFilesMock,
  detectAndRemoveStrayProjectNexusMock,
  getProjectRootMock,
  needsSignaldockToConduitMigrationMock,
  migrateSignaldockToConduitMock,
  ensureConduitDbMock,
  ensureGlobalSignaldockDbMock,
  validateGlobalSaltMock,
  getGlobalSaltMock,
  getLoggerMock,
} = vi.hoisted(() => {
  const logInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    detectAndRemoveLegacyGlobalFilesMock: vi.fn(),
    detectAndRemoveStrayProjectNexusMock: vi.fn(),
    getProjectRootMock: vi.fn().mockReturnValue('/test/project'),
    needsSignaldockToConduitMigrationMock: vi.fn().mockReturnValue(false),
    migrateSignaldockToConduitMock: vi.fn().mockReturnValue({ status: 'no-op', errors: [] }),
    ensureConduitDbMock: vi
      .fn()
      .mockReturnValue({ action: 'exists', path: '/test/project/.cleo/conduit.db' }),
    ensureGlobalSignaldockDbMock: vi
      .fn()
      .mockResolvedValue({ action: 'exists', path: '/home/.local/share/cleo/signaldock.db' }),
    validateGlobalSaltMock: vi.fn(),
    getGlobalSaltMock: vi
      .fn()
      .mockReturnValue(
        Buffer.from('deadbeef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c', 'hex'),
      ),
    getLoggerMock: vi.fn().mockReturnValue(logInstance),
  };
});

vi.mock('@cleocode/core/internal', () => ({
  detectAndRemoveLegacyGlobalFiles: detectAndRemoveLegacyGlobalFilesMock,
  detectAndRemoveStrayProjectNexus: detectAndRemoveStrayProjectNexusMock,
  getProjectRoot: getProjectRootMock,
  needsSignaldockToConduitMigration: needsSignaldockToConduitMigrationMock,
  migrateSignaldockToConduit: migrateSignaldockToConduitMock,
  ensureConduitDb: ensureConduitDbMock,
  ensureGlobalSignaldockDb: ensureGlobalSignaldockDbMock,
  validateGlobalSalt: validateGlobalSaltMock,
  getGlobalSalt: getGlobalSaltMock,
  getLogger: getLoggerMock,
}));

// Stub out citty to prevent runMain from actually doing anything
vi.mock('citty', () => ({
  defineCommand: vi.fn((def: unknown) => def),
  runMain: vi.fn(),
  showUsage: vi.fn(),
}));

// Stub out all command registrations to avoid loading the full CLI tree
vi.mock('../commander-shim.js', () => {
  class ShimCommand {
    _subcommands: unknown[] = [];
    _args: unknown[] = [];
    _options: unknown[] = [];
    _action = null;
    _name = 'root';
    _description = '';
    _aliases: string[] = [];
    _isDefault = false;
    commands: unknown[] = [];
    command() {
      return this;
    }
    description() {
      return this;
    }
    option() {
      return this;
    }
    requiredOption() {
      return this;
    }
    argument() {
      return this;
    }
    action() {
      return this;
    }
    alias() {
      return this;
    }
  }
  return { ShimCommand };
});

vi.mock('../field-context.js', () => ({
  resolveFieldContext: vi.fn().mockReturnValue({ mviSource: 'default', mvi: 'minimal' }),
  setFieldContext: vi.fn(),
}));

vi.mock('../format-context.js', () => ({
  setFormatContext: vi.fn(),
}));

vi.mock('../middleware/output-format.js', () => ({
  resolveFormat: vi.fn().mockReturnValue({ format: 'minimal' }),
}));

// Stub all command modules to no-ops
vi.mock('../commands/add.js', () => ({ registerAddCommand: vi.fn() }));
vi.mock('../commands/admin.js', () => ({ registerAdminCommand: vi.fn() }));
vi.mock('../commands/adr.js', () => ({ registerAdrCommand: vi.fn() }));
vi.mock('../commands/agent.js', () => ({ registerAgentCommand: vi.fn() }));
vi.mock('../commands/analyze.js', () => ({ registerAnalyzeCommand: vi.fn() }));
vi.mock('../commands/archive.js', () => ({ registerArchiveCommand: vi.fn() }));
vi.mock('../commands/archive-stats.js', () => ({ registerArchiveStatsCommand: vi.fn() }));
vi.mock('../commands/backfill.js', () => ({ registerBackfillCommand: vi.fn() }));
vi.mock('../commands/backup.js', () => ({ registerBackupCommand: vi.fn() }));
vi.mock('../commands/blockers.js', () => ({ registerBlockersCommand: vi.fn() }));
vi.mock('../commands/brain.js', () => ({ registerBrainCommand: vi.fn() }));
vi.mock('../commands/briefing.js', () => ({ registerBriefingCommand: vi.fn() }));
vi.mock('../commands/bug.js', () => ({ registerBugCommand: vi.fn() }));
vi.mock('../commands/cant.js', () => ({ registerCantCommand: vi.fn() }));
vi.mock('../commands/check.js', () => ({ registerCheckCommand: vi.fn() }));
vi.mock('../commands/checkpoint.js', () => ({ registerCheckpointCommand: vi.fn() }));
vi.mock('../commands/commands.js', () => ({ registerCommandsCommand: vi.fn() }));
vi.mock('../commands/complete.js', () => ({ registerCompleteCommand: vi.fn() }));
vi.mock('../commands/compliance.js', () => ({ registerComplianceCommand: vi.fn() }));
vi.mock('../commands/config.js', () => ({ registerConfigCommand: vi.fn() }));
vi.mock('../commands/consensus.js', () => ({ registerConsensusCommand: vi.fn() }));
vi.mock('../commands/context.js', () => ({ registerContextCommand: vi.fn() }));
vi.mock('../commands/contribution.js', () => ({ registerContributionCommand: vi.fn() }));
vi.mock('../commands/current.js', () => ({ registerCurrentCommand: vi.fn() }));
vi.mock('../commands/dash.js', () => ({ registerDashCommand: vi.fn() }));
vi.mock('../commands/decomposition.js', () => ({ registerDecompositionCommand: vi.fn() }));
vi.mock('../commands/delete.js', () => ({ registerDeleteCommand: vi.fn() }));
vi.mock('../commands/deps.js', () => ({
  registerDepsCommand: vi.fn(),
  registerTreeCommand: vi.fn(),
}));
vi.mock('../commands/detect.js', () => ({ registerDetectCommand: vi.fn() }));
vi.mock('../commands/detect-drift.js', () => ({ registerDetectDriftCommand: vi.fn() }));
vi.mock('../commands/docs.js', () => ({ registerDocsCommand: vi.fn() }));
vi.mock('../commands/doctor.js', () => ({ registerDoctorCommand: vi.fn() }));
vi.mock('../commands/env.js', () => ({ registerEnvCommand: vi.fn() }));
vi.mock('../commands/exists.js', () => ({ registerExistsCommand: vi.fn() }));
vi.mock('../commands/export.js', () => ({ registerExportCommand: vi.fn() }));
vi.mock('../commands/export-tasks.js', () => ({ registerExportTasksCommand: vi.fn() }));
vi.mock('../commands/find.js', () => ({ registerFindCommand: vi.fn() }));
vi.mock('../commands/generate-changelog.js', () => ({ registerGenerateChangelogCommand: vi.fn() }));
vi.mock('../commands/grade.js', () => ({ registerGradeCommand: vi.fn() }));
vi.mock('../commands/history.js', () => ({ registerHistoryCommand: vi.fn() }));
vi.mock('../commands/implementation.js', () => ({ registerImplementationCommand: vi.fn() }));
vi.mock('../commands/import.js', () => ({ registerImportCommand: vi.fn() }));
vi.mock('../commands/import-tasks.js', () => ({ registerImportTasksCommand: vi.fn() }));
vi.mock('../commands/init.js', () => ({ registerInitCommand: vi.fn() }));
vi.mock('../commands/inject.js', () => ({ registerInjectCommand: vi.fn() }));
vi.mock('../commands/issue.js', () => ({ registerIssueCommand: vi.fn() }));
vi.mock('../commands/labels.js', () => ({ registerLabelsCommand: vi.fn() }));
vi.mock('../commands/lifecycle.js', () => ({ registerLifecycleCommand: vi.fn() }));
vi.mock('../commands/list.js', () => ({ registerListCommand: vi.fn() }));
vi.mock('../commands/log.js', () => ({ registerLogCommand: vi.fn() }));
vi.mock('../commands/map.js', () => ({ registerMapCommand: vi.fn() }));
vi.mock('../commands/memory-brain.js', () => ({ registerMemoryBrainCommand: vi.fn() }));
vi.mock('../commands/migrate-claude-mem.js', () => ({ registerMigrateClaudeMemCommand: vi.fn() }));
vi.mock('../commands/next.js', () => ({ registerNextCommand: vi.fn() }));
vi.mock('../commands/nexus.js', () => ({ registerNexusCommand: vi.fn() }));
vi.mock('../commands/observe.js', () => ({ registerObserveCommand: vi.fn() }));
vi.mock('../commands/ops.js', () => ({ registerOpsCommand: vi.fn() }));
vi.mock('../commands/orchestrate.js', () => ({ registerOrchestrateCommand: vi.fn() }));
vi.mock('../commands/otel.js', () => ({ registerOtelCommand: vi.fn() }));
vi.mock('../commands/phase.js', () => ({ registerPhaseCommand: vi.fn() }));
vi.mock('../commands/phases.js', () => ({ registerPhasesCommand: vi.fn() }));
vi.mock('../commands/plan.js', () => ({ registerPlanCommand: vi.fn() }));
vi.mock('../commands/promote.js', () => ({ registerPromoteCommand: vi.fn() }));
vi.mock('../commands/reason.js', () => ({ registerReasonCommand: vi.fn() }));
vi.mock('../commands/refresh-memory.js', () => ({ registerRefreshMemoryCommand: vi.fn() }));
vi.mock('../commands/relates.js', () => ({ registerRelatesCommand: vi.fn() }));
vi.mock('../commands/release.js', () => ({ registerReleaseCommand: vi.fn() }));
vi.mock('../commands/remote.js', () => ({ registerRemoteCommand: vi.fn() }));
vi.mock('../commands/reorder.js', () => ({ registerReorderCommand: vi.fn() }));
vi.mock('../commands/reparent.js', () => ({ registerReparentCommand: vi.fn() }));
vi.mock('../commands/research.js', () => ({ registerResearchCommand: vi.fn() }));
vi.mock('../commands/restore.js', () => ({ registerRestoreCommand: vi.fn() }));
vi.mock('../commands/roadmap.js', () => ({ registerRoadmapCommand: vi.fn() }));
vi.mock('../commands/safestop.js', () => ({ registerSafestopCommand: vi.fn() }));
vi.mock('../commands/schema.js', () => ({ registerSchemaCommand: vi.fn() }));
vi.mock('../commands/self-update.js', () => ({ registerSelfUpdateCommand: vi.fn() }));
vi.mock('../commands/sequence.js', () => ({ registerSequenceCommand: vi.fn() }));
vi.mock('../commands/session.js', () => ({ registerSessionCommand: vi.fn() }));
vi.mock('../commands/show.js', () => ({ registerShowCommand: vi.fn() }));
vi.mock('../commands/skills.js', () => ({ registerSkillsCommand: vi.fn() }));
vi.mock('../commands/snapshot.js', () => ({ registerSnapshotCommand: vi.fn() }));
vi.mock('../commands/specification.js', () => ({ registerSpecificationCommand: vi.fn() }));
vi.mock('../commands/start.js', () => ({ registerStartCommand: vi.fn() }));
vi.mock('../commands/stats.js', () => ({ registerStatsCommand: vi.fn() }));
vi.mock('../commands/sticky.js', () => ({ registerStickyCommand: vi.fn() }));
vi.mock('../commands/stop.js', () => ({ registerStopCommand: vi.fn() }));
vi.mock('../commands/testing.js', () => ({ registerTestingCommand: vi.fn() }));
vi.mock('../commands/token.js', () => ({ registerTokenCommand: vi.fn() }));
vi.mock('../commands/update.js', () => ({ registerUpdateCommand: vi.fn() }));
vi.mock('../commands/upgrade.js', () => ({ registerUpgradeCommand: vi.fn() }));
vi.mock('../commands/validate.js', () => ({ registerValidateCommand: vi.fn() }));
vi.mock('../commands/verify.js', () => ({ registerVerifyCommand: vi.fn() }));
vi.mock('../commands/web.js', () => ({ registerWebCommand: vi.fn() }));
vi.mock('../commands/code.js', () => ({ codeCommand: {} }));

// ---------------------------------------------------------------------------

describe('CLI startup: T310 migration hook (T360)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default state: no migration needed
    needsSignaldockToConduitMigrationMock.mockReturnValue(false);
    migrateSignaldockToConduitMock.mockReturnValue({ status: 'no-op', errors: [] });
    getProjectRootMock.mockReturnValue('/test/project');
    getGlobalSaltMock.mockReturnValue(
      Buffer.from('deadbeef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c', 'hex'),
    );
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('calls migrateSignaldockToConduit when needsSignaldockToConduitMigration returns true (AC1)', async () => {
    needsSignaldockToConduitMigrationMock.mockReturnValue(true);
    migrateSignaldockToConduitMock.mockReturnValue({
      status: 'migrated',
      projectRoot: '/test/project',
      agentsCopied: 2,
      conduitPath: '/test/project/.cleo/conduit.db',
      globalSignaldockPath: '/home/.local/share/cleo/signaldock.db',
      bakPath: '/test/project/.cleo/signaldock.db.pre-t310.bak',
      errors: [],
    });

    await import('../index.js');

    expect(needsSignaldockToConduitMigrationMock).toHaveBeenCalledWith('/test/project');
    expect(migrateSignaldockToConduitMock).toHaveBeenCalledWith('/test/project');
  });

  it('skips migrateSignaldockToConduit when needsSignaldockToConduitMigration returns false (TC-067 idempotency)', async () => {
    needsSignaldockToConduitMigrationMock.mockReturnValue(false);

    await import('../index.js');

    expect(needsSignaldockToConduitMigrationMock).toHaveBeenCalledWith('/test/project');
    expect(migrateSignaldockToConduitMock).not.toHaveBeenCalled();
  });

  it('calls ensureConduitDb and ensureGlobalSignaldockDb on every startup (AC2)', async () => {
    await import('../index.js');

    expect(ensureConduitDbMock).toHaveBeenCalledWith('/test/project');
    expect(ensureGlobalSignaldockDbMock).toHaveBeenCalled();
  });

  it('calls validateGlobalSalt and logs 4-byte hex fingerprint at INFO level (AC3)', async () => {
    await import('../index.js');

    expect(validateGlobalSaltMock).toHaveBeenCalled();
    expect(getGlobalSaltMock).toHaveBeenCalled();

    const logCalls = getLoggerMock.mock.results.map((r) => r.value).filter(Boolean);
    // At least one logger instance should have had .info called with fingerprint
    const infoCallArgs = logCalls.flatMap(
      (l: { info: ReturnType<typeof vi.fn> }) => l.info.mock.calls,
    );
    const fingerprintCall = infoCallArgs.find(
      (args: unknown[]) =>
        typeof args[0] === 'object' &&
        args[0] !== null &&
        'fingerprint' in (args[0] as Record<string, unknown>),
    );
    expect(fingerprintCall).toBeDefined();
    // Fingerprint should be 8 hex chars (4 bytes)
    const fp = (fingerprintCall as [{ fingerprint: string }])[0].fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('does not crash CLI when migration fails (AC4 non-fatal)', async () => {
    needsSignaldockToConduitMigrationMock.mockReturnValue(true);
    migrateSignaldockToConduitMock.mockReturnValue({
      status: 'failed',
      projectRoot: '/test/project',
      agentsCopied: 0,
      conduitPath: '/test/project/.cleo/conduit.db',
      globalSignaldockPath: '/home/.local/share/cleo/signaldock.db',
      bakPath: null,
      errors: [{ step: 'step-2-open-legacy', error: 'cannot open DB' }],
    });

    // Should not throw even when migration fails
    await expect(import('../index.js')).resolves.not.toThrow();
  });

  it('silently skips migration when outside a project (E_NO_PROJECT)', async () => {
    getProjectRootMock.mockImplementation(() => {
      throw new Error('E_NO_PROJECT: no .cleo directory found');
    });

    // Should not throw — E_NO_PROJECT is caught and ignored
    await expect(import('../index.js')).resolves.not.toThrow();
    // Migration should not be called when getProjectRoot throws
    expect(migrateSignaldockToConduitMock).not.toHaveBeenCalled();
  });

  it('migration runs before ensureConduitDb (order guarantee per spec §4.6)', async () => {
    needsSignaldockToConduitMigrationMock.mockReturnValue(true);
    migrateSignaldockToConduitMock.mockReturnValue({ status: 'migrated', errors: [] });

    const callOrder: string[] = [];
    migrateSignaldockToConduitMock.mockImplementation(() => {
      callOrder.push('migrate');
      return { status: 'migrated', errors: [] };
    });
    ensureConduitDbMock.mockImplementation(() => {
      callOrder.push('ensureConduit');
      return { action: 'exists', path: '/test/project/.cleo/conduit.db' };
    });

    await import('../index.js');

    const migrateIdx = callOrder.indexOf('migrate');
    const ensureIdx = callOrder.indexOf('ensureConduit');
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(ensureIdx).toBeGreaterThan(migrateIdx);
  });
});
