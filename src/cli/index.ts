/**
 * CLEO V2 CLI entry point.
 * @epic T4454
 * @task T4455
 */

import { Command, Help, type Option } from 'commander';

/**
 * Custom Help class that groups commands by domain.
 * Organizes commands into logical domains for better UX.
 */
class GroupedHelp extends Help {
  // Domain to command names mapping - organized by functional domain
  private domainGroups: Record<string, string[]> = {
    Tasks: [
      'add',
      'list',
      'show',
      'find',
      'complete',
      'update',
      'delete',
      'archive',
      'start',
      'stop',
      'current',
      'next',
      'archive-stats',
      'restore',
      'reorder',
      'reparent',
      'relates',
      'tree',
      'deps',
      'labels',
      'tags',
      'blockers',
      'exists',
      'stats',
      'history',
    ],
    Session: ['session', 'briefing', 'phase', 'checkpoint', 'safestop'],
    Memory: ['memory', 'memory-brain', 'observe', 'context', 'inject', 'sync', 'sticky', 'note'],
    Check: ['validate', 'verify', 'compliance', 'doctor', 'analyze'],
    Pipeline: [
      'release',
      'lifecycle',
      'promote',
      'upgrade',
      'specification',
      'detect-drift',
      'roadmap',
      'plan',
      'log',
      'issue',
      'bug',
      'generate-changelog',
      'phases',
    ],
    Orchestration: [
      'orchestrate',
      'ops',
      'consensus',
      'contribution',
      'decomposition',
      'implementation',
      'sequence',
      'dash',
    ],
    Research: ['research', 'extract', 'web', 'docs'],
    Nexus: ['nexus', 'init', 'remote', 'push', 'pull', 'snapshot', 'export', 'import'],
    Admin: [
      'config',
      'backup',
      'export-tasks',
      'import-tasks',
      'env',
      'mcp-install',
      'testing',
      'skills',
      'self-update',
      'install-global',
      'grade',
      'migrate-claude-mem',
      'migrate',
      'otel',
      'token',
      'adr',
      'commands',
    ],
  };

  /** Override formatHelp to group commands by domain. */
  formatHelp(cmd: Command, helper: Help): string {
    const output: string[] = [];

    // Header: name and version
    const version = cmd.version();
    if (version) {
      output.push(`${cmd.name()}@${version}`);
    } else {
      output.push(cmd.name());
    }

    // Description
    const description = this.commandDescription(cmd);
    if (description) {
      output.push(description);
    }

    // Usage
    const usage = this.commandUsage(cmd);
    if (usage) {
      output.push(`Usage: ${usage}`);
    }

    // Global options
    const globalOpts = this.visibleGlobalOptions(cmd);
    if (globalOpts.length > 0) {
      output.push(this.formatOptionsBlock('Global Options:', globalOpts, helper, cmd));
    }

    // Commands grouped by domain
    const domainSection = this.formatCommandsByDomain(cmd, helper);
    if (domainSection) {
      output.push(domainSection);
    }

    // Options for current command
    const opts = this.visibleOptions(cmd);
    if (opts.length > 0) {
      output.push(this.formatOptionsBlock('Options:', opts, helper, cmd));
    }

    // Arguments
    const args = this.visibleArguments(cmd);
    if (args.length > 0) {
      output.push(this.formatArgumentsBlock(args, helper, cmd));
    }

    return output.filter(Boolean).join('\n\n');
  }

  /** Format options as a block. */
  private formatOptionsBlock(title: string, options: Option[], helper: Help, cmd: Command): string {
    const lines: string[] = [title];
    const width = this.longestOptionTermLength(cmd, helper);

    for (const option of options) {
      const term = helper.optionTerm(option);
      const desc = helper.optionDescription(option);
      lines.push(`  ${term.padEnd(width)}  ${desc}`);
    }

    return lines.join('\n');
  }

  /** Format arguments as a block. */
  private formatArgumentsBlock(
    args: import('commander').Argument[],
    helper: Help,
    cmd: Command,
  ): string {
    const lines: string[] = ['Arguments:'];
    const width = this.longestArgumentTermLength(cmd, helper);

    for (const arg of args) {
      const term = helper.argumentTerm(arg);
      const desc = helper.argumentDescription(arg);
      lines.push(`  ${term.padEnd(width)}  ${desc}`);
    }

    return lines.join('\n');
  }

