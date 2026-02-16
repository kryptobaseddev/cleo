/**
 * CLI commands command - list and query available CLEO commands.
 * Ported from scripts/commands.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoHome } from '../../core/paths.js';
import { readJson } from '../../store/json.js';

/** Command index entry from COMMANDS-INDEX.json. */
interface CommandEntry {
  name: string;
  script: string;
  category: string;
  agentRelevance: string;
  synopsis: string;
  flags: string[];
  exitCodes: number[];
  doc?: string;
  subcommands?: string[];
  aliases?: string[];
  note?: string;
}

/** Full command index structure. */
interface CommandIndex {
  commands: CommandEntry[];
  agentWorkflows?: Record<string, string[]>;
  quickLookup?: Record<string, string>;
}

/** Valid category values. */
const VALID_CATEGORIES = ['write', 'read', 'sync', 'maintenance'];

/** Valid relevance levels. */
const VALID_RELEVANCE = ['critical', 'high', 'medium', 'low'];

/**
 * Locate COMMANDS-INDEX.json from known locations.
 * @task T4551
 */
async function locateCommandsIndex(): Promise<CommandIndex> {
  const cleoHome = getCleoHome();
  const paths = [
    join(cleoHome, 'docs', 'commands', 'COMMANDS-INDEX.json'),
    join(process.cwd(), 'docs', 'commands', 'COMMANDS-INDEX.json'),
  ];

  for (const p of paths) {
    const data = await readJson<CommandIndex>(p);
    if (data) return data;
  }

  throw new CleoError(ExitCode.FILE_ERROR, 'COMMANDS-INDEX.json not found', {
    fix: 'Reinstall cleo or check CLEO_HOME',
  });
}

/**
 * Register the commands command.
 * @task T4551
 */
export function registerCommandsCommand(program: Command): void {
  program
    .command('commands [command]')
    .description('List and query available CLEO commands')
    .option('-c, --category <category>', 'Filter by category (write|read|sync|maintenance)')
    .option('-r, --relevance <level>', 'Filter by agent relevance (critical|high|medium|low)')
    .option('--workflows', 'Show agent workflow sequences')
    .option('--lookup', 'Show intent-to-command quick lookup')
    .action(async (commandName: string | undefined, opts: Record<string, unknown>) => {
      try {
        const category = opts['category'] as string | undefined;
        const relevance = opts['relevance'] as string | undefined;

        // Validate category
        if (category && !VALID_CATEGORIES.includes(category)) {
          throw new CleoError(
            ExitCode.INVALID_INPUT,
            `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(', ')}`,
          );
        }

        // Validate relevance
        if (relevance && !VALID_RELEVANCE.includes(relevance)) {
          throw new CleoError(
            ExitCode.INVALID_INPUT,
            `Invalid relevance: ${relevance}. Valid: ${VALID_RELEVANCE.join(', ')}`,
          );
        }

        const index = await locateCommandsIndex();

        // Handle workflows
        if (opts['workflows']) {
          console.log(formatSuccess({ workflows: index.agentWorkflows ?? {} }));
          return;
        }

        // Handle lookup
        if (opts['lookup']) {
          console.log(formatSuccess({ quickLookup: index.quickLookup ?? {} }));
          return;
        }

        // Filter commands
        let commands = index.commands;

        if (category) {
          commands = commands.filter((c) => c.category === category);
        }
        if (relevance) {
          commands = commands.filter((c) => c.agentRelevance === relevance);
        }
        if (commandName) {
          commands = commands.filter((c) => c.name === commandName);
          if (commands.length === 0) {
            throw new CleoError(ExitCode.NOT_FOUND, `Command not found: ${commandName}`, {
              fix: "Run 'cleo commands' to see available commands",
            });
          }
          // Single command detail
          console.log(formatSuccess({ command: commands[0] }));
          return;
        }

        // List commands
        console.log(formatSuccess({
          summary: {
            totalCommands: commands.length,
            categoryFilter: category ?? 'all',
            relevanceFilter: relevance ?? 'all',
          },
          commands,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
