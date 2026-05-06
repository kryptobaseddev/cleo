#!/usr/bin/env node
/**
 * CLEO CLI - Main entry point.
 *
 * Native citty command dispatch via lazy-loaded subcommands. The eager block
 * at the top of this file (manifest registration, alias setup) runs on every
 * invocation; everything else — CORE, command modules, startup maintenance —
 * is loaded on demand so `--version` / `--help` stay near-instant.
 *
 * T1138: SQLite warning suppression for CLI consumers is handled by the
 * esbuild banner that patches process.emitWarning before ESM imports are
 * hoisted. See build.mjs for the banner configuration.
 */

// ---------------------------------------------------------------------------
// Node version guard — runs before any @cleocode/core imports.
// CLEO requires Node >= 24 because packages/core/src/store/llmtxt-blob-adapter.ts
// imports node:sqlite (DatabaseSync), which only became stable in Node 24.
// ---------------------------------------------------------------------------
{
  const [major] = process.versions.node.split('.').map(Number);
  if (typeof major !== 'number' || major < 24) {
    process.stderr.write(
      `\nError: cleo requires Node.js >= 24.0.0\n` +
        `You are running Node ${process.versions.node}.\n\n` +
        `Node 24 provides the stable node:sqlite DatabaseSync API that CLEO\n` +
        `uses for its attachment store (zero native deps). Older Node versions\n` +
        `fail at runtime with ERR_UNKNOWN_BUILTIN_MODULE.\n\n` +
        `Upgrade via nvm:   nvm install 24 && nvm use 24\n` +
        `Or via fnm:        fnm install 24 && fnm use 24\n` +
        `Or via NodeSource: https://github.com/nodesource/distributions\n\n`,
    );
    process.exit(1);
  }
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CommandDef, defineCommand, runMain } from 'citty';

// NOTE: `@cleocode/core/internal` is a 2018-line barrel re-exporting 406
// symbols. A top-level eager import here transitively loads the entire CORE
// dependency tree (drizzle, node:sqlite, every dispatch handler, every
// middleware) for every CLI invocation — even `cleo --version`. We defer
// every CORE import to the point of actual use instead.
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { COMMAND_MANIFEST } from './generated/command-manifest.js';
import { buildAliasMap, createCustomShowUsage } from './help-renderer.js';
import { lazyCommand } from './lazy-command.js';
import { didYouMean } from './lib/did-you-mean.js';
import { resolveFormat } from './middleware/output-format.js';

function getPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const CLI_VERSION = getPackageVersion();

// ---------------------------------------------------------------------------
// Lazy command registration via build-generated manifest.
//
// The manifest carries each command's static `meta` (name + description) so
// `cleo --help` and `cleo --version` work without loading any command module.
// The full `CommandDef` is `import()`-ed only when the matched subcommand is
// actually executed — slashing cold-start cost from "load 111 modules + their
// transitive CORE/SQLite/drizzle trees" to "load just the matched command".
//
// Aliases share the SAME wrapper instance as their primary so `buildAliasMap`
// (which detects aliases by reference identity) keeps working.
// ---------------------------------------------------------------------------
const subCommands: Record<string, CommandDef> = {};

const lazyByExport = new Map<string, CommandDef>();
for (const entry of COMMAND_MANIFEST) {
  const wrapper = lazyCommand({ name: entry.name, description: entry.description }, entry.load);
  lazyByExport.set(entry.exportName, wrapper);
  subCommands[entry.name] = wrapper;
}

// Inline `version` subcommand — eager because zero dependencies and hot path.
subCommands['version'] = defineCommand({
  meta: { name: 'version', description: 'Display CLEO version' },
  async run() {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  },
});

// ---------------------------------------------------------------------------
// Root aliases — point to the SAME lazy wrapper instance so help renderer's
// reference-identity alias detection keeps working.
// ---------------------------------------------------------------------------
function alias(aliasName: string, primaryExport: string): void {
  const wrapper = lazyByExport.get(primaryExport);
  if (!wrapper) {
    throw new Error(
      `command-alias setup: no manifest entry for primary export "${primaryExport}" ` +
        `(needed by alias "${aliasName}")`,
    );
  }
  subCommands[aliasName] = wrapper;
}
alias('done', 'completeCommand');
alias('rm', 'deleteCommand');
alias('ls', 'listCommand');
alias('tags', 'labelsCommand');
alias('pipeline', 'phaseCommand');

