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
import { registerSessionCommand } from './commands/session.js';
import { registerPhaseCommand } from './commands/phase.js';
import { registerDepsCommand, registerTreeCommand } from './commands/deps.js';
import { registerResearchCommand } from './commands/research.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerLifecycleCommand } from './commands/lifecycle.js';
import { registerReleaseCommand } from './commands/release.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerEnvCommand } from './commands/env.js';
import { registerMcpInstallCommand } from './commands/mcp-install.js';

// Wave 1: Ported scripts (T4551)
import { registerCheckpointCommand } from './commands/checkpoint.js';
import { registerClaudeMigrateCommand } from './commands/claude-migrate.js';
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
import { registerOtelCommand } from './commands/otel.js';
import { registerPhasesCommand } from './commands/phases.js';
import { registerPromoteCommand } from './commands/promote.js';
import { registerRelatesCommand } from './commands/relates.js';
import { registerReopenCommand } from './commands/reopen.js';
import { registerReorderCommand } from './commands/reorder.js';
import { registerReparentCommand } from './commands/reparent.js';
import { registerRestoreCommand } from './commands/restore.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
import { registerSelfUpdateCommand } from './commands/self-update.js';
import { registerSequenceCommand } from './commands/sequence.js';
import { registerSpecificationCommand } from './commands/specification.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerUnarchiveCommand } from './commands/unarchive.js';
import { registerUncancelCommand } from './commands/uncancel.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerVerifyCommand } from './commands/verify.js';

// Wave 5: Storage migration (T4647, T4648)
import { registerMigrateStorageCommand } from './commands/migrate-storage.js';

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
  .option('--json', 'Output in JSON format (default, accepted for compatibility)');

program
  .command('version')
  .description('Display CLEO version')
  .action(() => {
    console.log(JSON.stringify({
      success: true,
      data: { version: CLI_VERSION },
    }));
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

// T4462: Focus commands
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

// T4468: Migration commands
registerMigrateCommand(program);

// T4581: Environment command
registerEnvCommand(program);

// T4584: MCP install command
registerMcpInstallCommand(program);

// T4551: Wave 1 - Ported scripts
registerCheckpointCommand(program);
registerClaudeMigrateCommand(program);
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
registerOtelCommand(program);
registerPhasesCommand(program);
registerPromoteCommand(program);
registerRelatesCommand(program);
registerReopenCommand(program);
registerReorderCommand(program);
registerReparentCommand(program);
registerRestoreCommand(program);
registerRoadmapCommand(program);
registerSelfUpdateCommand(program);
registerSequenceCommand(program);
registerSpecificationCommand(program);
registerStatsCommand(program);
registerUnarchiveCommand(program);
registerUncancelCommand(program);
registerUpgradeCommand(program);
registerValidateCommand(program);
registerVerifyCommand(program);

// T4647, T4648: Storage migration
registerMigrateStorageCommand(program);

program.parse();
