/**
 * CLEO V2 CLI entry point.
 * @epic T4454
 * @task T4455
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAddCommand } from './commands/add.js';
import { registerListCommand } from './commands/list.js';
import { registerShowCommand } from './commands/show.js';
import { registerFindCommand } from './commands/find.js';
import { registerCompleteCommand } from './commands/complete.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerArchiveCommand } from './commands/archive.js';
import { registerFocusCommand } from './commands/focus.js';
import { registerStartCommand } from './commands/start.js';
import { registerStopCommand } from './commands/stop.js';
import { registerCurrentCommand } from './commands/current.js';
import { registerBriefingCommand } from './commands/briefing.js';
import { registerSessionCommand } from './commands/session.js';
import { registerPhaseCommand } from './commands/phase.js';
import { registerDepsCommand, registerTreeCommand } from './commands/deps.js';
import { registerResearchCommand } from './commands/research.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerLifecycleCommand } from './commands/lifecycle.js';
import { registerReleaseCommand } from './commands/release.js';
import { registerEnvCommand } from './commands/env.js';
import { registerMcpInstallCommand } from './commands/mcp-install.js';

// Wave 1: Ported scripts (T4551)
import { registerCheckpointCommand } from './commands/checkpoint.js';
import { registerCommandsCommand } from './commands/commands.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerExportTasksCommand } from './commands/export-tasks.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerImportTasksCommand } from './commands/import-tasks.js';
import { registerSafestopCommand } from './commands/safestop.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerTestingCommand } from './commands/testing.js';
import { registerWebCommand } from './commands/web.js';
import { registerNexusCommand } from './commands/nexus.js';

// Wave 1: Partial port fixes (T4555)
import { registerArchiveStatsCommand } from './commands/archive-stats.js';
import { registerGenerateChangelogCommand } from './commands/generate-changelog.js';
import { registerIssueCommand } from './commands/issue.js';
import { registerSkillsCommand } from './commands/skills.js';

// Wave 1: Utility commands
import { registerExistsCommand } from './commands/exists.js';
import { registerBugCommand } from './commands/bug.js';

// Wave 3: Register remaining commands (T4585)
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerBackupCommand } from './commands/backup.js';
import { registerBlockersCommand } from './commands/blockers.js';
import { registerComplianceCommand } from './commands/compliance.js';
import { registerConfigCommand } from './commands/config.js';
import { registerConsensusCommand } from './commands/consensus.js';
import { registerContextCommand } from './commands/context.js';
import { registerContributionCommand } from './commands/contribution.js';
import { registerDashCommand } from './commands/dash.js';
import { registerDecompositionCommand } from './commands/decomposition.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerExportCommand } from './commands/export.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerImplementationCommand } from './commands/implementation.js';
import { registerImportCommand } from './commands/import.js';
import { registerInitCommand } from './commands/init.js';
import { registerInjectCommand } from './commands/inject.js';
import { registerLabelsCommand } from './commands/labels.js';
import { registerLogCommand } from './commands/log.js';
import { registerNextCommand } from './commands/next.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerOtelCommand } from './commands/otel.js';
import { registerPhasesCommand } from './commands/phases.js';
import { registerPromoteCommand } from './commands/promote.js';
import { registerRelatesCommand } from './commands/relates.js';
import { registerReorderCommand } from './commands/reorder.js';
import { registerReparentCommand } from './commands/reparent.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
import { registerSelfUpdateCommand } from './commands/self-update.js';
import { registerSequenceCommand } from './commands/sequence.js';
import { registerSpecificationCommand } from './commands/specification.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerDetectDriftCommand } from './commands/detect-drift.js';

// T4362: Progressive disclosure ops command
import { registerOpsCommand } from './commands/ops.js';

// T4882: Multi-contributor snapshot
import { registerSnapshotCommand } from './commands/snapshot.js';

// T4883: Config-driven sharing allowlist
import { registerSharingCommand } from './commands/sharing.js';

// T4884: .cleo/.git remote push/pull
import { registerRemoteCommand } from './commands/remote.js';

// T4916: CAAMP global install refresh + session behavioral grading
import { registerInstallGlobalCommand } from './commands/install-global.js';
import { registerGradeCommand } from './commands/grade.js';

// ADR-017: ADR validation, listing, and sync
import { registerAdrCommand } from './commands/adr.js';

// T4770: BRAIN memory commands (patterns, learnings)
import { registerMemoryBrainCommand } from './commands/memory-brain.js';

// Core: pre-flight migration check (@task T4699)
import { checkStorageMigration } from '../core/migration/preflight.js';

// T4665: Output format resolution (LAFS middleware)
import { resolveFormat } from './middleware/output-format.js';
import { setFormatContext } from './format-context.js';

// T4953: Universal field extraction context
import { resolveFieldContext, setFieldContext } from './field-context.js';

// Centralized pino logger
import { initLogger } from '../core/logger.js';
import { loadConfig as loadCoreConfig } from '../core/config.js';

// Startup guard: fail fast if Node.js version is below minimum
import { getNodeVersionInfo, getNodeUpgradeInstructions, MINIMUM_NODE_MAJOR } from '../core/platform.js';

const nodeInfo = getNodeVersionInfo();
if (!nodeInfo.meetsMinimum) {
  const upgrade = getNodeUpgradeInstructions();
  process.stderr.write(
    `\nError: CLEO requires Node.js v${MINIMUM_NODE_MAJOR}+ but found v${nodeInfo.version}\n`
    + `\nUpgrade options:\n`
    + upgrade.instructions.map(i => `  - ${i}`).join('\n')
    + `\n\n`,
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
const program = new Command();

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

// T4462: Focus commands (backward-compat aliases)
registerFocusCommand(program);

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

// T4883: Config-driven sharing allowlist
registerSharingCommand(program);

// T4884: .cleo/.git remote push/pull
registerRemoteCommand(program);

// T4916: CAAMP global install refresh + session behavioral grading
registerInstallGlobalCommand(program);
registerGradeCommand(program);

// ADR-017: ADR validation, listing, and sync
registerAdrCommand(program);

// T4770: BRAIN memory commands
registerMemoryBrainCommand(program);

// Initialize centralized pino logger before any command runs.
// Best-effort: if config loading fails, commands still work (logger falls back to stderr).
let loggerInitialized = false;
program.hook('preAction', async () => {
  if (loggerInitialized) return;
  loggerInitialized = true;
  try {
    const config = await loadCoreConfig();
    initLogger(join(process.cwd(), '.cleo'), config.logging);
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
        `\n⚠ Storage migration needed: ${result.summary}\n`
        + `  Fix: ${result.fix}\n\n`,
      );
    }
  } catch {
    // Never block CLI operation due to preflight failure
  }
});

// Handle --mcp-server flag: start MCP stdio server instead of CLI (W5)
// Must check argv before Commander.js parses to support: npx @cleocode/cleo --mcp-server
if (process.argv.includes('--mcp-server')) {
  import('../mcp/index.js').then((m: Record<string, unknown>) => {
    const fn = (m['main'] ?? m['startMcpServer']) as (() => void) | undefined;
    if (typeof fn === 'function') fn();
  }).catch((err: unknown) => {
    process.stderr.write(`Failed to start MCP server: ${err}\n`);
    process.exit(1);
  });
} else {
  program.parse();
}
