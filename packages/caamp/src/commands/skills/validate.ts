/**
 * skills validate command - LAFS-compliant with JSON-first output
 */

import type { LAFSErrorCategory } from '@cleocode/lafs';
import { resolveOutputFormat } from '@cleocode/lafs';
import type { Command } from 'commander';
import pc from 'picocolors';
import { buildEnvelope, ErrorCategories, ErrorCodes, emitJsonError } from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { validateSkill } from '../../core/skills/validator.js';

interface LAFSErrorShape {
  code: string;
  message: string;
  category: LAFSErrorCategory;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Record<string, unknown>;
}

/**
 * Registers the `skills validate` subcommand for validating SKILL.md file format.
 *
 * @remarks
 * Parses a SKILL.md file and checks it against the required schema, reporting any missing
 * sections, invalid metadata, or structural issues.
 *
 * @param parent - The parent `skills` Command to attach the validate subcommand to
 *
 * @example
 * ```bash
 * caamp skills validate ./my-skill/SKILL.md
 * caamp skills validate --json
 * ```
 *
 * @public
 */
export function registerSkillsValidate(parent: Command): void {
  parent
    .command('validate')
    .description('Validate SKILL.md format')
    .argument('[path]', 'Path to SKILL.md', 'SKILL.md')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (path: string, opts: { json?: boolean; human?: boolean }) => {
      const operation = 'skills.validate';
      const mvi: import('../../core/lafs.js').MVILevel = 'standard';

      let format: 'json' | 'human';
      try {
        format = resolveOutputFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: 'json',
        }).format;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(
          operation,
          mvi,
          ErrorCodes.FORMAT_CONFLICT,
          message,
          ErrorCategories.VALIDATION,
        );
        process.exit(1);
      }

      let result: import('../../core/skills/validator.js').ValidationResult;
      try {
        result = await validateSkill(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (format === 'json') {
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FILE_NOT_FOUND,
            message,
            ErrorCategories.NOT_FOUND,
            {
              path,
            },
          );
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      if (format === 'json') {
        const envelope = buildEnvelope(
          operation,
          mvi,
          {
            valid: result.valid,
            file: path,
            issues: result.issues.map((issue) => ({
              level: issue.level === 'error' ? 'error' : 'warn',
              field: issue.field,
              message: issue.message,
            })),
          },
          null,
        );
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        // Human-readable output
        if (result.valid) {
          console.log(pc.green(`✓ ${path} is valid`));
        } else {
          console.log(pc.red(`✗ ${path} has validation errors`));
        }

        for (const issue of result.issues) {
          const icon = issue.level === 'error' ? pc.red('✗') : pc.yellow('!');
          console.log(`  ${icon} [${issue.field}] ${issue.message}`);
        }
      }

      if (!result.valid) {
        process.exit(1);
      }
    });
}