  /** Format commands grouped by domain. */
  private formatCommandsByDomain(cmd: Command, helper: Help): string {
    const commands = this.visibleCommands(cmd);
    if (commands.length === 0) return '';

    // Group commands by domain
    const grouped: Record<string, Command[]> = {};
    const ungrouped: Command[] = [];

    for (const command of commands) {
      const name = command.name();
      let found = false;
      for (const [domain, names] of Object.entries(this.domainGroups)) {
        if (names.includes(name)) {
          if (!grouped[domain]) grouped[domain] = [];
          grouped[domain].push(command);
          found = true;
          break;
        }
      }
      if (!found) ungrouped.push(command);
    }

    const lines: string[] = [];
    lines.push('Commands:');

    // Print grouped commands
    for (const [domain, cmds] of Object.entries(grouped)) {
      lines.push(`\n  ${domain}:`);
      for (const c of cmds.sort((a, b) => a.name().localeCompare(b.name()))) {
        const term = helper.subcommandTerm(c);
        const desc = helper.subcommandDescription(c);
        lines.push(`    ${term.padEnd(22)} ${desc}`);
      }
    }

    // Print ungrouped commands
    if (ungrouped.length > 0) {
      lines.push('\n  Other:');
      for (const c of ungrouped.sort((a, b) => a.name().localeCompare(b.name()))) {
        const term = helper.subcommandTerm(c);
        const desc = helper.subcommandDescription(c);
        lines.push(`    ${term.padEnd(22)} ${desc}`);
      }
    }

    return lines.join('\n');
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Centralized pino logger
import { loadConfig as loadCoreConfig } from '../core/config.js';
// Startup guard: fail fast if Node.js version is below minimum
import {
  getNodeUpgradeInstructions,
  getNodeVersionInfo,
  MINIMUM_NODE_MAJOR,
} from '../core/platform.js';
// Core: pre-flight migration check (@task T4699)
import { checkStorageMigration } from '../core/system/storage-preflight.js';
import { registerAddCommand } from './commands/add.js';
// ADR-017: ADR validation, listing, and sync
import { registerAdrCommand } from './commands/adr.js';
// Wave 3: Register remaining commands (T4585)
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerArchiveCommand } from './commands/archive.js';
// Wave 1: Partial port fixes (T4555)
import { registerArchiveStatsCommand } from './commands/archive-stats.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerBlockersCommand } from './commands/blockers.js';
import { registerBriefingCommand } from './commands/briefing.js';
import { registerBugCommand } from './commands/bug.js';
// Wave 1: Ported scripts (T4551)
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
// Wave 1: Utility commands
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
// T4916: CAAMP global install refresh + session behavioral grading
import { registerInstallGlobalCommand } from './commands/install-global.js';
import { registerIssueCommand } from './commands/issue.js';
import { registerLabelsCommand } from './commands/labels.js';
import { registerLifecycleCommand } from './commands/lifecycle.js';
import { registerListCommand } from './commands/list.js';
import { registerLogCommand } from './commands/log.js';
import { registerMcpInstallCommand } from './commands/mcp-install.js';
// T4770: BRAIN memory commands (patterns, learnings)
import { registerMemoryBrainCommand } from './commands/memory-brain.js';
// T5143: Claude-mem to brain.db migration
import { registerMigrateClaudeMemCommand } from './commands/migrate-claude-mem.js';
import { registerNextCommand } from './commands/next.js';
import { registerNexusCommand } from './commands/nexus.js';
// T4362: Progressive disclosure ops command
import { registerOpsCommand } from './commands/ops.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerOtelCommand } from './commands/otel.js';
import { registerPhaseCommand } from './commands/phase.js';
import { registerPhasesCommand } from './commands/phases.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerPromoteCommand } from './commands/promote.js';
import { registerRelatesCommand } from './commands/relates.js';
import { registerReleaseCommand } from './commands/release.js';
// T4884: .cleo/.git remote push/pull
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
// T4882: Multi-contributor snapshot
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerSpecificationCommand } from './commands/specification.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatsCommand } from './commands/stats.js';
// T5281: Sticky notes command
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

