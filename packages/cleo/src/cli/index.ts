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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// ---------------------------------------------------------------------------
// Node version guard — runs BEFORE any @cleocode/core import.
//
// Delegates to the @cleocode/paths SSoT gate, which compares the FULL running
// semver against the runtime-read `engines.node` floor (currently >=24.16.0)
// instead of a major-only literal. The old `major < 24` check waved 24.13.1
// through — major 24, but below 24.16.0 where the bundled SQLite WAL-reset fix
// (SQLite 3.53.0) landed — letting the persistence layer diverge from CI.
//
// @cleocode/paths is the only import safe here: a zero-dep leaf that does NOT
// eagerly load node:sqlite (lazy via createRequire), so an under-floor Node
// fails with an actionable message rather than at node:sqlite load.
// ---------------------------------------------------------------------------
import { enforceNodeVersion } from '@cleocode/paths';
import {
  type CommandDef,
  type showUsage as cittyShowUsage,
  defineCommand,
  runCommand,
} from 'citty';

// NOTE: `@cleocode/core/internal` is a 2018-line barrel re-exporting 406
// symbols. A top-level eager import here transitively loads the entire CORE
// dependency tree (drizzle, node:sqlite, every dispatch handler, every
// middleware) for every CLI invocation — even `cleo --version`. We defer
// every CORE import to the point of actual use instead.
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { COMMAND_MANIFEST } from './generated/command-manifest.js';
import { buildAliasMap, createCustomShowUsage } from './help-renderer.js';
import { extractIdempotencyKeyArg, setIdempotencyKeyContext } from './idempotency-context.js';
import { lazyCommand } from './lazy-command.js';
import { didYouMean } from './lib/did-you-mean.js';
import { maybePromptFirstRun } from './lib/first-run-detection.js';
import { resolveFormat } from './middleware/output-format.js';
import { resolveOutputMode, setOutputMode } from './output-context.js';
import { setProjectionOptOut } from './projection-context.js';
import { resolveSubCommandForHelp } from './resolve-subcommand.js';
import { setSummaryMode } from './summary-context.js';

// Node version guard — first executable statement. Runs before any command
// dispatch (which lazily `import()`s @cleocode/core → node:sqlite), so an
// under-floor Node fails here with actionable guidance. The only static imports
// above are CLI-local + @cleocode/paths (a zero-dep leaf that does not eagerly
// load node:sqlite). See @cleocode/paths node-version-gate for the SSoT floor.
enforceNodeVersion();

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
  const { argv, idempotencyKey } = extractIdempotencyKeyArg(process.argv.slice(2));
  setIdempotencyKeyContext(idempotencyKey);

  // Parse global format + field flags from argv.
  const rawOpts: Record<string, unknown> = {};
  let verboseFlag = false;
  let outputModeRaw: string | undefined;
  let summaryFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') rawOpts['json'] = true;
    else if (arg === '--human') rawOpts['human'] = true;
    else if (arg === '--quiet') rawOpts['quiet'] = true;
    else if (arg === '--field' && i + 1 < argv.length) rawOpts['field'] = argv[++i];
    else if (arg === '--fields' && i + 1 < argv.length) rawOpts['fields'] = argv[++i];
    else if (arg === '--mvi' && i + 1 < argv.length) rawOpts['mvi'] = argv[++i];
    // T9922: MVI record projection opt-out. --full is an alias for --verbose.
    else if (arg === '--verbose' || arg === '--full') verboseFlag = true;
    // T9930 — global --output {envelope|id|table|count|silent} flag.
    else if (arg === '--output' && i + 1 < argv.length) outputModeRaw = argv[++i];
    // T9932 — global --summary flag: 1-line-per-record re-render.
    else if (arg === '--summary') summaryFlag = true;
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

  // T9922: MVI record projection opt-out. --verbose / --full mean "give me the
  // full record". --human also opts out because the human renderer needs every
  // field. JSON/agent paths (the common case) stay on MVI projection.
  setProjectionOptOut(verboseFlag || formatResolution.format === 'human');

  // T9930 — resolve & validate --output BEFORE dispatch. Rejecting an unknown
  // mode here gives the operator/agent a deterministic stderr error with a
  // valid-modes list instead of silently falling through to the default.
  if (outputModeRaw !== undefined) {
    // T11482 (DHQ-033): `--output json` resolves to the canonical `envelope`
    // payload via resolveOutputMode's alias table rather than being rejected.
    const resolvedMode = resolveOutputMode(outputModeRaw);
    if (resolvedMode === undefined) {
      const validModes = ['envelope', 'json', 'id', 'table', 'count', 'silent'];
      const suggestions = didYouMean(outputModeRaw, validModes, 3);
      process.stderr.write(
        `Error: invalid --output mode "${outputModeRaw}"\n` +
          `Valid modes: ${validModes.join(', ')}\n`,
      );
      if (suggestions.length > 0) {
        process.stderr.write(`Did you mean: ${suggestions.join(', ')}?\n`);
      }
      process.exit(2);
    }
    setOutputMode(resolvedMode);
  }

  // T9932 — 1-line-per-record summary render. See summary-context.ts for the
  // precedence rules (--field > --output non-envelope > --summary > defaults).
  setSummaryMode(summaryFlag);

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
    // T9933 — propagate --quiet to the logger subsystem BEFORE startup
    // maintenance so the pino fallback logger emits at level=silent instead
    // of writing WARN-level entries to stderr during migration checks etc.
    // Only runs on the non-fast-path; --help/--version with --quiet stays cheap.
    if (rawOpts['quiet'] === true) {
      const { setLoggerQuiet } = await import('@cleocode/core/internal');
      setLoggerQuiet(true);
    }
    await runStartupMaintenance();
  }

  // ---------------------------------------------------------------------------
  // First-run reminder (T9422 / §5.3 T-E3-3).
  //
  // Skipped on the help / version fast-path so `cleo --help` and
  // `cleo --version` stay near-instant. For real commands we prompt only
  // when ALL three signals point to "unconfigured" (no global config,
  // empty credential pool, no ANTHROPIC_API_KEY). The helper itself
  // silently no-ops on non-TTY stdin so CI / piped invocations never
  // block, and any failure inside detection is swallowed so the prompt
  // can never break the CLI.
  // ---------------------------------------------------------------------------
  if (!isHelpOrVersion) {
    try {
      await maybePromptFirstRun();
    } catch {
      // Belt-and-braces: maybePromptFirstRun already swallows its own
      // errors, but we double-guard here so an unexpected throw never
      // blocks startup.
    }
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

  await runMainWithLafsEnvelope(main, argv, customShowUsage);
}

