/**
 * CLEO CLI - Main entry point
 *
 * Bridges commander-shim commands to citty for execution.
 *
 * TODO: Migrate all 89 commands to native citty pattern (epic T5730)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectAndRemoveLegacyGlobalFiles,
  detectAndRemoveStrayProjectNexus,
  ensureConduitDb,
  ensureGlobalSignaldockDb,
  getGlobalSalt,
  getLogger,
  getProjectRoot,
  migrateSignaldockToConduit,
  needsSignaldockToConduitMigration,
  validateGlobalSalt,
} from '@cleocode/core/internal';
import { type CommandDef, defineCommand, runMain, showUsage } from 'citty';
import { ShimCommand } from './commander-shim.js';
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { buildAliasMap, createCustomShowUsage } from './help-renderer.js';
import { resolveFormat } from './middleware/output-format.js';

function getPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const CLI_VERSION = getPackageVersion();

// Create root shim to collect all commands
const rootShim = new ShimCommand();

import { registerAdapterCommand } from './commands/adapter.js';
import { registerAddCommand } from './commands/add.js';
import { registerAddBatchCommand } from './commands/add-batch.js';
import { registerAdminCommand } from './commands/admin.js';
import { registerAdrCommand } from './commands/adr.js';
// Import all command registration functions
import { registerAgentCommand } from './commands/agent.js';
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerArchiveCommand } from './commands/archive.js';
import { registerArchiveStatsCommand } from './commands/archive-stats.js';
import { registerBackfillCommand } from './commands/backfill.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerBlockersCommand } from './commands/blockers.js';
import { registerBrainCommand } from './commands/brain.js';
import { registerBriefingCommand } from './commands/briefing.js';
import { registerBugCommand } from './commands/bug.js';
import { registerCancelCommand } from './commands/cancel.js';
import { registerCantCommand } from './commands/cant.js';
import { registerChainCommand } from './commands/chain.js';
import { registerCheckCommand } from './commands/check.js';
import { registerCheckpointCommand } from './commands/checkpoint.js';
import { registerClaimCommand, registerUnclaimCommand } from './commands/claim.js';
// DEPRECATED: registerCommandsCommand removed — use `cleo ops` instead
import { registerCompleteCommand } from './commands/complete.js';
import { registerComplexityCommand } from './commands/complexity.js';
import { registerComplianceCommand } from './commands/compliance.js';
import { registerConfigCommand } from './commands/config.js';
// DEPRECATED: registerConsensusCommand removed — use `cleo check protocol consensus`
import { registerContextCommand } from './commands/context.js';
// DEPRECATED: registerContributionCommand removed — use `cleo check protocol contribution`
import { registerCurrentCommand } from './commands/current.js';
import { registerDashCommand } from './commands/dash.js';
// DEPRECATED: registerDecompositionCommand removed — use `cleo check protocol decomposition`
import { registerDeleteCommand } from './commands/delete.js';
import { registerDepsCommand, registerTreeCommand } from './commands/deps.js';
import { registerDetectCommand } from './commands/detect.js';
import { registerDetectDriftCommand } from './commands/detect-drift.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExistsCommand } from './commands/exists.js';
import { registerExportCommand } from './commands/export.js';
import { registerExportTasksCommand } from './commands/export-tasks.js';
import { registerFindCommand } from './commands/find.js';
import { registerGenerateChangelogCommand } from './commands/generate-changelog.js';
import { registerGradeCommand } from './commands/grade.js';
import { registerHistoryCommand } from './commands/history.js';
// DEPRECATED: registerImplementationCommand removed — use `cleo check protocol implementation`
import { registerImportCommand } from './commands/import.js';
import { registerImportTasksCommand } from './commands/import-tasks.js';
import { registerInitCommand } from './commands/init.js';
import { registerInjectCommand } from './commands/inject.js';
import { registerIntelligenceCommand } from './commands/intelligence.js';
import { registerIssueCommand } from './commands/issue.js';
import { registerLabelsCommand } from './commands/labels.js';
import { registerLifecycleCommand } from './commands/lifecycle.js';
import { registerListCommand } from './commands/list.js';
import { registerLogCommand } from './commands/log.js';
import { registerMapCommand } from './commands/map.js';
import { registerMemoryBrainCommand } from './commands/memory-brain.js';
import { registerMigrateClaudeMemCommand } from './commands/migrate-claude-mem.js';
import { registerNextCommand } from './commands/next.js';
import { registerNexusCommand } from './commands/nexus.js';
// DEPRECATED: registerObserveCommand removed — use `cleo memory observe` instead
import { registerOpsCommand } from './commands/ops.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerOtelCommand } from './commands/otel.js';
import { registerPhaseCommand } from './commands/phase.js';
// DEPRECATED: registerPhasesCommand removed — use `cleo phase` instead
import { registerPlanCommand } from './commands/plan.js';
import { registerPromoteCommand } from './commands/promote.js';
import { registerProviderCommand } from './commands/provider.js';
import { registerReasonCommand } from './commands/reason.js';
import { registerRefreshMemoryCommand } from './commands/refresh-memory.js';
import { registerRelatesCommand } from './commands/relates.js';
import { registerReleaseCommand } from './commands/release.js';
import { registerRemoteCommand } from './commands/remote.js';
import { registerReorderCommand } from './commands/reorder.js';
import { registerReparentCommand } from './commands/reparent.js';
import { registerResearchCommand } from './commands/research.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
import { registerSafestopCommand } from './commands/safestop.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerSelfUpdateCommand } from './commands/self-update.js';
import { registerSequenceCommand } from './commands/sequence.js';
import { registerSessionCommand } from './commands/session.js';
import { registerShowCommand } from './commands/show.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
// DEPRECATED: registerSpecificationCommand removed — use `cleo check protocol specification`
import { registerStartCommand } from './commands/start.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerStickyCommand } from './commands/sticky.js';
import { registerStopCommand } from './commands/stop.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerTestingCommand } from './commands/testing.js';
import { registerTokenCommand } from './commands/token.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
// DEPRECATED: registerValidateCommand removed — use `cleo check schema todo`
import { registerVerifyCommand } from './commands/verify.js';
import { registerWebCommand } from './commands/web.js';

// Register all commands against the shim
registerAgentCommand(rootShim);
registerAddCommand(rootShim);
registerAddBatchCommand(rootShim);
registerListCommand(rootShim);
registerShowCommand(rootShim);
registerFindCommand(rootShim);
registerCompleteCommand(rootShim);
registerUpdateCommand(rootShim);
registerDeleteCommand(rootShim);
registerArchiveCommand(rootShim);
registerStartCommand(rootShim);
registerStopCommand(rootShim);
registerCurrentCommand(rootShim);
registerBriefingCommand(rootShim);
registerSessionCommand(rootShim);
registerPhaseCommand(rootShim);
registerDepsCommand(rootShim);
registerTreeCommand(rootShim);
registerResearchCommand(rootShim);
registerOrchestrateCommand(rootShim);
registerChainCommand(rootShim);
registerLifecycleCommand(rootShim);
registerReleaseCommand(rootShim);
registerCheckpointCommand(rootShim);
// DEPRECATED: registerCommandsCommand(rootShim) — removed, use `cleo ops`
registerDocsCommand(rootShim);
registerExportTasksCommand(rootShim);
registerImportTasksCommand(rootShim);
registerSafestopCommand(rootShim);
registerTestingCommand(rootShim);
registerWebCommand(rootShim);
registerNexusCommand(rootShim);
registerArchiveStatsCommand(rootShim);
registerGenerateChangelogCommand(rootShim);
registerIssueCommand(rootShim);
registerSkillsCommand(rootShim);
registerProviderCommand(rootShim);
registerAdapterCommand(rootShim);
registerExistsCommand(rootShim);
registerBugCommand(rootShim);
registerCancelCommand(rootShim);
registerClaimCommand(rootShim);
registerUnclaimCommand(rootShim);
registerComplexityCommand(rootShim);
registerSyncCommand(rootShim);
registerAnalyzeCommand(rootShim);
registerMapCommand(rootShim);
registerBackupCommand(rootShim);
registerBlockersCommand(rootShim);
registerCheckCommand(rootShim);
registerComplianceCommand(rootShim);
registerConfigCommand(rootShim);
// DEPRECATED: registerConsensusCommand(rootShim) — removed
registerContextCommand(rootShim);
// DEPRECATED: registerContributionCommand(rootShim) — removed
registerDashCommand(rootShim);
// DEPRECATED: registerDecompositionCommand(rootShim) — removed
registerDoctorCommand(rootShim);
registerExportCommand(rootShim);
registerHistoryCommand(rootShim);
// DEPRECATED: registerImplementationCommand(rootShim) — removed
registerImportCommand(rootShim);
registerInitCommand(rootShim);
registerInjectCommand(rootShim);
registerIntelligenceCommand(rootShim);
registerLabelsCommand(rootShim);
registerLogCommand(rootShim);
registerNextCommand(rootShim);
registerPlanCommand(rootShim);
registerOtelCommand(rootShim);
registerTokenCommand(rootShim);
// DEPRECATED: registerPhasesCommand(rootShim) — removed, use `cleo phase`
registerPromoteCommand(rootShim);
registerRelatesCommand(rootShim);
registerReorderCommand(rootShim);
registerReparentCommand(rootShim);
registerRestoreCommand(rootShim);
registerRoadmapCommand(rootShim);
registerSelfUpdateCommand(rootShim);
registerSequenceCommand(rootShim);
// DEPRECATED: registerSpecificationCommand(rootShim) — removed
registerStatsCommand(rootShim);
registerUpgradeCommand(rootShim);
// DEPRECATED: registerValidateCommand(rootShim) — removed, use `cleo check schema todo`
registerVerifyCommand(rootShim);
registerDetectCommand(rootShim);
registerDetectDriftCommand(rootShim);
registerOpsCommand(rootShim);
registerSnapshotCommand(rootShim);
registerRemoteCommand(rootShim);
registerGradeCommand(rootShim);
registerAdminCommand(rootShim);
registerAdrCommand(rootShim);
registerBackfillCommand(rootShim);
registerBrainCommand(rootShim);
registerCantCommand(rootShim);
registerMemoryBrainCommand(rootShim);
registerMigrateClaudeMemCommand(rootShim);
registerStickyCommand(rootShim);
registerReasonCommand(rootShim);
registerRefreshMemoryCommand(rootShim);
registerSchemaCommand(rootShim);

function shimToCitty(shim: ShimCommand): CommandDef {
  const cittyArgs: Record<string, import('citty').ArgDef> = {};

  for (const arg of shim._args) {
    cittyArgs[arg.name] = {
      type: 'positional',
      description: arg.name,
      required: arg.required,
    } as import('citty').ArgDef;
  }

  for (const opt of shim._options) {
    const argDef: import('citty').ArgDef = {
      type: opt.takesValue ? 'string' : 'boolean',
      description: opt.description,
      required: opt.required,
    } as import('citty').ArgDef;

    if (opt.shortName) {
      (argDef as Record<string, unknown>).alias = opt.shortName;
    }
    if (opt.defaultValue !== undefined) {
      (argDef as Record<string, unknown>).default = opt.defaultValue;
    }

    cittyArgs[opt.longName] = argDef;
  }

  const subCommands: Record<string, CommandDef> = {};
  for (const sub of shim._subcommands) {
    subCommands[sub._name] = shimToCitty(sub);
    for (const alias of sub._aliases) {
      subCommands[alias] = shimToCitty(sub);
    }
  }

  // Build the run function. For parent commands that only have subcommands
  // (no action of their own), we handle two cases:
  // 1. A default subcommand is marked (isDefault) → invoke it
  // 2. No default → show help text
  // But ONLY when no subcommand was specified — citty calls the parent run()
  // even when a subcommand is resolved, so we detect this via rawArgs.
  const hasSubCommands = Object.keys(subCommands).length > 0;
  const subCommandNames = new Set(
    shim._subcommands.flatMap((s) => [s._name, ...s._aliases].filter(Boolean)),
  );

  const runFn = async (context: {
    args: Record<string, unknown>;
    rawArgs: string[];
    cmd: CommandDef;
  }) => {
    const { args } = context;
    // If a subcommand was invoked, citty handles it — don't double-fire.
    if (hasSubCommands && context.rawArgs.some((a) => subCommandNames.has(a))) {
      return;
    }

    if (shim._action) {
      const positionalValues: unknown[] = [];
      for (const arg of shim._args) {
        positionalValues.push(args[arg.name]);
      }

      const opts: Record<string, unknown> = {};
      for (const opt of shim._options) {
        const val = args[opt.longName];
        if (val !== undefined && val !== false) {
          if (opt.parseFn && typeof val === 'string') {
            opts[opt.longName] = opt.parseFn(val);
          } else {
            opts[opt.longName] = val;
          }
        }
      }

      await shim._action(...positionalValues, opts, shim);
    } else if (shim._subcommands.length > 0) {
      const defaultSub = shim._subcommands.find((s) => s._isDefault);
      if (defaultSub?._action) {
        await defaultSub._action({} as Record<string, unknown>, defaultSub);
      } else {
        await showUsage(context.cmd);
      }
    }
  };

  const cittyDef: CommandDef = defineCommand({
    meta: {
      name: shim._name,
      description: shim._description,
    },
    args: cittyArgs,
    ...(hasSubCommands ? { subCommands } : {}),
    run: runFn as CommandDef['run'],
  });
  return cittyDef;
}

const subCommands: Record<string, CommandDef> = {};

subCommands['version'] = defineCommand({
  meta: { name: 'version', description: 'Display CLEO version' },
  async run() {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  },
});

// Native citty command groups (not shimmed from Commander)
import { codeCommand } from './commands/code.js';

subCommands['code'] = codeCommand;

for (const shim of rootShim._subcommands) {
  subCommands[shim._name] = shimToCitty(shim);
  for (const alias of shim._aliases) {
    subCommands[alias] = shimToCitty(shim);
  }
}

// ---------------------------------------------------------------------------
// Global flag resolution (replaces Commander.js preAction hook)
//
// LAFS format flags (--human, --json, --quiet) and field flags (--field,
// --fields, --mvi) must be resolved BEFORE any command runs so that
// cliOutput() and dispatchFromCli() can read the correct context.
// This was previously done in a Commander.js preAction hook that was lost
// during the citty migration — restoring it here fixes --human, --quiet, etc.
// ---------------------------------------------------------------------------
{
  const argv = process.argv.slice(2);

  // Parse global format + field flags from argv
  const rawOpts: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') rawOpts['json'] = true;
    else if (arg === '--human') rawOpts['human'] = true;
    else if (arg === '--quiet') rawOpts['quiet'] = true;
    else if (arg === '--field' && i + 1 < argv.length) rawOpts['field'] = argv[++i];
    else if (arg === '--fields' && i + 1 < argv.length) rawOpts['fields'] = argv[++i];
    else if (arg === '--mvi' && i + 1 < argv.length) rawOpts['mvi'] = argv[++i];
  }

  // Resolve and set format context (JSON/human/quiet)
  const formatResolution = resolveFormat(rawOpts);
  setFormatContext(formatResolution);

  // Resolve and set field extraction context (--field, --fields, --mvi)
  const fieldResolution = resolveFieldContext(rawOpts);
  // Per owner directive: agent-first MVI. Default to 'minimal' unless user
  // explicitly passed --mvi standard/full (mviSource === 'flag').
  if (fieldResolution.mviSource === 'default') {
    fieldResolution.mvi = 'minimal';
  }
  setFieldContext(fieldResolution);

  // One-shot idempotent cleanup of legacy global-tier files (T304 / ADR-036).
  // Runs non-blocking on every invocation; errors are swallowed so that stale
  // files never prevent normal command execution.
  try {
    detectAndRemoveLegacyGlobalFiles();
  } catch {
    // Non-fatal: legacy cleanup must never break the CLI startup path.
  }

  // One-shot cleanup of stray project-tier nexus.db (T307 / ADR-036).
  // A zero-byte .cleo/nexus.db was accidentally created by pre-v2026.4.11
  // code. This removes it on first `cleo` run post-upgrade. Best-effort:
  // errors are swallowed so cleanup never blocks normal command execution.
  try {
    detectAndRemoveStrayProjectNexus(getProjectRoot());
  } catch {
    // Non-fatal: stray-nexus cleanup must never break the CLI startup path.
  }

  // ---------------------------------------------------------------------------
  // T310 startup sequence (spec §4.6) — runs AFTER v2026.4.11 cleanups and
  // BEFORE any DB accessor is called so the first command sees the new topology.
  // All steps are non-fatal: errors are logged and CLI continues normally.
  // ---------------------------------------------------------------------------
  const _startupLog = getLogger('cli-startup');

  // Step 2: One-shot T310 signaldock → conduit migration (T358 / ADR-037 §8).
  // Guarded by needsSignaldockToConduitMigration for efficiency; the check is
  // idempotent — migration is skipped silently once conduit.db exists (TC-067).
  try {
    const _projectRootForMigration = getProjectRoot();
    if (needsSignaldockToConduitMigration(_projectRootForMigration)) {
      const migrationResult = migrateSignaldockToConduit(_projectRootForMigration);
      if (migrationResult.status === 'failed') {
        _startupLog.error(
          { errors: migrationResult.errors, projectRoot: _projectRootForMigration },
          'T310 migration: signaldock → conduit failed — CLI continues, run `cleo doctor` to diagnose',
        );
      }
    }
  } catch (err) {
    // getProjectRoot() throws with E_NO_PROJECT when run outside a project directory.
    // Migration is per-project so we skip silently in that case.
    if (err instanceof Error && err.message.includes('E_NO_PROJECT')) {
      // Expected for global commands (e.g. `cleo session status`) — no-op.
    } else {
      _startupLog.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'T310 migration startup check threw unexpectedly — CLI continues',
      );
    }
  }

  // Step 3: Ensure conduit.db exists on fresh install (idempotent, project-scoped).
  try {
    ensureConduitDb(getProjectRoot());
  } catch {
    // Non-fatal: may throw E_NO_PROJECT outside a project; conduit.db is optional
    // for global commands.
  }

  // Step 4: Ensure global signaldock.db exists (idempotent, global-tier).
  try {
    await ensureGlobalSignaldockDb();
  } catch (err) {
    _startupLog.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'T310 startup: ensureGlobalSignaldockDb failed — CLI continues',
    );
  }

  // Step 5: Validate global-salt integrity and log 4-byte hex fingerprint (spec §4.6).
  try {
    validateGlobalSalt();
    // Log first 4 bytes of the salt as a hex fingerprint for diagnosability.
    // getGlobalSalt() generates the salt on first call if absent; validation above
    // already confirmed the file is well-formed (or absent — first-run path).
    const salt = getGlobalSalt();
    const fingerprint = salt.subarray(0, 4).toString('hex');
    _startupLog.info({ fingerprint }, 'global-salt fingerprint');
  } catch (err) {
    _startupLog.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'T310 startup: validateGlobalSalt failed — CLI continues, run `cleo doctor` to diagnose',
    );
  }

  // Handle -V as alias for --version (citty handles --version but not -V)
  // Must come after format context is set so output respects --json/--human
  if (argv[0] === '-V') {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
    process.exit(0);
  }
}

const main = defineCommand({
  meta: {
    name: 'cleo',
    version: CLI_VERSION,
    description: 'CLEO V2 - Task management for AI coding agents',
  },
  subCommands,
});

// Build alias map for help rendering (alias name → primary command name)
const aliasMap = buildAliasMap(rootShim._subcommands);

// Use custom grouped help renderer for root --help; sub-commands use citty's default
const customShowUsage = createCustomShowUsage(CLI_VERSION, rootShim._subcommands, aliasMap);
runMain(main, { showUsage: customShowUsage });
