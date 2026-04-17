/**
 * CLI command group: cleo cant
 *
 * Subcommands: parse, validate, list, execute, migrate
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

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

interface CantDocumentModule {
  parseDocument: (filePath: string) => Promise<unknown>;
  validateDocument: (filePath: string) => Promise<unknown>;
  listSections: (filePath: string, kind: string) => Promise<unknown>;
  executePipeline: (filePath: string, pipelineName: string) => Promise<unknown>;
}

function resolveFilePath(file: string): string {
  return isAbsolute(file) ? file : resolve(process.cwd(), file);
}

function ensureExists(filePath: string, operation: string): boolean {
  if (existsSync(filePath)) return true;
  cliError(`File not found: ${filePath}`, 'E_FILE_READ');
  process.exitCode = 3;
  if (process.env['CLEO_DEBUG']) console.error(`(operation: ${operation})`);
  return false;
}

function emitFailure(operation: string, code: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  cliError(`${operation} failed: ${message}`, code);
  process.exitCode = process.exitCode ?? 1;
}

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

async function loadMigrateEngine(): Promise<MigrateModule> {
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

/** cleo cant parse — parse a .cant file and emit the AST */
const cantParseCommand = defineCommand({
  meta: { name: 'parse', description: 'Parse a .cant file and emit the AST' },
  args: { file: { type: 'positional', description: '.cant file to parse', required: true } },
  async run({ args }) {
    const filePath = resolveFilePath(args.file as string);
    if (!ensureExists(filePath, 'cant.parse')) return;
    try {
      const mod = await loadCantDocument();
      const result = await mod.parseDocument(filePath);
      cliOutput(result, { command: 'cant', operation: 'cant.parse' });
    } catch (err) {
      emitFailure('cant.parse', 'E_PARSE_FAILED', err);
    }
  },
});

/** cleo cant validate — run the 42-rule validation suite on a .cant file */
const cantValidateCommand = defineCommand({
  meta: { name: 'validate', description: 'Run the 42-rule validation suite on a .cant file' },
  args: { file: { type: 'positional', description: '.cant file to validate', required: true } },
  async run({ args }) {
    const filePath = resolveFilePath(args.file as string);
    if (!ensureExists(filePath, 'cant.validate')) return;
    try {
      const mod = await loadCantDocument();
      const result = await mod.validateDocument(filePath);
      cliOutput(result, { command: 'cant', operation: 'cant.validate' });
    } catch (err) {
      emitFailure('cant.validate', 'E_VALIDATE_FAILED', err);
    }
  },
});

/** cleo cant list — list agents, workflows, or pipelines in a .cant file */
const cantListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List agents, workflows, or pipelines in a .cant file',
  },
  args: {
    file: { type: 'positional', description: '.cant file to inspect', required: true },
    kind: {
      type: 'string',
      description: 'One of: agent | workflow | pipeline (default: agent)',
      default: 'agent',
    },
  },
  async run({ args }) {
    const filePath = resolveFilePath(args.file as string);
    if (!ensureExists(filePath, 'cant.list')) return;
    const kind = ((args.kind as string | undefined) ?? 'agent').toLowerCase();
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
  },
});

/** cleo cant execute — execute a deterministic pipeline from a .cant file */
const cantExecuteCommand = defineCommand({
  meta: {
    name: 'execute',
    description:
      'Execute a deterministic pipeline from a .cant file. LLM-dependent workflow constructs run via the cant-bridge.',
  },
  args: {
    file: { type: 'positional', description: '.cant file to execute', required: true },
    pipeline: { type: 'string', description: 'Pipeline name to execute', required: true },
  },
  async run({ args }) {
    const filePath = resolveFilePath(args.file as string);
    if (!ensureExists(filePath, 'cant.execute')) return;
    const pipelineName = args.pipeline as string;
    try {
      const mod = await loadCantDocument();
      const result = (await mod.executePipeline(filePath, pipelineName)) as {
        success: boolean;
        error?: string | null;
      };
      cliOutput(result, { command: 'cant', operation: 'cant.execute' });
      if (!result.success) process.exitCode = 1;
    } catch (err) {
      emitFailure('cant.execute', 'E_PIPELINE_RUNTIME', err);
      process.exitCode = 1;
    }
  },
});

/** cleo cant migrate — convert markdown instruction files to .cant format */
const cantMigrateCommand = defineCommand({
  meta: { name: 'migrate', description: 'Convert markdown instruction files to .cant format' },
  args: {
    file: { type: 'positional', description: 'Markdown file to migrate', required: true },
    write: { type: 'boolean', description: 'Write .cant files to disk (default: dry-run preview)' },
    'dry-run': {
      type: 'boolean',
      description: 'Preview conversion without writing files (default behavior)',
    },
    'output-dir': {
      type: 'string',
      description: 'Output directory for .cant files (default: .cleo/agents/)',
    },
    verbose: { type: 'boolean', description: 'Show detailed conversion log' },
  },
  async run({ args }) {
    const isWrite = !!args.write && !args['dry-run'];
    const isVerbose = !!args.verbose;
    const filePath = resolveFilePath(args.file as string);
    if (!ensureExists(filePath, 'cant.migrate')) return;
    try {
      const mod = await loadMigrateEngine();
      const content = readFileSync(filePath, 'utf-8');
      const result = mod.migrateMarkdown(content, filePath, {
        write: isWrite,
        verbose: isVerbose,
        outputDir: args['output-dir'] as string | undefined,
      });
      if (isWrite) {
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
        cliOutput(
          {
            inputFile: result.inputFile,
            dryRun: true,
            outputFiles: result.outputFiles.map((f) => ({ path: f.path, kind: f.kind })),
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
});

/**
 * Root cant command group — CANT DSL tooling.
 *
 * Provides parse, validate, list, execute, and migrate subcommands that
 * call the @cleocode/cant TypeScript API directly (no subprocess).
 */
export const cantCommand = defineCommand({
  meta: { name: 'cant', description: 'CANT DSL tooling' },
  subCommands: {
    parse: cantParseCommand,
    validate: cantValidateCommand,
    list: cantListCommand,
    execute: cantExecuteCommand,
    migrate: cantMigrateCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