/** Structural shape of citty's `CLIError` class. */
interface CittyCliError extends Error {
  readonly name: 'CLIError';
  readonly code: string;
}

/**
 * Type-guard for citty's `CLIError`. Returns the value when it has both
 * `name === 'CLIError'` AND a string `code` (e.g. `'EARG'`), else `null`.
 *
 * @internal
 */
function asCittyCliError(value: unknown): CittyCliError | null {
  if (!(value instanceof Error)) return null;
  if (value.name !== 'CLIError') return null;
  if (!('code' in value)) return null;
  const code = (value as Error & { code: unknown }).code;
  if (typeof code !== 'string') return null;
  return value as CittyCliError;
}

/**
 * Drop-in replacement for citty's `runMain` that ALWAYS emits a LAFS envelope
 * on error.
 *
 * Why this exists (T9633): citty's default `runMain` catches `CLIError` (e.g.
 * "Missing required argument: --for"), prints `showUsage` plus the raw error
 * message via `console.error`, then calls `process.exit(1)`. NO LAFS envelope
 * is emitted on stdout — violating ADR-039, which requires every CLI
 * invocation to produce a structured `{success, error, meta}` envelope so
 * agents can react to failures programmatically. Before this fix, callers
 * piping `cleo ... | jq` against an argument-validation error got zero JSON
 * bytes on stdout and a non-zero exit with no machine-readable reason.
 *
 * Behaviour:
 *   - `--help` / `-h`         → render `showUsage`, exit 0  (unchanged)
 *   - `--version` / `-V`      → print `meta.version`, exit 0 (unchanged)
 *   - successful command run  → command emits its own envelope, exit 0
 *   - citty `CLIError`        → render usage to stderr THEN emit
 *                               LAFS error envelope on stdout via
 *                               `cliError`, exit 1
 *   - any other thrown error  → emit LAFS error envelope on stdout,
 *                               exit 1
 *
 * @internal
 */