/**
 * Core CLI startup: resolves global flags, optionally runs startup maintenance,
 * wires the main command, and hands off to citty's `runMain`.
 *
 * Help / version / no-args paths short-circuit BEFORE the maintenance block to
 * avoid loading CORE on the fast path.
 */
async function startCli(): Promise<void> {
  const argv = process.argv.slice(2);

  // Parse global format + field flags from argv.
  const rawOpts: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') rawOpts['json'] = true;
    else if (arg === '--human') rawOpts['human'] = true;
    else if (arg === '--quiet') rawOpts['quiet'] = true;
    else if (arg === '--field' && i + 1 < argv.length) rawOpts['field'] = argv[++i];
    else if (arg === '--fields' && i + 1 < argv.length) rawOpts['fields'] = argv[++i];
    else if (arg === '--mvi' && i + 1 < argv.length) rawOpts['mvi'] = argv[++i];
  }

  const formatResolution = resolveFormat(rawOpts);
  setFormatContext(formatResolution);

  const fieldResolution = resolveFieldContext(rawOpts);
  // Per owner directive: agent-first MVI. Default to 'minimal' unless the user
  // explicitly passed --mvi standard/full (mviSource === 'flag').
  if (fieldResolution.mviSource === 'default') {
    fieldResolution.mvi = 'minimal';
  }
  setFieldContext(fieldResolution);

  // ---------------------------------------------------------------------------
  // Fast-path for help / version / no-args invocations.
  //
  // The startup maintenance block (legacy cleanup, T310 migrations, conduit DB
  // ensure, signaldock DB ensure, salt validation) opens multiple SQLite
  // connections and can take seconds against a slow disk. None of it is
  // needed to print --version, --help, or the command list. Short-circuit
  // those cases so the user gets instant feedback.
  // ---------------------------------------------------------------------------
  const isHelpOrVersion =
    argv.length === 0 ||
    argv[0] === '--help' ||
    argv[0] === '-h' ||
    argv[0] === '--version' ||
    argv[0] === '-V' ||
    argv[0] === 'help';

  if (argv[0] === '--version' || argv[0] === '-V') {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
    return;
  }

  if (!isHelpOrVersion) {
    await runStartupMaintenance();
  }

  const main = defineCommand({
    meta: {
      name: 'cleo',
      version: CLI_VERSION,
      description: 'CLEO V2 - Task management for AI coding agents',
    },
    subCommands,
  });

  // Build alias map for help rendering (alias name → primary command name).
  // Detects duplicate-value entries in subCommands (alias slots) automatically.
  const aliasMap = buildAliasMap(subCommands);

  // Custom grouped help renderer for root --help; subcommands use citty default.
  const customShowUsage = createCustomShowUsage(CLI_VERSION, subCommands, aliasMap);

  // Did-you-mean for unknown commands (skip on help/version paths).
  if (!isHelpOrVersion) {
    const firstArg = argv[0];
    if (firstArg && !firstArg.startsWith('-')) {
      const availableCommands = Object.keys(subCommands);
      if (!availableCommands.includes(firstArg)) {
        const suggestions = didYouMean(firstArg, availableCommands, 3);
        process.stderr.write(`Unknown command ${firstArg}\n`);
        if (suggestions.length > 0) {
          process.stderr.write('\nDid you mean one of:\n');
          for (const suggestion of suggestions) {
            process.stderr.write(`  cleo ${suggestion}\n`);
          }
        }
        process.exit(127);
      }
    }
  }

  runMain(main, { showUsage: customShowUsage });
}

/**
 * One-shot maintenance tasks that must run before the first real command but
 * are skippable for help/version invocations. Exported so the startup-migration
 * test suite can await this directly (the module-level `void startCli()` below
 * doesn't await it, so test code can't observe completion via `await import`).
 *
 * @remarks
 * Every CORE symbol used here is dynamically imported so callers on the fast
 * path (`--version`, `--help`, `-V`, `-h`, no-args) never trigger the
 * 2018-line `@cleocode/core/internal` barrel and its 406-export transitive
 * dependency tree.
 */
