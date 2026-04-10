/**
 * CLI skills command - skill management: list, search, validate, info, install.
 *
 * @task T4555
 * @epic T4545
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the skills command with all subcommands.
 * @task T4555
 */
export function registerSkillsCommand(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Skill management: list, search, validate, info, install');

  // Subcommand: list
  skillsCmd
    .command('list')
    .description('List installed skills')
    .option('--global', 'Use global skills directory')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.list',
        {
          scope: opts['global'] ? 'global' : 'project',
        },
        { command: 'skills', operation: 'tools.skill.list' },
      );
    });

  // Subcommand: search / find
  skillsCmd
    .command('search <query>')
    .description('Search for skills')
    .option('--mp', 'Search marketplace (agentskills.in)')
    .option('--all', 'Search both local and marketplace')
    .action(async (query: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.find',
        {
          query,
          source: opts['mp'] ? 'skillsmp' : opts['all'] ? 'all' : 'local',
        },
        { command: 'skills', operation: 'tools.skill.find' },
      );
    });

  // Subcommand: validate
  skillsCmd
    .command('validate <skill-name>')
    .description('Validate skill against protocol')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.verify',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.verify' },
      );
    });

  // Subcommand: info
  skillsCmd
    .command('info <skill-name>')
    .description('Show skill details')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.show',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.show' },
      );
    });

  // Subcommand: install
  skillsCmd
    .command('install <skill-name>')
    .description('Install skill to agent directory')
    .option('--global', 'Install globally')
    .action(async (skillName: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.install',
        {
          name: skillName,
          global: !!opts['global'],
        },
        { command: 'skills', operation: 'tools.skill.install' },
      );
    });

  // Subcommand: uninstall
  skillsCmd
    .command('uninstall <skill-name>')
    .description('Uninstall a skill')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.uninstall',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.uninstall' },
      );
    });

  // Subcommand: enable (alias for install — skill.enable was removed in T5615)
  skillsCmd
    .command('enable <skill-name>')
    .description('Enable a skill (alias for install)')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.install',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.install' },
      );
    });

  // Subcommand: disable (alias for uninstall — skill.disable was removed in T5615)
  skillsCmd
    .command('disable <skill-name>')
    .description('Disable a skill (alias for uninstall)')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.uninstall',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.uninstall' },
      );
    });

  // Subcommand: refresh
  skillsCmd
    .command('refresh')
    .description('Refresh skills cache')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.refresh',
        {},
        {
          command: 'skills',
          operation: 'tools.skill.refresh',
        },
      );
    });

  // Subcommand: dispatch
  skillsCmd
    .command('dispatch <skill-name>')
    .description('Resolve dispatch path for a skill')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.dispatch',
        { name: skillName },
        { command: 'skills', operation: 'tools.skill.dispatch' },
      );
    });

  // Subcommand: catalog
  skillsCmd
    .command('catalog')
    .description('Browse CAAMP skill catalog (protocols, profiles, resources, info)')
    .option('--type <type>', 'Catalog type: protocols, profiles, resources, info (default: info)')
    .option('--limit <n>', 'Maximum items to return')
    .option('--offset <n>', 'Offset for pagination')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.catalog',
        {
          type: opts['type'] ?? 'info',
          limit: opts['limit'] ? Number(opts['limit']) : undefined,
          offset: opts['offset'] ? Number(opts['offset']) : undefined,
        },
        { command: 'skills', operation: 'tools.skill.catalog' },
      );
    });

  // Subcommand: precedence
  skillsCmd
    .command('precedence')
    .description('Show or resolve skill provider precedence')
    .option('--resolve <provider-id>', 'Resolve precedence for a specific provider')
    .option('--scope <scope>', 'Scope: global or project (default: global)')
    .action(async (opts: Record<string, unknown>) => {
      const providerId = opts['resolve'] as string | undefined;
      await dispatchFromCli(
        'query',
        'tools',
        'skill.precedence',
        {
          action: providerId ? 'resolve' : 'show',
          providerId,
          scope: opts['scope'] ?? 'global',
        },
        { command: 'skills', operation: 'tools.skill.precedence' },
      );
    });

  // Subcommand: dependencies
  skillsCmd
    .command('deps <skill-name>')
    .description('Show skill dependency tree')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.dependencies',
        { name: skillName },
        { command: 'skills', operation: 'tools.skill.dependencies' },
      );
    });

  // Subcommand: spawn-providers
  skillsCmd
    .command('spawn-providers')
    .description('List providers capable of spawning subagents')
    .option(
      '--capability <cap>',
      'Filter by capability: supportsSubagents, supportsProgrammaticSpawn, supportsInterAgentComms, supportsParallelSpawn',
    )
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'skill.spawn.providers',
        { capability: opts['capability'] },
        { command: 'skills', operation: 'tools.skill.spawn.providers' },
      );
    });

  // Default action (no subcommand) - list
  skillsCmd.action(async () => {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.list',
      {
        scope: 'project',
      },
      { command: 'skills', operation: 'tools.skill.list' },
    );
  });
}