async function runMainWithLafsEnvelope(
  cmd: CommandDef,
  rawArgs: string[],
  showUsage: typeof cittyShowUsage,
): Promise<void> {
  const helpFlags = ['--help', '-h'];
  const versionFlags = ['--version', '-V'];

  // Help fast-path — walk DOWN the subcommand tree before rendering usage so
  // `cleo release plan --help` shows plan-specific help, not the root listing.
  //
  // BUG FIX (T9765): the previous implementation passed the ROOT `cmd` directly
  // to `showUsage`, so every `cleo <group> <verb> --help` invocation dumped the
  // top-level command list. Citty's own `runMain` resolves the leaf subcommand
  // via an unexported `resolveSubCommand` helper before calling showUsage; we
  // mirror that here with `resolveSubCommandForHelp` because citty 0.2.1 does
  // not re-export the resolver.
  if (rawArgs.some((a) => helpFlags.includes(a))) {
    const [leafCmd, parentCmd] = await resolveSubCommandForHelp(cmd, rawArgs);
    await showUsage(leafCmd, parentCmd);
    process.exit(0);
  }

  // Version fast-path — only when --version is the SOLE token.
  if (rawArgs.length === 1 && versionFlags.includes(rawArgs[0]!)) {
    const meta = typeof cmd.meta === 'function' ? await cmd.meta() : await cmd.meta;
    const version = (meta as { version?: string } | undefined)?.version;
    if (!version) {
      // Should never happen — startCli sets meta.version unconditionally.
      const { cliError } = await import('./renderers/index.js');
      cliError('No version specified', 1, { name: 'E_NO_VERSION' });
      process.exit(1);
    }
    // Match citty's plain-text version output for backward compat with scripts
    // that grep for the version string. The `cleo --version` agent path was
    // already handled earlier in startCli via cliOutput.
    process.stdout.write(`${version}\n`); // stdout-write-allowed: legacy citty version compat (pre-existing, line-shifted by T9932 --summary flag wiring)
    process.exit(0);
  }

  // T9769 — bind a fresh WarningCollector for this request via AsyncLocalStorage.
  // Producers anywhere in the call chain (CORE bridges, dispatch middleware,
  // CAAMP commands) can call `pushWarning(...)` from `@cleocode/lafs` and the
  // CLI renderer (formatSuccess / formatError → createCliMeta) automatically
  // drains the collector into `meta.warnings[]`. Outside this scope, the same
  // `pushWarning` call is a silent no-op — keeping the API safe for SDK
  // consumers that have not yet adopted the carrier.
  //
  // The dynamic import keeps the lafs symbol off the help / version fast-path
  // (already short-circuited above).
  const { WarningCollector, withWarningCollector } = await import('@cleocode/lafs');
  const collector = new WarningCollector();

  await withWarningCollector(collector, async () => {
    try {
      await runCommand(cmd, { rawArgs });
    } catch (err) {
      // NOTE: every branch in this catch ends with `process.exit(1)`, which
      // terminates immediately and bypasses the `finally` below. That is the
      // intended error contract — a hard exit releases all handles. Only the
      // SUCCESS path (no exit) needs the coordinated teardown in `finally`.
      const { cliError } = await import('./renderers/index.js');
      // Citty's CLIError extends Error with a string `code` (e.g. 'EARG') and
      // sets `name === 'CLIError'`. Narrow without lying to the type system.
      const cittyCliError = asCittyCliError(err);

      if (cittyCliError) {
        // Do NOT render citty's usage block here — `createCustomShowUsage` uses
        // `console.log` (stdout), which would corrupt the JSON envelope below.
        // The envelope's `fix` field tells humans how to recover; agents key
        // off `codeName`. Help is one `cleo <cmd> --help` away.
        cliError(cittyCliError.message, 1, {
          name: cittyCliError.code === 'EARG' ? 'E_VALIDATION' : `E_${cittyCliError.code}`,
          fix: `Run 'cleo <command> --help' to see required arguments.`,
        });
        process.exit(1);
      }

      // Non-citty error path — still must emit an envelope.
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 1, { name: 'E_CLI_UNCAUGHT' });
      process.exit(1);
    } finally {
      // T11568 — the success path does NOT call process.exit(); it emits the
      // LAFS envelope and returns, relying on the event loop draining so the
      // process exits rc:0. Process-lifetime worker threads (the BRAIN
      // single-writer worker behind `cleo memory observe` / brain.db writes, and
      // the pino-roll log transport) own a `MessagePort` that keeps the loop
      // alive forever — so without coordinated teardown the command printed its
      // success envelope and then HUNG (rc:124). Tear those down here, AFTER the
      // envelope has been written, so the loop drains and the process exits.
      // The error branches above already `process.exit(1)` (which bypasses this
      // finally), so this runs only on the success path.
      const { shutdownCliRuntime } = await import('@cleocode/core/internal');
      await shutdownCliRuntime();
    }
  });
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
 *
 * ### DB-open audit (T9029)
 *
 * UNIVERSAL steps (must precede every command):
 *   - Legacy file cleanup (T304/T307) — stat()-only, no DB open
 *   - T310 signaldock→conduit migration check — file-existence check only
 *   - Global-salt validation — reads machine-key file, no SQLite open
 *
 * DB-specific steps moved OUT of startup maintenance (T9029):
 *   - ensureConduitDb — deferred to commands that need conduit.db
 *   - ensureGlobalSignaldockDb — deferred to commands that need signaldock.db
 *
 * Both functions are already called by their respective consumers (agent.ts,
 * migrate-agents-v2.ts, init.ts, upgrade.ts, agent-registry-accessor.ts)
 * on the first DB access. Removing them from startup means `cleo find`,
 * `cleo show`, `cleo next`, and all memory commands no longer pay the cost
 * of opening two additional SQLite databases they never use.
 */
