/**
 * CLI command group: cleo cant
 *
 * Subcommands:
 *   cleo cant migrate <file>                      -- Convert markdown to .cant files
 *   cleo cant parse <file>                        -- Parse a .cant file and emit AST
 *   cleo cant validate <file>                     -- 42-rule validation report
 *   cleo cant list <file> [--kind ...]            -- List agents / pipelines / workflows
 *   cleo cant execute <file> --pipeline <name>    -- Run a deterministic pipeline
 *
 * Phase 4 originally shelled out to a `cant-cli` Rust binary. T282 replaced
 * the binary with the async `cant-napi` napi-rs binding, so all subcommands
 * now call the `@cleocode/cant` TypeScript API directly (zero subprocess
 * overhead, single binary distribution).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliError, cliOutput } from '../renderers/index.js';

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
 * Shape of the high-level CANT document API loaded from @cleocode/cant.
 *
 * Mirrors the exports from `packages/cant/src/document.ts`. Defined
 * inline because the cant package is consumed via dynamic import to
 * keep the cleo bundle from pulling napi-rs into commands that don't
 * need it.
 */
interface CantDocumentModule {
  parseDocument: (filePath: string) => Promise<unknown>;
  validateDocument: (filePath: string) => Promise<unknown>;
  listSections: (filePath: string, kind: string) => Promise<unknown>;
  executePipeline: (filePath: string, pipelineName: string) => Promise<unknown>;
}

/**
 * Register the `cleo cant` command group.
 *
 * Registers a `cant` parent command and subcommands for parsing,
 * validating, listing, executing, and migrating CANT DSL files.
 *
 * @param program - The root CLI command to attach to
 *
 * @example
 * ```ts
 * registerCantCommand(rootCommand);
 * // Adds: cleo cant parse|validate|list|execute|migrate
 * ```
 */