// T4953: Universal field extraction context
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { initCliLogger } from './logger-bootstrap.js';
// T4665: Output format resolution (LAFS middleware)
import { resolveFormat } from './middleware/output-format.js';

const nodeInfo = getNodeVersionInfo();
if (!nodeInfo.meetsMinimum) {
  const upgrade = getNodeUpgradeInstructions();
  process.stderr.write(
    `\nError: CLEO requires Node.js v${MINIMUM_NODE_MAJOR}+ but found v${nodeInfo.version}\n` +
      `\nUpgrade options:\n` +
      upgrade.instructions.map((i) => `  - ${i}`).join('\n') +
      `\n\n`,
  );
  process.exit(1);
}

/** Read version from package.json (single source of truth). */
function getPackageVersion(): string {
  try {
    // Resolve from module location: dist/cli/index.js -> project root
    const moduleRoot = join(import.meta.dirname ?? '', '..', '..');
    const pkg = JSON.parse(readFileSync(join(moduleRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const CLI_VERSION = getPackageVersion();

// Custom Command class that uses GroupedHelp
class CleoCommand extends Command {
  createHelp() {
    return new GroupedHelp();
  }
}

const program = new CleoCommand();

program
  .name('cleo')
  .description('CLEO V2 - Task management for AI coding agents')
  .version(CLI_VERSION)
  .option('--json', 'Output in JSON format (default)')
  .option('--human', 'Output in human-readable format')
  .option('--quiet', 'Suppress non-essential output for scripting')
  // T4953: Universal field extraction — applies to all commands
  .option('--field <name>', 'Extract single field as plain text (no JSON envelope)')
  .option('--fields <names>', 'Filter to comma-separated fields (keeps JSON envelope)')
  .option('--mvi <level>', 'Envelope verbosity: minimal|standard|full');

program
  .command('version')
  .description('Display CLEO version')
  .action(async () => {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  });

// T4460: Core CRUD commands
registerAddCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerFindCommand(program);

// T4461: Mutation commands
registerCompleteCommand(program);
registerUpdateCommand(program);
registerDeleteCommand(program);
registerArchiveCommand(program);

// T4756: Task work commands (start/stop/current replace focus)
registerStartCommand(program);
registerStopCommand(program);
registerCurrentCommand(program);

// T4916: Session briefing command
registerBriefingCommand(program);

// T4463: Session commands
registerSessionCommand(program);

// T4464: Phase and dependency commands
registerPhaseCommand(program);
registerDepsCommand(program);
registerTreeCommand(program);

// T4465: Research and manifest commands
registerResearchCommand(program);

// T4466: Orchestration commands
registerOrchestrateCommand(program);

// T4467: Lifecycle and release commands
registerLifecycleCommand(program);
registerReleaseCommand(program);

// T4581: Environment command
registerEnvCommand(program);

// T4584: MCP install command
registerMcpInstallCommand(program);

// T4551: Wave 1 - Ported scripts
registerCheckpointCommand(program);
registerCommandsCommand(program);
registerDocsCommand(program);
registerExportTasksCommand(program);
registerExtractCommand(program);
registerImportTasksCommand(program);
registerSafestopCommand(program);
registerSyncCommand(program);
registerTestingCommand(program);
registerWebCommand(program);
registerNexusCommand(program);

// T4555: Wave 1 - Partial port fixes
registerArchiveStatsCommand(program);
registerGenerateChangelogCommand(program);
registerIssueCommand(program);
registerSkillsCommand(program);

// T4454: Utility commands
registerExistsCommand(program);

// T4913: Bug report command
registerBugCommand(program);

// T4585: Wave 3 - Remaining commands
registerAnalyzeCommand(program);
registerBackupCommand(program);
registerBlockersCommand(program);
registerComplianceCommand(program);
registerConfigCommand(program);
registerConsensusCommand(program);
registerContextCommand(program);
registerContributionCommand(program);
registerDashCommand(program);
registerDecompositionCommand(program);
registerDoctorCommand(program);
registerExportCommand(program);
registerHistoryCommand(program);
registerImplementationCommand(program);
registerImportCommand(program);
registerInitCommand(program);
registerInjectCommand(program);
registerLabelsCommand(program);
registerLogCommand(program);
registerNextCommand(program);
registerPlanCommand(program);
registerOtelCommand(program);
registerTokenCommand(program);
registerPhasesCommand(program);
registerPromoteCommand(program);
registerRelatesCommand(program);
registerReorderCommand(program);
registerReparentCommand(program);
registerRestoreCommand(program);
registerRoadmapCommand(program);
registerSelfUpdateCommand(program);
registerSequenceCommand(program);
registerSpecificationCommand(program);
registerStatsCommand(program);
registerUpgradeCommand(program);
registerValidateCommand(program);
registerVerifyCommand(program);

// T4705: Documentation drift detection
registerDetectDriftCommand(program);

// T4362: Progressive disclosure ops command
registerOpsCommand(program);

// T4882: Multi-contributor snapshot export/import
registerSnapshotCommand(program);

// T4884: .cleo/.git remote push/pull
registerRemoteCommand(program);

// T4916: CAAMP global install refresh + session behavioral grading
registerInstallGlobalCommand(program);
registerGradeCommand(program);

// ADR-017: ADR validation, listing, and sync
registerAdrCommand(program);

// T4770: BRAIN memory commands
registerMemoryBrainCommand(program);

// T5143: Claude-mem to brain.db migration
registerMigrateClaudeMemCommand(program);

// T5281: Sticky notes command
registerStickyCommand(program);

// Initialize centralized pino logger before any command runs.
// Best-effort: if config loading fails, commands still work (logger falls back to stderr).
let loggerInitialized = false;
program.hook('preAction', async () => {
  if (loggerInitialized) return;
  loggerInitialized = true;
  try {
    const config = await loadCoreConfig();
    initCliLogger(process.cwd(), config.logging);

    // Fire-and-forget audit log pruning (T5339, ADR-024 section 2.3)
    const { pruneAuditLog } = await import('../core/audit-prune.js');
    pruneAuditLog(join(process.cwd(), '.cleo'), config.logging).catch(() => {
      /* non-blocking */
    });
  } catch {
    // Logger init is best-effort — fallback stderr logger will be used
  }
});

// T4665: Resolve output format from --json/--human/--quiet flags before any command.
// Uses LAFS resolveOutputFormat() with TTY auto-detection fallback.
// Sets the format context singleton so cliOutput() can dispatch accordingly.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals?.() ?? thisCommand.opts?.() ?? {};
  try {
    const resolution = resolveFormat(opts);
    setFormatContext(resolution);
  } catch {
    // Fallback: leave default (json) format if resolution fails
  }
  // T4953: Field extraction context — let LAFSFlagError surface (e.g. --field + --fields conflict)
  try {
    setFieldContext(resolveFieldContext(opts));
  } catch (err) {
    const e = err as { message?: string; code?: string };
    process.stderr.write(`Error: ${e.message ?? String(err)}\n`);
    process.exit(2);
  }
});

// Pre-flight migration check: warn if JSON data needs SQLite migration (@task T4699)
// Runs before any command, emits to stderr so JSON output on stdout is not affected.
// Skipped for commands that don't need data (version, init, upgrade itself).
const SKIP_PREFLIGHT = new Set(['version', 'init', 'self-update', 'upgrade', 'help']);
program.hook('preAction', (thisCommand) => {
  const cmdName = thisCommand.args?.[0] ?? thisCommand.name();
  if (SKIP_PREFLIGHT.has(cmdName)) return;
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
});

// Start MCP server: `cleo mcp` (canonical invocation for all AI agents).
// Agent configs use: npx -y @cleocode/cleo@latest mcp
// Spawns dist/mcp/index.js with inherited stdio for MCP protocol (stdin/stdout JSON-RPC).
// Checked before Commander.js parses to avoid "unknown command" errors.
if (process.argv[2] === 'mcp') {
  const mcpPath = join(import.meta.dirname ?? '', '..', 'mcp', 'index.js');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', mcpPath], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  program.parse();
}
