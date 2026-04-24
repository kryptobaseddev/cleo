#!/usr/bin/env node
/**
 * CLEO CLI - Main entry point
 *
 * Native citty command dispatch — all commands use defineCommand.
 */

// ---------------------------------------------------------------------------
// Node version guard — MUST run before any import that touches node:sqlite.
// CLEO requires Node >= 24 because packages/core/src/store/llmtxt-blob-adapter.ts
// imports node:sqlite (DatabaseSync), which only became stable in Node 24.
// On Node 20/22 this throws ERR_UNKNOWN_BUILTIN_MODULE at module load — a
// cryptic failure for end users. Catch it here with a clear message.
// Discovered via sandbox dogfood 2026-04-20 (T1041 follow-up, P0 regression).
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
import {
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
} from '@cleocode/core/internal';
import { type CommandDef, defineCommand, runMain } from 'citty';
import { resolveFieldContext, setFieldContext } from './field-context.js';
import { setFormatContext } from './format-context.js';
import { buildAliasMap, createCustomShowUsage } from './help-renderer.js';
import { didYouMean } from './lib/did-you-mean.js';
import { resolveFormat } from './middleware/output-format.js';

function getPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const CLI_VERSION = getPackageVersion();

// ---------------------------------------------------------------------------
// Native citty command imports
// ---------------------------------------------------------------------------
import { adapterCommand } from './commands/adapter.js';
import { addCommand } from './commands/add.js';
import { addBatchCommand } from './commands/add-batch.js';
import { adminCommand } from './commands/admin.js';
import { adrCommand } from './commands/adr.js';
import { agentCommand } from './commands/agent.js';
import { analyzeCommand } from './commands/analyze.js';
import { archiveCommand } from './commands/archive.js';
import { archiveStatsCommand } from './commands/archive-stats.js';
import { auditCommand } from './commands/audit.js';
import { backfillCommand } from './commands/backfill.js';
import { backupCommand } from './commands/backup.js';
import { blockersCommand } from './commands/blockers.js';
import { brainCommand } from './commands/brain.js';
import { briefingCommand } from './commands/briefing.js';
import { bugCommand } from './commands/bug.js';
import { cancelCommand } from './commands/cancel.js';
import { cantCommand } from './commands/cant.js';
import { chainCommand } from './commands/chain.js';
import { checkCommand } from './commands/check.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { claimCommand, unclaimCommand } from './commands/claim.js';
import { codeCommand } from './commands/code.js';
import { completeCommand } from './commands/complete.js';
import { complexityCommand } from './commands/complexity.js';
import { complianceCommand } from './commands/compliance.js';
import { conduitCommand } from './commands/conduit.js';
import { configCommand } from './commands/config.js';
import { consensusCommand } from './commands/consensus.js';
import { contextCommand } from './commands/context.js';
import { contributionCommand } from './commands/contribution.js';
import { currentCommand } from './commands/current.js';
import { daemonCommand } from './commands/daemon.js';
import { dashCommand } from './commands/dash.js';
import { decompositionCommand } from './commands/decomposition.js';
import { deleteCommand } from './commands/delete.js';
import { depsCommand, treeCommand } from './commands/deps.js';
import { detectCommand } from './commands/detect.js';
import { detectDriftCommand } from './commands/detect-drift.js';
import { diagnosticsCommand } from './commands/diagnostics.js';
import { docsCommand } from './commands/docs.js';
import { doctorCommand } from './commands/doctor.js';
import { doctorProjectsCommand } from './commands/doctor-projects.js';
import { existsCommand } from './commands/exists.js';
import { exportCommand } from './commands/export.js';
import { exportTasksCommand } from './commands/export-tasks.js';
import { findCommand } from './commands/find.js';
import { gcCommand } from './commands/gc.js';
import { generateChangelogCommand } from './commands/generate-changelog.js';
import { gradeCommand } from './commands/grade.js';
import { historyCommand } from './commands/history.js';
import { importCommand } from './commands/import.js';
import { importTasksCommand } from './commands/import-tasks.js';
import { initCommand } from './commands/init.js';
import { injectCommand } from './commands/inject.js';
import { installGlobalCommand } from './commands/install-global.js';
import { intelligenceCommand } from './commands/intelligence.js';
import { issueCommand } from './commands/issue.js';
import { labelsCommand } from './commands/labels.js';
import { lifecycleCommand } from './commands/lifecycle.js';
import { listCommand } from './commands/list.js';
import { logCommand } from './commands/log.js';
import { manifestCommand } from './commands/manifest.js';
import { mapCommand } from './commands/map.js';
import { memoryCommand } from './commands/memory.js';
import { migrateClaudeMemCommand } from './commands/migrate-claude-mem.js';
import { nextCommand } from './commands/next.js';
import { nexusCommand } from './commands/nexus.js';
import { opsCommand } from './commands/ops.js';
import { orchestrateCommand } from './commands/orchestrate.js';
import { otelCommand } from './commands/otel.js';
import { phaseCommand } from './commands/phase.js';
import { planCommand } from './commands/plan.js';
import { playbookCommand } from './commands/playbook.js';
import { promoteCommand } from './commands/promote.js';
import { providerCommand } from './commands/provider.js';
import { reasonCommand } from './commands/reason.js';
import { refreshMemoryCommand } from './commands/refresh-memory.js';
import { relatesCommand } from './commands/relates.js';
import { releaseCommand } from './commands/release.js';
import { pullCommand, pushCommand, remoteCommand } from './commands/remote.js';
import { reorderCommand } from './commands/reorder.js';
import { reparentCommand } from './commands/reparent.js';
import { reqCommand } from './commands/req.js';
import { researchCommand } from './commands/research.js';
import { restoreCommand } from './commands/restore.js';
import { roadmapCommand } from './commands/roadmap.js';
import { safestopCommand } from './commands/safestop.js';
import { schemaCommand } from './commands/schema.js';
import { selfUpdateCommand } from './commands/self-update.js';
import { sentientCommand } from './commands/sentient.js';
import { sequenceCommand } from './commands/sequence.js';
import { sessionCommand } from './commands/session.js';
import { showCommand } from './commands/show.js';
import { skillsCommand } from './commands/skills.js';
import { snapshotCommand } from './commands/snapshot.js';
import { startCommand } from './commands/start.js';
import { statsCommand } from './commands/stats.js';
import { stickyCommand } from './commands/sticky.js';
import { stopCommand } from './commands/stop.js';
import { syncCommand } from './commands/sync.js';
import { testingCommand } from './commands/testing.js';
import { tokenCommand } from './commands/token.js';
import { transcriptCommand } from './commands/transcript.js';
import { updateCommand } from './commands/update.js';
import { upgradeCommand } from './commands/upgrade.js';
import { verifyCommand } from './commands/verify.js';
import { webCommand } from './commands/web.js';

