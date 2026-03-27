/**
 * skills audit command - LAFS-compliant with JSON-first output
 */

import { existsSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { scanDirectory, scanFile, toSarif } from '../../core/skills/audit/scanner.js';
import type { AuditResult } from '../../types.js';

interface SkillsAuditOptions {
  sarif?: boolean;
  json?: boolean;
  human?: boolean;
}

interface AuditFileResult {
  path: string;
  score: number;
  findings: Array<{
    level: 'critical' | 'high' | 'medium' | 'low';
    code: string;
    message: string;
    line?: number;
  }>;
}

interface AuditSummary {
  scanned: number;
  findings: number;
  files: AuditFileResult[];
}

/**
 * Registers the `skills audit` subcommand for security scanning skill files.
 *
 * @remarks
 * Scans SKILL.md files against 46+ security rules and outputs findings in LAFS JSON envelope,
 * human-readable, or raw SARIF format. Supports scanning individual files or entire directories.
 *
 * @param parent - The parent `skills` Command to attach the audit subcommand to
 *
 * @example
 * ```bash
 * caamp skills audit ./my-skill/SKILL.md
 * caamp skills audit ./skills-dir --sarif
 * ```
 *
 * @public
 */
export function registerSkillsAudit(parent: Command): void {
  parent
    .command('audit')
    .description('Security scan skill files (46+ rules, SARIF output)')
    .argument('[path]', 'Path to SKILL.md or directory', '.')
    .option('--sarif', 'Output in SARIF format (raw SARIF, not LAFS envelope)')
    .option('--json', 'Output as JSON (LAFS envelope)')
    .option('--human', 'Output in human-readable format')
    .action(async (path: string, opts: SkillsAuditOptions) => {
      const operation = 'skills.audit';
      const mvi: import('../../core/lafs.js').MVILevel = 'standard';

      // Check if path exists
      if (!existsSync(path)) {
        const message = `Path not found: ${path}`;

        // Check if --sarif was explicitly requested
        if (opts.sarif) {
          // For SARIF mode on error, output minimal SARIF with error
          console.error(
            JSON.stringify(
              {
                $schema:
                  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
                version: '2.1.0',
                runs: [
                  {
                    tool: { driver: { name: 'caamp-skills-audit' } },
                    invocations: [
                      {
                        executionSuccessful: false,
                        exitCode: 1,
                        exitCodeDescription: message,
                      },
                    ],
                    results: [],
                  },
                ],
              },
              null,
              2,
            ),
          );
        } else {
          // LAFS envelope error
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
        }
        process.exit(1);
      }

      // Resolve output format (SARIF is a special case - outputs raw SARIF, not LAFS envelope)
      let format: 'json' | 'human' | 'sarif';
      try {
        if (opts.sarif) {
          // SARIF is handled separately - it outputs raw SARIF format
          format = 'sarif';
        } else {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: (opts.human ?? false) || isHuman(),
            projectDefault: 'json',
          });
        }
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

      // Perform the scan
      const stat = statSync(path);
      let results: AuditResult[];

      try {
        if (stat.isFile()) {
          results = [await scanFile(path)];
        } else {
          results = await scanDirectory(path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (format === 'sarif') {
          console.error(
            JSON.stringify(
              {
                $schema:
                  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
                version: '2.1.0',
                runs: [
                  {
                    tool: { driver: { name: 'caamp-skills-audit' } },
                    invocations: [
                      {
                        executionSuccessful: false,
                        exitCode: 1,
                        exitCodeDescription: message,
                      },
                    ],
                    results: [],
                  },
                ],
              },
              null,
              2,
            ),
          );
        } else {
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.AUDIT_FAILED,
            message,
            ErrorCategories.INTERNAL,
            {
              path,
            },
          );
        }
        process.exit(1);
      }

      // Handle no results case
      if (results.length === 0) {
        if (format === 'sarif') {
          console.log(JSON.stringify(toSarif([]), null, 2));
          return;
        }

        if (format === 'json') {
          const summary: AuditSummary = {
            scanned: 0,
            findings: 0,
            files: [],
          };
          outputSuccess(operation, mvi, summary);
          return;
        }

        // Human-readable
        console.log(pc.dim('No SKILL.md files found to scan.'));
        return;
      }

      // Calculate summary
      const summary: AuditSummary = {
        scanned: results.length,
        findings: results.reduce((acc, r) => acc + r.findings.length, 0),
        files: results.map((r) => ({
          path: r.file,
          score: r.score,
          findings: r.findings.map((f) => ({
            level: f.rule.severity as 'critical' | 'high' | 'medium' | 'low',
            code: f.rule.id,
            message: `${f.rule.name}: ${f.rule.description}`,
            line: f.line,
          })),
        })),
      };

      // Check if all passed
      const allPassed = results.every((r) => r.passed);

      // SARIF output (raw SARIF format, not LAFS envelope)
      if (format === 'sarif') {
        console.log(JSON.stringify(toSarif(results), null, 2));
        if (!allPassed) {
          process.exit(1);
        }
        return;
      }

      // LAFS JSON output
      if (format === 'json') {
        outputSuccess(operation, mvi, summary);
        if (!allPassed) {
          process.exit(1);
        }
        return;
      }

      // Human-readable output
      let totalFindings = 0;

      for (const result of results) {
        const icon = result.passed ? pc.green('✓') : pc.red('✗');
        console.log(`\n${icon} ${pc.bold(result.file)} (score: ${result.score}/100)`);

        if (result.findings.length === 0) {
          console.log(pc.dim('  No issues found.'));
          continue;
        }

        totalFindings += result.findings.length;

        for (const f of result.findings) {
          const sev =
            f.rule.severity === 'critical'
              ? pc.red(f.rule.severity)
              : f.rule.severity === 'high'
                ? pc.red(f.rule.severity)
                : f.rule.severity === 'medium'
                  ? pc.yellow(f.rule.severity)
                  : pc.dim(f.rule.severity);

          console.log(`  ${sev.padEnd(20)} ${f.rule.id} ${f.rule.name}`);
          console.log(`  ${pc.dim(`L${f.line}: ${f.context.slice(0, 80)}`)}`);
        }
      }

      console.log(pc.bold(`\n${results.length} file(s) scanned, ${totalFindings} finding(s)`));

      if (!allPassed) {
        process.exit(1);
      }
    });
}
