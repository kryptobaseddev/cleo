/**
 * CLI command group: cleo cant
 *
 * Subcommands:
 *   cleo cant migrate <file>     -- Convert markdown to .cant files
 *
 * @phase 7
 * @why Provide CLI tooling for CANT DSL adoption and migration
 * @what Parent command group with migrate subcommand
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Shape of the migration engine loaded at runtime from @cleocode/cant.
 *
 * Defined inline to avoid compile-time dependency on the cant package
 * (which uses commonjs and cannot be statically resolved by NodeNext).
 */
interface MigrateModule {
  migrateMarkdown: (
    content: string,
    inputFile: string,
    options: { write: boolean; verbose: boolean; outputDir?: string },
  ) => {
    inputFile: string;
    outputFiles: Array<{ path: string; kind: string; content: string }>;
    unconverted: Array<{ lineStart: number; lineEnd: number; reason: string; content: string }>;
    summary: string;
  };
  showDiff: (
    result: {
      inputFile: string;
      outputFiles: Array<{ path: string; kind: string; content: string }>;
      unconverted: Array<{ lineStart: number; lineEnd: number; reason: string; content: string }>;
      summary: string;
    },
    useColor: boolean,
  ) => string;
}

/**
 * Register the `cleo cant` command group.
 *
 * Registers a `cant` parent command and a `migrate` subcommand that
 * converts markdown instruction files to CANT DSL format.
 *
 * @param program - The root CLI command to attach to
 *
 * @example
 * ```ts
 * registerCantCommand(rootCommand);
 * // Adds: cleo cant migrate <file> [--write] [--dry-run] [--output-dir <dir>] [--verbose] [--json]
 * ```
 */
export function registerCantCommand(program: Command): void {
  const cant = program.command('cant').description('CANT DSL tooling');

  cant
    .command('migrate <file>')
    .description('Convert markdown instruction files to .cant format')
    .option('--write', 'Write .cant files to disk (default: dry-run preview)')
    .option('--dry-run', 'Preview conversion without writing files (default behavior)')
    .option('--output-dir <dir>', 'Output directory for .cant files (default: .cleo/agents/)')
    .option('--verbose', 'Show detailed conversion log')
    .option('--json', 'Output results as JSON')
    .action(
      async (
        file: string,
        opts: {
          write?: boolean;
          dryRun?: boolean;
          outputDir?: string;
          verbose?: boolean;
          json?: boolean;
        },
      ) => {
        const isJson = !!opts.json;
        const isWrite = !!opts.write && !opts.dryRun;
        const isVerbose = !!opts.verbose;

        // Resolve file path
        const filePath = isAbsolute(file) ? file : resolve(process.cwd(), file);

        if (!existsSync(filePath)) {
          const errMsg = `File not found: ${filePath}`;
          if (isJson) {
            console.log(JSON.stringify({ error: errMsg }));
          } else {
            console.error(errMsg);
          }
          process.exit(1);
        }

        try {
          // Dynamic import to avoid pulling cant into the main bundle
          // when the command is not used.
          const mod = await loadMigrateEngine();

          const content = readFileSync(filePath, 'utf-8');
          const result = mod.migrateMarkdown(content, filePath, {
            write: isWrite,
            verbose: isVerbose,
            outputDir: opts.outputDir,
          });

          if (isJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (isWrite) {
            // Write .cant files to disk
            const projectRoot = process.cwd();
            let written = 0;

            for (const outputFile of result.outputFiles) {
              const outputPath = isAbsolute(outputFile.path)
                ? outputFile.path
                : join(projectRoot, outputFile.path);

              mkdirSync(dirname(outputPath), { recursive: true });
              writeFileSync(outputPath, outputFile.content, 'utf-8');
              written++;

              if (isVerbose) {
                console.log(`  Created: ${outputFile.path} (${outputFile.kind})`);
              }
            }

            console.log(`Wrote ${written} .cant file(s).`);
            console.log(result.summary);

            if (result.unconverted.length > 0) {
              console.log('');
              console.log(`${result.unconverted.length} section(s) need manual conversion.`);
              for (const section of result.unconverted) {
                console.log(`  Lines ${section.lineStart}-${section.lineEnd}: ${section.reason}`);
              }
            }
          } else {
            // Dry-run: show diff preview
            const diffOutput = mod.showDiff(result, process.stdout.isTTY ?? false);
            console.log(diffOutput);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isJson) {
            console.log(JSON.stringify({ error: message }));
          } else {
            console.error(`Migration failed: ${message}`);
          }
          process.exit(1);
        }
      },
    );
}

/**
 * Dynamically load the CANT migration engine.
 *
 * Tries multiple import paths to support both installed packages
 * and development workspace layouts. Uses dynamic import to keep
 * the cant dependency lazy-loaded.
 *
 * @returns The loaded migration module
 * @throws Error if the module cannot be found
 */
async function loadMigrateEngine(): Promise<MigrateModule> {
  // Try loading paths in order of preference
  const paths = [
    '@cleocode/cant',
    '../../../../cant/dist/index',
    '../../../../cant/src/index',
  ];

  for (const p of paths) {
    try {
      const mod = (await import(p)) as Record<string, unknown>;
      if (typeof mod.migrateMarkdown === 'function' && typeof mod.showDiff === 'function') {
        return mod as unknown as MigrateModule;
      }
    } catch {
      // Try next path
    }
  }

  throw new Error(
    'Cannot load CANT migration engine. Ensure @cleocode/cant is installed.',
  );
}
