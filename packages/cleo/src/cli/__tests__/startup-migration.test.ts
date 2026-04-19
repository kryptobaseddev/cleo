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

// Stub all command modules to no-ops (native citty exports)
vi.mock('../commands/add.js', () => ({ addCommand: {} }));
vi.mock('../commands/admin.js', () => ({ adminCommand: {} }));
vi.mock('../commands/adr.js', () => ({ adrCommand: {} }));
vi.mock('../commands/agent.js', () => ({ agentCommand: {} }));
vi.mock('../commands/analyze.js', () => ({ analyzeCommand: {} }));
vi.mock('../commands/archive.js', () => ({ archiveCommand: {} }));
vi.mock('../commands/archive-stats.js', () => ({ archiveStatsCommand: {} }));
vi.mock('../commands/backfill.js', () => ({ backfillCommand: {} }));
vi.mock('../commands/backup.js', () => ({ backupCommand: {} }));
vi.mock('../commands/blockers.js', () => ({ blockersCommand: {} }));
vi.mock('../commands/brain.js', () => ({ brainCommand: {} }));
vi.mock('../commands/briefing.js', () => ({ briefingCommand: {} }));
vi.mock('../commands/bug.js', () => ({ bugCommand: {} }));
vi.mock('../commands/cant.js', () => ({ cantCommand: {} }));
vi.mock('../commands/check.js', () => ({ checkCommand: {} }));
vi.mock('../commands/checkpoint.js', () => ({ checkpointCommand: {} }));
vi.mock('../commands/complete.js', () => ({ completeCommand: {} }));
vi.mock('../commands/compliance.js', () => ({ complianceCommand: {} }));
vi.mock('../commands/config.js', () => ({ configCommand: {} }));
vi.mock('../commands/consensus.js', () => ({ consensusCommand: {} }));
vi.mock('../commands/context.js', () => ({ contextCommand: {} }));
vi.mock('../commands/contribution.js', () => ({ contributionCommand: {} }));
vi.mock('../commands/current.js', () => ({ currentCommand: {} }));
vi.mock('../commands/dash.js', () => ({ dashCommand: {} }));
vi.mock('../commands/decomposition.js', () => ({ decompositionCommand: {} }));
vi.mock('../commands/delete.js', () => ({ deleteCommand: {} }));
vi.mock('../commands/deps.js', () => ({ depsCommand: {}, treeCommand: {} }));
vi.mock('../commands/detect.js', () => ({ detectCommand: {} }));
vi.mock('../commands/detect-drift.js', () => ({ detectDriftCommand: {} }));
vi.mock('../commands/docs.js', () => ({ docsCommand: {} }));
vi.mock('../commands/doctor.js', () => ({ doctorCommand: {} }));
vi.mock('../commands/exists.js', () => ({ existsCommand: {} }));
vi.mock('../commands/export.js', () => ({ exportCommand: {} }));
vi.mock('../commands/export-tasks.js', () => ({ exportTasksCommand: {} }));
vi.mock('../commands/find.js', () => ({ findCommand: {} }));
vi.mock('../commands/generate-changelog.js', () => ({ generateChangelogCommand: {} }));
vi.mock('../commands/grade.js', () => ({ gradeCommand: {} }));
vi.mock('../commands/history.js', () => ({ historyCommand: {} }));
vi.mock('../commands/import.js', () => ({ importCommand: {} }));
vi.mock('../commands/import-tasks.js', () => ({ importTasksCommand: {} }));
vi.mock('../commands/init.js', () => ({ initCommand: {} }));
vi.mock('../commands/inject.js', () => ({ injectCommand: {} }));
vi.mock('../commands/issue.js', () => ({ issueCommand: {} }));
vi.mock('../commands/labels.js', () => ({ labelsCommand: {} }));
vi.mock('../commands/lifecycle.js', () => ({ lifecycleCommand: {} }));
vi.mock('../commands/list.js', () => ({ listCommand: {} }));
vi.mock('../commands/log.js', () => ({ logCommand: {} }));
vi.mock('../commands/map.js', () => ({ mapCommand: {} }));
vi.mock('../commands/memory.js', () => ({ memoryCommand: {} }));
vi.mock('../commands/migrate-claude-mem.js', () => ({ migrateClaudeMemCommand: {} }));
vi.mock('../commands/next.js', () => ({ nextCommand: {} }));
vi.mock('../commands/nexus.js', () => ({ nexusCommand: {} }));
vi.mock('../commands/ops.js', () => ({ opsCommand: {} }));
vi.mock('../commands/orchestrate.js', () => ({ orchestrateCommand: {} }));
vi.mock('../commands/otel.js', () => ({ otelCommand: {} }));
vi.mock('../commands/phase.js', () => ({ phaseCommand: {} }));
vi.mock('../commands/plan.js', () => ({ planCommand: {} }));
vi.mock('../commands/promote.js', () => ({ promoteCommand: {} }));
vi.mock('../commands/reason.js', () => ({ reasonCommand: {} }));
vi.mock('../commands/refresh-memory.js', () => ({ refreshMemoryCommand: {} }));
vi.mock('../commands/relates.js', () => ({ relatesCommand: {} }));
vi.mock('../commands/release.js', () => ({ releaseCommand: {} }));
vi.mock('../commands/remote.js', () => ({
  remoteCommand: {},
  pushCommand: {},
  pullCommand: {},
}));
vi.mock('../commands/reorder.js', () => ({ reorderCommand: {} }));
vi.mock('../commands/reparent.js', () => ({ reparentCommand: {} }));
vi.mock('../commands/req.js', () => ({ reqCommand: {} }));
vi.mock('../commands/research.js', () => ({ researchCommand: {} }));
vi.mock('../commands/restore.js', () => ({ restoreCommand: {} }));
vi.mock('../commands/roadmap.js', () => ({ roadmapCommand: {} }));
vi.mock('../commands/safestop.js', () => ({ safestopCommand: {} }));
vi.mock('../commands/schema.js', () => ({ schemaCommand: {} }));
vi.mock('../commands/self-update.js', () => ({ selfUpdateCommand: {} }));
vi.mock('../commands/sequence.js', () => ({ sequenceCommand: {} }));
vi.mock('../commands/session.js', () => ({ sessionCommand: {} }));
vi.mock('../commands/show.js', () => ({ showCommand: {} }));
vi.mock('../commands/skills.js', () => ({ skillsCommand: {} }));
vi.mock('../commands/snapshot.js', () => ({ snapshotCommand: {} }));
vi.mock('../commands/start.js', () => ({ startCommand: {} }));
vi.mock('../commands/stats.js', () => ({ statsCommand: {} }));
vi.mock('../commands/sticky.js', () => ({ stickyCommand: {} }));
vi.mock('../commands/stop.js', () => ({ stopCommand: {} }));
vi.mock('../commands/testing.js', () => ({ testingCommand: {} }));
vi.mock('../commands/token.js', () => ({ tokenCommand: {} }));
vi.mock('../commands/update.js', () => ({ updateCommand: {} }));
vi.mock('../commands/upgrade.js', () => ({ upgradeCommand: {} }));
vi.mock('../commands/verify.js', () => ({ verifyCommand: {} }));
vi.mock('../commands/web.js', () => ({ webCommand: {} }));
vi.mock('../commands/code.js', () => ({ codeCommand: {} }));

