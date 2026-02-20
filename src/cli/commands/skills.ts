/**
 * CLI skills command - skill management: list, discover, validate, info, install.
 *
 * @task T4555
 * @epic T4545
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import {
  discoverAllSkills,
  findSkill,
  validateSkill,
  installSkill,
  searchSkills as mpSearchSkills,
  toSkillSummary,
} from '../../core/skills/index.js';
import type { SkillSummary } from '../../core/skills/index.js';

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
      try {
        const skills = await discoverAllSkills();
        const summaries: SkillSummary[] = skills.map(toSkillSummary);

        cliOutput({
          scope: opts['global'] ? 'global' : 'project',
          count: summaries.length,
          skills: summaries,
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Subcommand: search
  skillsCmd
    .command('search <query>')
    .description('Search for skills')
    .option('--mp', 'Search marketplace (agentskills.in)')
    .option('--all', 'Search both local and marketplace')
    .action(async (query: string, opts: Record<string, unknown>) => {
      try {
        const localResults: SkillSummary[] = [];
        let mpResults: Array<Record<string, unknown>> = [];

        // Search local skills
        if (!opts['mp']) {
          const allSkills = await discoverAllSkills();
          const lowerQuery = query.toLowerCase();
          const matches = allSkills.filter(s =>
            s.name.toLowerCase().includes(lowerQuery) ||
            s.frontmatter.description.toLowerCase().includes(lowerQuery),
          );
          localResults.push(...matches.map(toSkillSummary));
        }

        // Search marketplace
        if (opts['mp'] || opts['all']) {
          try {
            const results = await mpSearchSkills(query);
            mpResults = results.map(r => ({
              name: r.name,
              description: r.description,
              version: r.version,
              author: r.author,
              source: 'skillsmp',
            }));
          } catch {
            // Marketplace search failure is non-fatal
          }
        }

        cliOutput({
          query,
          source: opts['mp'] ? 'skillsmp' : opts['all'] ? 'all' : 'local',
          counts: {
            local: localResults.length,
            skillsmp: mpResults.length,
            total: localResults.length + mpResults.length,
          },
          skills: [
            ...localResults.map(s => ({ ...s, source: 'local' })),
            ...mpResults,
          ],
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Subcommand: discover
  skillsCmd
    .command('discover')
    .description('Scan and discover available skills')
    .action(async () => {
      try {
        const projectSkills = await discoverAllSkills();
        const summaries = projectSkills.map(toSkillSummary);

        cliOutput({
          project: {
            count: summaries.length,
            skills: summaries,
          },
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Subcommand: validate
  skillsCmd
    .command('validate <skill-name>')
    .description('Validate skill against protocol')
    .action(async (skillName: string) => {
      try {
        const result = validateSkill(skillName);

        cliOutput({
          skill: skillName,
          validation: result,
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Subcommand: info
  skillsCmd
    .command('info <skill-name>')
    .description('Show skill details')
    .action(async (skillName: string) => {
      try {
        const skill = findSkill(skillName);
        if (!skill) {
          throw new CleoError(ExitCode.NOT_FOUND, `Skill not found: ${skillName}`, {
            fix: 'cleo skills list',
          });
        }

        const summary = toSkillSummary(skill);
        cliOutput({
          skill: skillName,
          info: summary,
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Subcommand: install
  skillsCmd
    .command('install <skill-name>')
    .description('Install skill to agent directory')
    .option('--global', 'Install globally')
    .action(async (skillName: string) => {
      try {
        const result = installSkill(skillName);

        if (!result.installed) {
          throw new CleoError(ExitCode.FILE_ERROR, result.error ?? 'Install failed', {
            fix: `Ensure skill exists: cleo skills info ${skillName}`,
          });
        }

        cliOutput({
          skill: skillName,
          installedTo: result.path,
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Default action (no subcommand) - list
  skillsCmd
    .action(async () => {
      try {
        const skills = await discoverAllSkills();
        const summaries = skills.map(toSkillSummary);

        cliOutput({
          scope: 'project',
          count: summaries.length,
          skills: summaries,
        }, { command: 'skills' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