const subCommands: Record<string, CommandDef> = {};

subCommands['version'] = defineCommand({
  meta: { name: 'version', description: 'Display CLEO version' },
  async run() {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
  },
});

// ---------------------------------------------------------------------------
// Wire all native commands
// ---------------------------------------------------------------------------
subCommands['adapter'] = adapterCommand as CommandDef;
subCommands['add'] = addCommand as CommandDef;
subCommands['add-batch'] = addBatchCommand as CommandDef;
subCommands['admin'] = adminCommand as CommandDef;
subCommands['adr'] = adrCommand as CommandDef;
subCommands['agent'] = agentCommand as CommandDef;
subCommands['analyze'] = analyzeCommand as CommandDef;
subCommands['audit'] = auditCommand as CommandDef;
subCommands['archive'] = archiveCommand as CommandDef;
subCommands['archive-stats'] = archiveStatsCommand as CommandDef;
subCommands['backfill'] = backfillCommand as CommandDef;
subCommands['backup'] = backupCommand as CommandDef;
subCommands['blockers'] = blockersCommand as CommandDef;
subCommands['brain'] = brainCommand as CommandDef;
subCommands['briefing'] = briefingCommand as CommandDef;
subCommands['bug'] = bugCommand as CommandDef;
subCommands['cancel'] = cancelCommand as CommandDef;
subCommands['cant'] = cantCommand as CommandDef;
subCommands['chain'] = chainCommand as CommandDef;
subCommands['check'] = checkCommand as CommandDef;
subCommands['checkpoint'] = checkpointCommand as CommandDef;
subCommands['claim'] = claimCommand as CommandDef;
subCommands['unclaim'] = unclaimCommand as CommandDef;
subCommands['code'] = codeCommand as CommandDef;
subCommands['conduit'] = conduitCommand as CommandDef;
subCommands['complete'] = completeCommand as CommandDef;
subCommands['complexity'] = complexityCommand as CommandDef;
subCommands['compliance'] = complianceCommand as CommandDef;
subCommands['config'] = configCommand as CommandDef;
subCommands['consensus'] = consensusCommand as CommandDef;
subCommands['context'] = contextCommand as CommandDef;
subCommands['contribution'] = contributionCommand as CommandDef;
subCommands['current'] = currentCommand as CommandDef;
subCommands['daemon'] = daemonCommand as CommandDef;
subCommands['dash'] = dashCommand as CommandDef;
subCommands['decomposition'] = decompositionCommand as CommandDef;
subCommands['delete'] = deleteCommand as CommandDef;
subCommands['deps'] = depsCommand as CommandDef;
subCommands['tree'] = treeCommand as CommandDef;
subCommands['detect'] = detectCommand as CommandDef;
subCommands['detect-drift'] = detectDriftCommand as CommandDef;
subCommands['diagnostics'] = diagnosticsCommand as CommandDef;
subCommands['docs'] = docsCommand as CommandDef;
subCommands['doctor'] = doctorCommand as CommandDef;
subCommands['doctor-projects'] = doctorProjectsCommand as CommandDef;
subCommands['exists'] = existsCommand as CommandDef;
subCommands['export'] = exportCommand as CommandDef;
subCommands['export-tasks'] = exportTasksCommand as CommandDef;
subCommands['find'] = findCommand as CommandDef;
subCommands['gc'] = gcCommand as CommandDef;
subCommands['generate-changelog'] = generateChangelogCommand as CommandDef;
subCommands['grade'] = gradeCommand as CommandDef;
subCommands['history'] = historyCommand as CommandDef;
subCommands['import'] = importCommand as CommandDef;
subCommands['import-tasks'] = importTasksCommand as CommandDef;
subCommands['init'] = initCommand as CommandDef;
subCommands['install-global'] = installGlobalCommand as CommandDef;
subCommands['inject'] = injectCommand as CommandDef;
subCommands['intelligence'] = intelligenceCommand as CommandDef;
subCommands['issue'] = issueCommand as CommandDef;
subCommands['labels'] = labelsCommand as CommandDef;
subCommands['lifecycle'] = lifecycleCommand as CommandDef;
subCommands['list'] = listCommand as CommandDef;
subCommands['log'] = logCommand as CommandDef;
subCommands['map'] = mapCommand as CommandDef;
subCommands['manifest'] = manifestCommand as CommandDef;
subCommands['memory'] = memoryCommand as CommandDef;
subCommands['migrate'] = migrateClaudeMemCommand as CommandDef;
subCommands['next'] = nextCommand as CommandDef;
subCommands['nexus'] = nexusCommand as CommandDef;
subCommands['ops'] = opsCommand as CommandDef;
subCommands['orchestrate'] = orchestrateCommand as CommandDef;
subCommands['otel'] = otelCommand as CommandDef;
subCommands['phase'] = phaseCommand as CommandDef;
subCommands['plan'] = planCommand as CommandDef;
subCommands['playbook'] = playbookCommand as CommandDef;
subCommands['promote'] = promoteCommand as CommandDef;
subCommands['provider'] = providerCommand as CommandDef;
subCommands['reason'] = reasonCommand as CommandDef;
subCommands['refresh-memory'] = refreshMemoryCommand as CommandDef;
subCommands['relates'] = relatesCommand as CommandDef;
subCommands['release'] = releaseCommand as CommandDef;
subCommands['remote'] = remoteCommand as CommandDef;
subCommands['push'] = pushCommand as CommandDef;
subCommands['pull'] = pullCommand as CommandDef;
subCommands['reorder'] = reorderCommand as CommandDef;
subCommands['reparent'] = reparentCommand as CommandDef;
subCommands['req'] = reqCommand as CommandDef;
subCommands['research'] = researchCommand as CommandDef;
subCommands['restore'] = restoreCommand as CommandDef;
subCommands['roadmap'] = roadmapCommand as CommandDef;
subCommands['safestop'] = safestopCommand as CommandDef;
subCommands['schema'] = schemaCommand as CommandDef;
subCommands['self-update'] = selfUpdateCommand as CommandDef;
subCommands['sentient'] = sentientCommand as CommandDef;
subCommands['sequence'] = sequenceCommand as CommandDef;
subCommands['session'] = sessionCommand as CommandDef;
subCommands['show'] = showCommand as CommandDef;
subCommands['skills'] = skillsCommand as CommandDef;
subCommands['snapshot'] = snapshotCommand as CommandDef;
subCommands['start'] = startCommand as CommandDef;
subCommands['stats'] = statsCommand as CommandDef;
subCommands['sticky'] = stickyCommand as CommandDef;
subCommands['stop'] = stopCommand as CommandDef;
subCommands['sync'] = syncCommand as CommandDef;
subCommands['testing'] = testingCommand as CommandDef;
subCommands['token'] = tokenCommand as CommandDef;
subCommands['transcript'] = transcriptCommand as CommandDef;
subCommands['update'] = updateCommand as CommandDef;
subCommands['upgrade'] = upgradeCommand as CommandDef;
subCommands['verify'] = verifyCommand as CommandDef;
subCommands['web'] = webCommand as CommandDef;

