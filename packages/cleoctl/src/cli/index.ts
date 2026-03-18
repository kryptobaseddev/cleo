/**
 * CLEO V2 CLI entry point — citty-based (ESM-native).
 *
 * Replaces the Commander.js entry point with citty for clean ESM bundling.
 * Individual command files still use the Commander shim API (ShimCommand)
 * which is translated into citty subcommands at startup.
 *
 * @epic T4454
 * @task T4455
 */

import { defineCommand, runMain } from 'citty';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkStorageMigration,
  getNodeUpgradeInstructions,
  getNodeVersionInfo,
  loadConfig as loadCoreConfig,
  MINIMUM_NODE_MAJOR,
} from '@cleocode/core/internal';

import { ShimCommand } from './commander-shim.js';
import type { ShimOption, ShimArg } from './commander-shim.js';
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { initCliLogger } from './logger-bootstrap.js';
import { resolveFormat } from './middleware/output-format.js';

// ---------------------------------------------------------------------------
// Node.js version gate
// ---------------------------------------------------------------------------

const nodeInfo = getNodeVersionInfo();
if (!nodeInfo.meetsMinimum) {
  const upgrade = getNodeUpgradeInstructions();
  process.stderr.write(
    `\nError: CLEO requires Node.js v${MINIMUM_NODE_MAJOR}+ but found v${nodeInfo.version}\n` +
      `\nUpgrade options:\n` +
      upgrade.instructions.map((i: string) => `  - ${i}`).join('\n') +
      `\n\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Version from package.json
// ---------------------------------------------------------------------------

function getPackageVersion(): string {
  try {
    const moduleRoot = join(import.meta.dirname ?? '', '..', '..');
    const pkg = JSON.parse(readFileSync(join(moduleRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const CLI_VERSION = getPackageVersion();

// ---------------------------------------------------------------------------
// Pre-action hooks (logger, format, field context, migration check)
// ---------------------------------------------------------------------------

let loggerInitialized = false;

async function runPreActionHooks(commandName: string): Promise<void> {
  // 1. Logger init (once)
  if (!loggerInitialized) {
    loggerInitialized = true;
    try {
      const config = await loadCoreConfig();
      initCliLogger(process.cwd(), config.logging);

      const { pruneAuditLog } = await import('@cleocode/core/internal');
      pruneAuditLog(join(process.cwd(), '.cleo'), config.logging).catch(() => {
        /* non-blocking */
      });
    } catch {
      // Logger init is best-effort
    }
  }

  // 2. Output format resolution from global flags
  // Global flags are parsed from process.argv directly since citty
  // doesn't propagate parent args to subcommands automatically.
  const globalOpts = parseGlobalFlags(process.argv.slice(2));
  try {
    const resolution = resolveFormat(globalOpts);
    setFormatContext(resolution);
  } catch {
    // Fallback: leave default (json) format
  }

  // 3. Field extraction context
  try {
    setFieldContext(resolveFieldContext(globalOpts));
  } catch (err) {
    const e = err as { message?: string };
    process.stderr.write(`Error: ${e.message ?? String(err)}\n`);
    process.exit(2);
  }

  // 4. Pre-flight migration check
  const SKIP_PREFLIGHT = new Set(['version', 'init', 'self-update', 'upgrade', 'help']);
  if (!SKIP_PREFLIGHT.has(commandName)) {
    try {
      const result = checkStorageMigration();
      if (result.migrationNeeded) {
        process.stderr.write(
          `\n⚠ Storage migration needed: ${result.summary}\n` + `  Fix: ${result.fix}\n\n`,
        );
      }
    } catch {
      // Never block CLI operation due to preflight failure
    }
  }
}

/**
 * Parse global flags from raw argv (before citty consumes them).
 * Extracts --json, --human, --quiet, --field, --fields, --mvi.
 */
function parseGlobalFlags(argv: string[]): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts['json'] = true;
    else if (arg === '--human') opts['human'] = true;
    else if (arg === '--quiet') opts['quiet'] = true;
    else if (arg === '--field' && i + 1 < argv.length) opts['field'] = argv[++i];
    else if (arg === '--fields' && i + 1 < argv.length) opts['fields'] = argv[++i];
    else if (arg === '--mvi' && i + 1 < argv.length) opts['mvi'] = argv[++i];
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Domain grouping for help display
// ---------------------------------------------------------------------------

const DOMAIN_GROUPS: Record<string, string[]> = {
  Tasks: [
    'add', 'list', 'show', 'find', 'complete', 'update', 'delete', 'archive',
    'start', 'stop', 'current', 'next', 'archive-stats', 'restore', 'reorder',
    'reparent', 'relates', 'tree', 'deps', 'labels', 'tags', 'blockers',
    'exists', 'stats', 'history',
  ],
  Session: ['session', 'briefing', 'phase', 'checkpoint', 'safestop'],
  Memory: [
    'memory', 'memory-brain', 'observe', 'context', 'inject', 'sync',
    'sticky', 'note', 'refresh-memory',
  ],
  Check: ['validate', 'verify', 'compliance', 'doctor', 'analyze'],
  Pipeline: [
    'release', 'lifecycle', 'promote', 'upgrade', 'specification',
    'detect-drift', 'roadmap', 'plan', 'log', 'issue', 'bug',
    'generate-changelog', 'phases',
  ],
  Orchestration: [
    'orchestrate', 'ops', 'consensus', 'contribution', 'decomposition',
    'implementation', 'sequence', 'dash',
  ],
  Research: ['research', 'extract', 'web', 'docs'],
  Nexus: ['nexus', 'init', 'remote', 'push', 'pull', 'snapshot', 'export', 'import'],
  Admin: [
    'config', 'backup', 'export-tasks', 'import-tasks', 'env', 'mcp-install',
    'testing', 'skills', 'self-update', 'install-global', 'grade',
    'migrate-claude-mem', 'migrate', 'otel', 'token', 'adr', 'map', 'commands',
  ],
};

// ---------------------------------------------------------------------------
// Shim-to-citty bridge: convert ShimCommand trees into citty subcommands
// ---------------------------------------------------------------------------

/**
 * Convert a ShimCommand (with possible sub-subcommands) into a citty
 * defineCommand() result.
 */
function shimToCitty(shim: ShimCommand): ReturnType<typeof defineCommand> {
  // Build citty args from shim options + positional args
  const cittyArgs: Record<string, {
    type: 'positional' | 'string' | 'boolean';
    description?: string;
    required?: boolean;
    alias?: string[];
    default?: unknown;
  }> = {};

  // Positional arguments
  for (const arg of shim._args) {
    cittyArgs[arg.name] = {
      type: 'positional',
      description: arg.name,
      required: arg.required,
    };
  }

  // Named options
  for (const opt of shim._options) {
    cittyArgs[opt.longName] = {
      type: opt.takesValue ? 'string' : 'boolean',
      description: opt.description,
      required: opt.required,
      ...(opt.shortName ? { alias: [opt.shortName] } : {}),
      ...(opt.defaultValue !== undefined ? { default: opt.defaultValue } : {}),
    };
  }

  // Sub-subcommands (e.g. session start, session stop, compliance summary)
  const subCommands: Record<string, ReturnType<typeof defineCommand>> = {};
  let defaultSub: ShimCommand | undefined;
  for (const sub of shim._subcommands) {
    subCommands[sub._name] = shimToCitty(sub);
    if (sub._isDefault) defaultSub = sub;
    // Register aliases as additional entries pointing to the same command
    for (const alias of sub._aliases) {
      subCommands[alias] = shimToCitty(sub);
    }
  }

  return defineCommand({
    meta: {
      name: shim._name,
      description: shim._description,
    },
    args: cittyArgs,
    ...(Object.keys(subCommands).length > 0 ? { subCommands } : {}),
    async run({ args }) {
      // Run pre-action hooks
      await runPreActionHooks(shim._name);

      // citty always runs the parent's run() even when a subcommand was matched.
      // Detect if a subcommand was selected by checking process.argv for subcommand names.
      if (Object.keys(subCommands).length > 0) {
        const subNames = new Set(Object.keys(subCommands));
        const argv = process.argv.slice(2);
        // Find the position of this command in argv, then check if next arg is a subcommand
        const cmdIdx = argv.indexOf(shim._name);
        const nextArg = cmdIdx >= 0 ? argv[cmdIdx + 1] : undefined;
        if (nextArg && subNames.has(nextArg)) {
          // A subcommand was matched — citty already ran it, skip parent run
          return;
        }
        // No subcommand matched — if there's a default, run it
        if (!shim._action && defaultSub?._action) {
          await defaultSub._action({}, defaultSub);
          return;
        }
      }

      if (shim._action) {
        // Reconstruct the Commander-style call signature:
        // Commander calls action(positionalArg1, positionalArg2, ..., optsObject)
        const positionalValues: unknown[] = [];
        for (const arg of shim._args) {
          positionalValues.push(args[arg.name]);
        }

        // Build opts object from named options (non-positional args)
        const opts: Record<string, unknown> = {};
        for (const opt of shim._options) {
          const val = args[opt.longName];
          if (val !== undefined && val !== false) {
            // Apply custom parse function if provided
            if (opt.parseFn && typeof val === 'string') {
              opts[opt.longName] = opt.parseFn(val);
            } else {
              opts[opt.longName] = val;
            }
          }
        }

        // Commander calls: action(pos1, pos2, ..., opts, command)
        // With 0 positional args: action(opts, command)
        // With 1 positional arg: action(pos1, opts, command)
        // The command instance is passed last for opts()/optsWithGlobals() compat.
        await shim._action(...positionalValues, opts, shim);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Collect all command registrations via the shim
// ---------------------------------------------------------------------------

const rootShim = new ShimCommand();

// Import all register functions. Each one calls rootShim.command() to register.
// The imports are static so they're tree-shakeable by esbuild.
import { registerAddCommand } from './commands/add.js';
import { registerAdrCommand } from './commands/adr.js';
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerArchiveCommand } from './commands/archive.js';
import { registerArchiveStatsCommand } from './commands/archive-stats.js';
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
import { registerDetectDriftCommand } from './commands/detect-drift.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEnvCommand } from './commands/env.js';
import { registerExistsCommand } from './commands/exists.js';
import { registerExportCommand } from './commands/export.js';
import { registerExportTasksCommand } from './commands/export-tasks.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerFindCommand } from './commands/find.js';
import { registerGenerateChangelogCommand } from './commands/generate-changelog.js';
import { registerGradeCommand } from './commands/grade.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerImplementationCommand } from './commands/implementation.js';
import { registerImportCommand } from './commands/import.js';
import { registerImportTasksCommand } from './commands/import-tasks.js';
import { registerInitCommand } from './commands/init.js';
import { registerInjectCommand } from './commands/inject.js';
import { registerInstallGlobalCommand } from './commands/install-global.js';
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
import { registerSyncCommand } from './commands/sync.js';
import { registerTestingCommand } from './commands/testing.js';
import { registerTokenCommand } from './commands/token.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerWebCommand } from './commands/web.js';

// Register all commands against the shim. Each function calls rootShim.command()
// which captures the definition without any real Commander.js dependency.
// The ShimCommand is type-compatible with Commander's Command interface for
// the subset of API that command files actually use.
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
registerExtractCommand(rootShim);
registerImportTasksCommand(rootShim);
registerSafestopCommand(rootShim);
registerSyncCommand(rootShim);
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
registerDetectDriftCommand(rootShim);
registerOpsCommand(rootShim);
registerSnapshotCommand(rootShim);
registerRemoteCommand(rootShim);
registerInstallGlobalCommand(rootShim);
registerGradeCommand(rootShim);
registerAdrCommand(rootShim);
registerMemoryBrainCommand(rootShim);
registerMigrateClaudeMemCommand(rootShim);
registerStickyCommand(rootShim);
registerRefreshMemoryCommand(rootShim);
registerObserveCommand(rootShim);

// ---------------------------------------------------------------------------
// Build citty subCommands from shim registrations
// ---------------------------------------------------------------------------

const subCommands: Record<string, ReturnType<typeof defineCommand>> = {};

// Add built-in 'version' command
subCommands['version'] = defineCommand({
  meta: { name: 'version', description: 'Display CLEO version' },
  async run() {
    await runPreActionHooks('version');
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  },
});

// Convert all shim-registered commands to citty commands
for (const shim of rootShim._subcommands) {
  subCommands[shim._name] = shimToCitty(shim);
  // Register aliases as additional top-level entries
  for (const alias of shim._aliases) {
    subCommands[alias] = shimToCitty(shim);
  }
}

// ---------------------------------------------------------------------------
// MCP server: `cleo mcp` — spawn the MCP server process
// ---------------------------------------------------------------------------

if (process.argv[2] === 'mcp') {
  const mcpPath = join(import.meta.dirname ?? '', '..', 'mcp', 'index.js');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', mcpPath], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // ---------------------------------------------------------------------------
  // Define and run the main citty command
  // ---------------------------------------------------------------------------

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