export function registerCantCommand(program: Command): void {
  const cant = program.command('cant').description('CANT DSL tooling');

  cant
    .command('parse <file>')
    .description('Parse a .cant file and emit the AST')
    .action(async (file: string) => {
      const filePath = resolveFilePath(file);
      if (!ensureExists(filePath, 'cant.parse')) return;
      try {
        const mod = await loadCantDocument();
        const result = await mod.parseDocument(filePath);
        cliOutput(result, { command: 'cant', operation: 'cant.parse' });
      } catch (err) {
        emitFailure('cant.parse', 'E_PARSE_FAILED', err);
      }
    });

  cant
    .command('validate <file>')
    .description('Run the 42-rule validation suite on a .cant file')
    .action(async (file: string) => {
      const filePath = resolveFilePath(file);
      if (!ensureExists(filePath, 'cant.validate')) return;
      try {
        const mod = await loadCantDocument();
        const result = await mod.validateDocument(filePath);
        cliOutput(result, { command: 'cant', operation: 'cant.validate' });
      } catch (err) {
        emitFailure('cant.validate', 'E_VALIDATE_FAILED', err);
      }
    });

  cant
    .command('list <file>')
    .description('List agents, workflows, or pipelines in a .cant file')
    .option('--kind <kind>', 'One of: agent | workflow | pipeline (default: agent)', 'agent')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const filePath = resolveFilePath(file);
      if (!ensureExists(filePath, 'cant.list')) return;
      const kind = ((opts['kind'] as string | undefined) ?? 'agent').toLowerCase();
      if (kind !== 'agent' && kind !== 'pipeline' && kind !== 'workflow') {
        cliError(`Invalid --kind '${kind}'. Use one of: agent, pipeline, workflow.`, 'E_BAD_KIND');
        process.exitCode = 2;
        return;
      }
      try {
        const mod = await loadCantDocument();
        const result = await mod.listSections(filePath, kind);
        cliOutput(result, { command: 'cant', operation: `cant.list-${kind}s` });
      } catch (err) {
        emitFailure(`cant.list-${kind}s`, 'E_LIST_FAILED', err);
      }
    });

  cant
    .command('execute <file>')
    .description(
      'Execute a deterministic pipeline from a .cant file. LLM-dependent workflow constructs run via the cant-bridge.',
    )
    .requiredOption('--pipeline <name>', 'Pipeline name to execute')
    .action(async (file: string, opts: Record<string, unknown>) => {
      const filePath = resolveFilePath(file);
      if (!ensureExists(filePath, 'cant.execute')) return;
      const pipelineName = opts['pipeline'] as string;
      try {
        const mod = await loadCantDocument();
        const result = (await mod.executePipeline(filePath, pipelineName)) as {
          success: boolean;
          error?: string | null;
        };
        cliOutput(result, { command: 'cant', operation: 'cant.execute' });
        if (!result.success) {
          process.exitCode = 1;
        }
      } catch (err) {
        emitFailure('cant.execute', 'E_PIPELINE_RUNTIME', err);
        process.exitCode = 1;
      }
    });

  cant
    .command('migrate <file>')
    .description('Convert markdown instruction files to .cant format')
    .option('--write', 'Write .cant files to disk (default: dry-run preview)')
    .option('--dry-run', 'Preview conversion without writing files (default behavior)')
    .option('--output-dir <dir>', 'Output directory for .cant files (default: .cleo/agents/)')
    .option('--verbose', 'Show detailed conversion log')
    .action(
      async (
        file: string,
        opts: {
          write?: boolean;
          dryRun?: boolean;
          outputDir?: string;
          verbose?: boolean;
        },
      ) => {
        const isWrite = !!opts.write && !opts.dryRun;
        const isVerbose = !!opts.verbose;

        // Resolve file path
        const filePath = isAbsolute(file) ? file : resolve(process.cwd(), file);

        if (!ensureExists(filePath, 'cant.migrate')) return;

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
            }

            cliOutput(
              {
                inputFile: result.inputFile,
                filesWritten: written,
                outputFiles: result.outputFiles.map((f) => ({ path: f.path, kind: f.kind })),
                unconverted: result.unconverted,
                summary: result.summary,
              },
              { command: 'cant-migrate', operation: 'cant.migrate' },
            );
          } else {
            // Dry-run: emit structured result for agent consumption
            cliOutput(
              {
                inputFile: result.inputFile,
                dryRun: true,
                outputFiles: result.outputFiles.map((f) => ({
                  path: f.path,
                  kind: f.kind,
                })),
                unconverted: result.unconverted,
                summary: result.summary,
              },
              { command: 'cant-migrate', operation: 'cant.migrate' },
            );
          }
        } catch (err) {
          emitFailure('cant.migrate', 'E_MIGRATION_FAILED', err);
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Resolve a file argument to an absolute path against the current working
 * directory. Used by every cant subcommand for consistent input handling.
 */
function resolveFilePath(file: string): string {
  return isAbsolute(file) ? file : resolve(process.cwd(), file);
}

/**
 * Verify that a file exists, emitting a LAFS-shaped error envelope and
 * setting `process.exitCode` to 3 when it doesn't.
 *
 * @returns `true` when the file exists and execution can proceed.
 */
function ensureExists(filePath: string, operation: string): boolean {
  if (existsSync(filePath)) return true;
  cliError(`File not found: ${filePath}`, 'E_FILE_READ');
  process.exitCode = 3;
  // Surface operation context in stderr for human readers when debugging.
  if (process.env['CLEO_DEBUG']) {
    console.error(`(operation: ${operation})`);
  }
  return false;
}

/**
 * Emit a failure envelope for an unexpected exception thrown by the cant
 * document API. The error code is caller-provided so each subcommand can
 * report a meaningful classification.
 */
function emitFailure(operation: string, code: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  cliError(`${operation} failed: ${message}`, code);
  process.exitCode = process.exitCode ?? 1;
}

/**
 * Dynamically load the high-level CANT document API.
 *
 * Tries multiple import paths to support both installed packages and
 * development workspace layouts. Uses dynamic import to keep the cant
 * (and napi binding) lazy-loaded.
 *
 * @returns The loaded document module
 * @throws Error if the module cannot be found
 */
async function loadCantDocument(): Promise<CantDocumentModule> {
  const paths = ['@cleocode/cant', '../../../../cant/dist/index', '../../../../cant/src/index'];
  for (const p of paths) {
    try {
      const mod = (await import(p)) as Record<string, unknown>;
      if (
        typeof mod['parseDocument'] === 'function' &&
        typeof mod['validateDocument'] === 'function' &&
        typeof mod['listSections'] === 'function' &&
        typeof mod['executePipeline'] === 'function'
      ) {
        return mod as unknown as CantDocumentModule;
      }
    } catch {
      // Try next path
    }
  }
  throw new Error('Cannot load CANT document API. Ensure @cleocode/cant is installed.');
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
  const paths = ['@cleocode/cant', '../../../../cant/dist/index', '../../../../cant/src/index'];

  for (const p of paths) {
    try {
      const mod = (await import(p)) as Record<string, unknown>;
      if (typeof mod['migrateMarkdown'] === 'function' && typeof mod['showDiff'] === 'function') {
        return mod as unknown as MigrateModule;
      }
    } catch {
      // Try next path
    }
  }

  throw new Error('Cannot load CANT migration engine. Ensure @cleocode/cant is installed.');
}
