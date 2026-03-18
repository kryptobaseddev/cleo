/**
 * CLI skills command - skill management: list, discover, validate, info, install.
 *
 * @task T4555
 * @epic T4545
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the skills command with all subcommands.
 * @task T4555
 */
export function registerSkillsCommand(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Skill management: list, discover, validate, info, install');

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

  // Subcommand: discover
  skillsCmd
    .command('discover')
    .description('Scan and discover available skills')
    .action(async () => {
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

  // Subcommand: enable
  skillsCmd
    .command('enable <skill-name>')
    .description('Enable a skill')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.enable',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.enable' },
      );
    });

  // Subcommand: disable
  skillsCmd
    .command('disable <skill-name>')
    .description('Disable a skill')
    .action(async (skillName: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.disable',
        {
          name: skillName,
        },
        { command: 'skills', operation: 'tools.skill.disable' },
      );
    });

  // Subcommand: configure
  skillsCmd
    .command('configure <skill-name>')
    .description('Configure a skill')
    .option('--set <key=value>', 'Set configuration value')
    .action(async (skillName: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'skill.configure',
        {
          name: skillName,
          config: opts['set'],
        },
        { command: 'skills', operation: 'tools.skill.configure' },
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
