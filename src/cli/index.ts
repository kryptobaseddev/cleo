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
  .version(CLI_VERSION);

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

program.parse();