export async function runStartupMaintenance(): Promise<void> {
  const {
    detectAndRemoveLegacyGlobalFiles,
    detectAndRemoveStrayProjectNexus,
    getGlobalSalt,
    getLogger,
    getProjectRoot,
    isCleanupMarkerSet,
    migrateSignaldockToConduit,
    needsSignaldockToConduitMigration,
    setCleanupMarker,
    validateGlobalSalt,
  } = await import('@cleocode/core/internal');

  // ---------------------------------------------------------------------------
  // One-shot legacy cleanup gated by a per-version marker file (T9028).
  //
  // detectAndRemoveLegacyGlobalFiles + detectAndRemoveStrayProjectNexus perform
  // stat() calls on every invocation even when there is nothing left to clean.
  // The marker file ~/.cleo/.cleanup-{version}-{projectHash} lets us skip both
  // functions entirely after the first successful sweep per code version.
  //
  // New releases get a new marker name → sweep re-runs exactly once on upgrade.
  // ---------------------------------------------------------------------------
  let projectRootForCleanup = '';
  try {
    projectRootForCleanup = getProjectRoot();
  } catch {
    // E_NO_PROJECT: global command with no project context — use empty string
    // (produces a stable hash that covers the global-only cleanup path).
  }

  if (!isCleanupMarkerSet(CLI_VERSION, projectRootForCleanup)) {
    // One-shot idempotent cleanup of legacy global-tier files (T304 / ADR-036).
    try {
      detectAndRemoveLegacyGlobalFiles();
    } catch {
      // Non-fatal: legacy cleanup must never break the CLI startup path.
    }

    // One-shot cleanup of stray project-tier nexus.db (T307 / ADR-036).
    try {
      if (projectRootForCleanup) {
        detectAndRemoveStrayProjectNexus(projectRootForCleanup);
      }
    } catch {
      // Non-fatal: stray-nexus cleanup must never break the CLI startup path.
    }

    // Mark this version + project as swept so subsequent invocations skip
    // the stat()-heavy scan entirely.
    setCleanupMarker(CLI_VERSION, projectRootForCleanup);
  }

  // ---------------------------------------------------------------------------
  // T310 startup sequence (spec §4.6) — runs AFTER cleanups and BEFORE any DB
  // accessor is called so the first command sees the new topology. All steps
  // are non-fatal: errors are logged and CLI continues normally.
  // ---------------------------------------------------------------------------
  const _startupLog = getLogger('cli-startup');

  // Step 2: One-shot T310 signaldock → conduit migration (T358 / ADR-037 §8).
  // Skip during `cleo init` itself — init creates the project structure, so
  // expecting a project root here would always fail and emit a noisy
  // "Run cleo init at <path>" WARN. Init handles its own setup.
  const isInitInvocation = process.argv.slice(2).some((a) => a === 'init');
  if (!isInitInvocation) {
    try {
      const _projectRootForMigration = getProjectRoot();
      if (needsSignaldockToConduitMigration(_projectRootForMigration)) {
        const migrationResult = await migrateSignaldockToConduit(_projectRootForMigration);
        if (migrationResult.status === 'failed') {
          _startupLog.error(
            { errors: migrationResult.errors, projectRoot: _projectRootForMigration },
            'T310 migration: signaldock → conduit failed — CLI continues, run `cleo doctor` to diagnose',
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // E_NO_PROJECT (global command, no project root) and "Run cleo init at"
      // (uninitialized project) are expected — both indicate "no project to
      // migrate", not a real failure. Suppress the noise.
      if (msg.includes('E_NO_PROJECT') || msg.startsWith('Run cleo init')) {
        // expected — no-op
      } else {
        _startupLog.warn(
          { error: msg },
          'T310 migration startup check threw unexpectedly — CLI continues',
        );
      }
    }
  }

  // Steps 3 + 4 REMOVED (T9029: deferred DB opens).
  //
  // ensureConduitDb and ensureGlobalSignaldockDb previously ran here on every
  // non-fast-path invocation, opening two SQLite files even for commands that
  // never use them (e.g. cleo find, cleo show, cleo next, cleo memory find).
  //
  // Each DB is now opened lazily on first access by its own consumer:
  //   conduit.db      — agent.ts, migrate-agents-v2.ts, init.ts, upgrade.ts,
  //                     agent-registry-accessor.ts
  //   signaldock.db   — agent.ts, migrate-agents-v2.ts, signaldock-sqlite.ts
  //
  // If a new command needs one of these DBs it MUST call the appropriate
  // ensure* function before its first DB read/write, not rely on startup.

  // Step 5: Validate global-salt integrity and log 4-byte hex fingerprint.
  // This reads the machine-key file only; it does NOT open any SQLite DB.
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