vi.mock('../commands/adapter.js', () => ({ adapterCommand: {} }));
vi.mock('../commands/add-batch.js', () => ({ addBatchCommand: {} }));
vi.mock('../commands/cancel.js', () => ({ cancelCommand: {} }));
vi.mock('../commands/chain.js', () => ({ chainCommand: {} }));
vi.mock('../commands/claim.js', () => ({ claimCommand: {}, unclaimCommand: {} }));
vi.mock('../commands/complexity.js', () => ({ complexityCommand: {} }));
vi.mock('../commands/daemon.js', () => ({ daemonCommand: {} }));
vi.mock('../commands/diagnostics.js', () => ({ diagnosticsCommand: {} }));
vi.mock('../commands/gc.js', () => ({ gcCommand: {} }));
vi.mock('../commands/intelligence.js', () => ({ intelligenceCommand: {} }));
vi.mock('../commands/provider.js', () => ({ providerCommand: {} }));
vi.mock('../commands/sync.js', () => ({ syncCommand: {} }));
vi.mock('../commands/transcript.js', () => ({ transcriptCommand: {} }));
vi.mock('../commands/conduit.js', () => ({ conduitCommand: {} }));
vi.mock('../commands/playbook.js', () => ({ playbookCommand: {} }));
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

// ---------------------------------------------------------------------------
// Native citty wiring verification
// ---------------------------------------------------------------------------

describe('CLI subCommands wiring (native citty)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('key commands are wired in subCommands', async () => {
    const mod = await import('../index.js');
    // The module exports nothing directly — but we can verify citty's defineCommand
    // was called with a subCommands map containing known commands by checking
    // that the mock received the expected structure.
    const { defineCommand } = await import('citty');
    const calls = (defineCommand as ReturnType<typeof vi.fn>).mock.calls;
    // The root defineCommand call passes { meta: {name:'cleo'}, subCommands }.
    // Sub-group commands (e.g. `cleo sentient`) also have meta+subCommands,
    // so we filter for meta.name === 'cleo' to identify the true root.
    const rootCall = calls.find((args: unknown[]) => {
      const arg0 = args[0];
      if (arg0 === null || typeof arg0 !== 'object') return false;
      if (!('meta' in arg0) || !('subCommands' in arg0)) return false;
      const meta = (arg0 as Record<string, unknown>).meta;
      return (
        meta !== null &&
        typeof meta === 'object' &&
        (meta as Record<string, unknown>).name === 'cleo'
      );
    });
    expect(rootCall).toBeDefined();
    const def = rootCall?.[0] as { subCommands: Record<string, unknown> };
    expect(def.subCommands).toHaveProperty('show');
    expect(def.subCommands).toHaveProperty('add');
    expect(def.subCommands).toHaveProperty('complete');
    expect(def.subCommands).toHaveProperty('find');
    // Aliases are wired
    expect(def.subCommands).toHaveProperty('done');
    expect(def.subCommands).toHaveProperty('rm');
    // unused symbol suppresses ts-unused-vars
    void mod;
  });
});