// ---------------------------------------------------------------------------
// Root aliases
// ---------------------------------------------------------------------------
subCommands['done'] = completeCommand as CommandDef;
subCommands['rm'] = deleteCommand as CommandDef;
subCommands['ls'] = listCommand as CommandDef;
subCommands['tags'] = labelsCommand as CommandDef;
subCommands['pipeline'] = phaseCommand as CommandDef;

// ---------------------------------------------------------------------------
// Global flag resolution (replaces Commander.js preAction hook)
//
// LAFS format flags (--human, --json, --quiet) and field flags (--field,
// --fields, --mvi) must be resolved BEFORE any command runs so that
// cliOutput() and dispatchFromCli() can read the correct context.
// This was previously done in a Commander.js preAction hook that was lost
// during the citty migration — restoring it here fixes --human, --quiet, etc.
// ---------------------------------------------------------------------------
{
  const argv = process.argv.slice(2);

  // Parse global format + field flags from argv
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

  // Resolve and set format context (JSON/human/quiet)
  const formatResolution = resolveFormat(rawOpts);
  setFormatContext(formatResolution);

  // Resolve and set field extraction context (--field, --fields, --mvi)
  const fieldResolution = resolveFieldContext(rawOpts);
  // Per owner directive: agent-first MVI. Default to 'minimal' unless user
  // explicitly passed --mvi standard/full (mviSource === 'flag').
  if (fieldResolution.mviSource === 'default') {
    fieldResolution.mvi = 'minimal';
  }
  setFieldContext(fieldResolution);

  // One-shot idempotent cleanup of legacy global-tier files (T304 / ADR-036).
  // Runs non-blocking on every invocation; errors are swallowed so that stale
  // files never prevent normal command execution.
  try {
    detectAndRemoveLegacyGlobalFiles();
  } catch {
    // Non-fatal: legacy cleanup must never break the CLI startup path.
  }

  // One-shot cleanup of stray project-tier nexus.db (T307 / ADR-036).
  // A zero-byte .cleo/nexus.db was accidentally created by pre-v2026.4.11
  // code. This removes it on first `cleo` run post-upgrade. Best-effort:
  // errors are swallowed so cleanup never blocks normal command execution.
  try {
    detectAndRemoveStrayProjectNexus(getProjectRoot());
  } catch {
    // Non-fatal: stray-nexus cleanup must never break the CLI startup path.
  }

  // ---------------------------------------------------------------------------
  // T310 startup sequence (spec §4.6) — runs AFTER v2026.4.11 cleanups and
  // BEFORE any DB accessor is called so the first command sees the new topology.
  // All steps are non-fatal: errors are logged and CLI continues normally.
  // ---------------------------------------------------------------------------
  const _startupLog = getLogger('cli-startup');

  // Step 2: One-shot T310 signaldock → conduit migration (T358 / ADR-037 §8).
  // Guarded by needsSignaldockToConduitMigration for efficiency; the check is
  // idempotent — migration is skipped silently once conduit.db exists (TC-067).
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
    // getProjectRoot() throws with E_NO_PROJECT when run outside a project directory.
    // Migration is per-project so we skip silently in that case.
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
    // Non-fatal: may throw E_NO_PROJECT outside a project; conduit.db is optional
    // for global commands.
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

  // Step 5: Validate global-salt integrity and log 4-byte hex fingerprint (spec §4.6).
  try {
    validateGlobalSalt();
    // Log first 4 bytes of the salt as a hex fingerprint for diagnosability.
    // getGlobalSalt() generates the salt on first call if absent; validation above
    // already confirmed the file is well-formed (or absent — first-run path).
    const salt = getGlobalSalt();
    const fingerprint = salt.subarray(0, 4).toString('hex');
    _startupLog.info({ fingerprint }, 'global-salt fingerprint');
  } catch (err) {
    _startupLog.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'T310 startup: validateGlobalSalt failed — CLI continues, run `cleo doctor` to diagnose',
    );
  }

  // Handle -V as alias for --version (citty handles --version but not -V)
  // Must come after format context is set so output respects --json/--human
  if (argv[0] === '-V') {
    const { cliOutput } = await import('./renderers/index.js');
    cliOutput({ version: CLI_VERSION }, { command: 'version' });
    process.exit(0);
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

// Build alias map for help rendering (alias name → primary command name)
// Detects duplicate-value entries in subCommands (alias slots) automatically.
const aliasMap = buildAliasMap(subCommands);

// Use custom grouped help renderer for root --help; sub-commands use citty's default
const customShowUsage = createCustomShowUsage(CLI_VERSION, subCommands, aliasMap);

// Check for unknown command before running main
{
  const rawArgs = process.argv.slice(2);
  const firstArg = rawArgs[0];

  // Only check if:
  // 1. There is a first argument
  // 2. It doesn't start with '-' (not a flag)
  // 3. It's not a help request
  // 4. It's not a version request
  if (
    firstArg &&
    !firstArg.startsWith('-') &&
    firstArg !== '--help' &&
    firstArg !== '-h' &&
    firstArg !== '--version' &&
    firstArg !== '-V'
  ) {
    const availableCommands = Object.keys(subCommands);

    // If the command is not in the list, handle it with did-you-mean
    if (!availableCommands.includes(firstArg)) {
      const suggestions = didYouMean(firstArg, availableCommands, 3);

      // Print error to stderr
      process.stderr.write(`Unknown command ${firstArg}\n`);

      // Print suggestions if found
      if (suggestions.length > 0) {
        process.stderr.write('\nDid you mean one of:\n');
        for (const suggestion of suggestions) {
          process.stderr.write(`  cleo ${suggestion}\n`);
        }
      }

      // Exit with code 127 (standard bash "command not found")
      process.exit(127);
    }
  }
}

runMain(main, { showUsage: customShowUsage });