export async function runStartupMaintenance(): Promise<void> {
  const {
    detectAndRemoveLegacyGlobalFiles,
    detectAndRemoveStrayProjectNexus,
    ensureConduitDb,
    ensureGlobalSignaldockDb,
    getGlobalSalt,
    getLogger,
    getProjectRoot,
    migrateSignaldockToConduit,
    needsSignaldockToConduitMigration,
    validateGlobalSalt,
  } = await import('@cleocode/core/internal');

  // One-shot idempotent cleanup of legacy global-tier files (T304 / ADR-036).
  try {
    detectAndRemoveLegacyGlobalFiles();
  } catch {
    // Non-fatal: legacy cleanup must never break the CLI startup path.
  }

  // One-shot cleanup of stray project-tier nexus.db (T307 / ADR-036).
  try {
    detectAndRemoveStrayProjectNexus(getProjectRoot());
  } catch {
    // Non-fatal: stray-nexus cleanup must never break the CLI startup path.
  }

  // ---------------------------------------------------------------------------
  // T310 startup sequence (spec §4.6) — runs AFTER cleanups and BEFORE any DB
  // accessor is called so the first command sees the new topology. All steps
  // are non-fatal: errors are logged and CLI continues normally.
  // ---------------------------------------------------------------------------
  const _startupLog = getLogger('cli-startup');

  // Step 2: One-shot T310 signaldock → conduit migration (T358 / ADR-037 §8).
  try {
    const _projectRootForMigration = getProjectRoot();
    if (needsSignaldockToConduitMigration(_projectRootForMigration)) {
      const migrationResult = migrateSignaldockToConduit(_projectRootForMigration);
      if (migrationResult.status === 'failed') {
        _startupLog.error(
          { errors: migrationResult.errors, projectRoot: _projectRootForMigration },
          'T310 migration: signaldock → conduit failed — CLI continues, run `cleo doctor` to diagnose',
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('E_NO_PROJECT')) {
      // Expected for global commands (e.g. `cleo session status`) — no-op.
    } else {
      _startupLog.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'T310 migration startup check threw unexpectedly — CLI continues',
      );
    }
  }

  // Step 3: Ensure conduit.db exists on fresh install (idempotent, project-scoped).
  try {
    ensureConduitDb(getProjectRoot());
  } catch {
    // Non-fatal: may throw E_NO_PROJECT outside a project; conduit.db is optional.
  }

  // Step 4: Ensure global signaldock.db exists (idempotent, global-tier).
  try {
    await ensureGlobalSignaldockDb();
  } catch (err) {
    _startupLog.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'T310 startup: ensureGlobalSignaldockDb failed — CLI continues',
    );
  }

  // Step 5: Validate global-salt integrity and log 4-byte hex fingerprint.
  try {
    validateGlobalSalt();
    const salt = getGlobalSalt();
    const fingerprint = salt.subarray(0, 4).toString('hex');
    _startupLog.info({ fingerprint }, 'global-salt fingerprint');
  } catch (err) {
    _startupLog.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'T310 startup: validateGlobalSalt failed — CLI continues, run `cleo doctor` to diagnose',
    );
  }
}

// ---------------------------------------------------------------------------
// Worktree ALS bridge invocation (T1873 / ADR-041 §D3)
//
// `runWithWorktreeScopeFromEnv` from CORE is a 5-line passthrough when
// CLEO_WORKTREE_ROOT is unset. We inline that env check so the common case
// (no env var) avoids importing CORE altogether — the import alone costs
// seconds against a slow disk because @cleocode/core/internal is a barrel.
// ---------------------------------------------------------------------------
async function bootstrap(): Promise<void> {
  if (process.env['CLEO_WORKTREE_ROOT']) {
    const { runWithWorktreeScopeFromEnv } = await import('@cleocode/core/internal');
    runWithWorktreeScopeFromEnv(() => {
      void startCli();
    });
  } else {
    void startCli();
  }
}

void bootstrap();
