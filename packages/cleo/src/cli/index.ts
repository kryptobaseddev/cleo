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
import { type CommandDef, defineCommand, runMain, showUsage } from 'citty';
import { ShimCommand } from './commander-shim.js';

function getPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const CLI_VERSION = getPackageVersion();

// Create root shim to collect all commands
const rootShim = new ShimCommand();

import { registerAddCommand } from './commands/add.js';
import { registerAdrCommand } from './commands/adr.js';
// Import all command registration functions
import { registerAgentsCommand } from './commands/agents.js';
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerArchiveCommand } from './commands/archive.js';
import { registerArchiveStatsCommand } from './commands/archive-stats.js';
import { registerBackfillCommand } from './commands/backfill.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerBlockersCommand } from './commands/blockers.js';
import { registerBriefingCommand } from './commands/briefing.js';
import { registerBugCommand } from './commands/bug.js';
import { registerCheckpointCommand } from './commands/checkpoint.js';
import { registerCommandsCommand } from './commands/commands.js';
import { registerCompleteCommand } from './commands/complete.js';
import { registerComplianceCommand } from './commands/compliance.js';
import { registerConfigCommand } from './commands/config.js';
import { registerConsensusCommand } from './commands/consensus.js';
import { registerContextCommand } from './commands/context.js';
import { registerContributionCommand } from './commands/contribution.js';
import { registerCurrentCommand } from './commands/current.js';
import { registerDashCommand } from './commands/dash.js';
import { registerDecompositionCommand } from './commands/decomposition.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerDepsCommand, registerTreeCommand } from './commands/deps.js';
import { registerDetectCommand } from './commands/detect.js';
import { registerDetectDriftCommand } from './commands/detect-drift.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEnvCommand } from './commands/env.js';
import { registerExistsCommand } from './commands/exists.js';
import { registerExportCommand } from './commands/export.js';
import { registerExportTasksCommand } from './commands/export-tasks.js';
import { registerFindCommand } from './commands/find.js';
import { registerGenerateChangelogCommand } from './commands/generate-changelog.js';
import { registerGradeCommand } from './commands/grade.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerImplementationCommand } from './commands/implementation.js';
import { registerImportCommand } from './commands/import.js';
import { registerImportTasksCommand } from './commands/import-tasks.js';
import { registerInitCommand } from './commands/init.js';
import { registerInjectCommand } from './commands/inject.js';
import { registerIssueCommand } from './commands/issue.js';
import { registerLabelsCommand } from './commands/labels.js';
import { registerLifecycleCommand } from './commands/lifecycle.js';
import { registerListCommand } from './commands/list.js';
import { registerLogCommand } from './commands/log.js';
import { registerMapCommand } from './commands/map.js';
import { registerMcpInstallCommand } from './commands/mcp-install.js';
import { registerMemoryBrainCommand } from './commands/memory-brain.js';
import { registerMigrateClaudeMemCommand } from './commands/migrate-claude-mem.js';
import { registerNextCommand } from './commands/next.js';
import { registerNexusCommand } from './commands/nexus.js';
import { registerObserveCommand } from './commands/observe.js';
import { registerOpsCommand } from './commands/ops.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerOtelCommand } from './commands/otel.js';
import { registerPhaseCommand } from './commands/phase.js';
import { registerPhasesCommand } from './commands/phases.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerPromoteCommand } from './commands/promote.js';
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
import { registerSelfUpdateCommand } from './commands/self-update.js';
import { registerSequenceCommand } from './commands/sequence.js';
import { registerSessionCommand } from './commands/session.js';
import { registerShowCommand } from './commands/show.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerSpecificationCommand } from './commands/specification.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerStickyCommand } from './commands/sticky.js';
import { registerStopCommand } from './commands/stop.js';
import { registerTestingCommand } from './commands/testing.js';
import { registerTokenCommand } from './commands/token.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerWebCommand } from './commands/web.js';

// Register all commands against the shim
registerAgentsCommand(rootShim);
registerAddCommand(rootShim);
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
registerLifecycleCommand(rootShim);
registerReleaseCommand(rootShim);
registerEnvCommand(rootShim);
registerMcpInstallCommand(rootShim);
registerCheckpointCommand(rootShim);
registerCommandsCommand(rootShim);
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
registerExistsCommand(rootShim);
registerBugCommand(rootShim);
registerAnalyzeCommand(rootShim);
registerMapCommand(rootShim);
registerBackupCommand(rootShim);
registerBlockersCommand(rootShim);
registerComplianceCommand(rootShim);
registerConfigCommand(rootShim);
registerConsensusCommand(rootShim);
registerContextCommand(rootShim);
registerContributionCommand(rootShim);
registerDashCommand(rootShim);
registerDecompositionCommand(rootShim);
registerDoctorCommand(rootShim);
registerExportCommand(rootShim);
registerHistoryCommand(rootShim);
registerImplementationCommand(rootShim);
registerImportCommand(rootShim);
registerInitCommand(rootShim);
registerInjectCommand(rootShim);
registerLabelsCommand(rootShim);
registerLogCommand(rootShim);
registerNextCommand(rootShim);
registerPlanCommand(rootShim);
registerOtelCommand(rootShim);
registerTokenCommand(rootShim);
registerPhasesCommand(rootShim);
registerPromoteCommand(rootShim);
registerRelatesCommand(rootShim);
registerReorderCommand(rootShim);
registerReparentCommand(rootShim);
registerRestoreCommand(rootShim);
registerRoadmapCommand(rootShim);
registerSelfUpdateCommand(rootShim);
registerSequenceCommand(rootShim);
registerSpecificationCommand(rootShim);
registerStatsCommand(rootShim);
registerUpgradeCommand(rootShim);
registerValidateCommand(rootShim);
registerVerifyCommand(rootShim);
registerDetectCommand(rootShim);
registerDetectDriftCommand(rootShim);
registerOpsCommand(rootShim);
registerSnapshotCommand(rootShim);
registerRemoteCommand(rootShim);
registerGradeCommand(rootShim);
registerAdrCommand(rootShim);
registerBackfillCommand(rootShim);
registerMemoryBrainCommand(rootShim);
registerMigrateClaudeMemCommand(rootShim);
registerStickyCommand(rootShim);
registerReasonCommand(rootShim);
registerRefreshMemoryCommand(rootShim);
registerObserveCommand(rootShim);

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

  const cittyDef: CommandDef = defineCommand({
    meta: {
      name: shim._name,
      description: shim._description,
    },
    args: cittyArgs,
    ...(Object.keys(subCommands).length > 0 ? { subCommands } : {}),
    async run(context) {
      const { args } = context;
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
        // Parent command called without a subcommand: run default subcommand action
        // if one is marked isDefault, otherwise display help.
        const defaultSub = shim._subcommands.find((s) => s._isDefault);
        if (defaultSub?._action) {
          // Invoke the default subcommand's action with no positional args and empty opts
          await defaultSub._action({} as Record<string, unknown>, defaultSub);
        } else {
          await showUsage(context.cmd);
        }
      }
    },
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

for (const shim of rootShim._subcommands) {
  subCommands[shim._name] = shimToCitty(shim);
  for (const alias of shim._aliases) {
    subCommands[alias] = shimToCitty(shim);
  }
}

if (process.argv[2] === 'mcp') {
  const mcpPath = join(import.meta.dirname ?? '', '..', 'mcp', 'index.js');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', mcpPath], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const main = defineCommand({
    meta: {
      name: 'cleo',
      version: CLI_VERSION,
      description: 'CLEO V2 - Task management for AI coding agents',
    },
    subCommands,
  });

  runMain(main);
}
