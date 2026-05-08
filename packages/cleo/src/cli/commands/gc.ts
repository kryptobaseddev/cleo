/**
 * CLI command: cleo gc
 *
 * Manual GC trigger and status reporting.
 *
 * Subcommands:
 *   cleo gc run         — manual GC trigger (blocking, for debugging/immediate need)
 *   cleo gc status      — show last run stats, disk%, escalation state
 *   cleo gc worktrees   — prune orphaned agent worktree directories
 *   cleo gc temp        — prune orphaned CLEO-generated temp directories
 *
 * The GC engine checks disk pressure on `~/.cleo/` and prunes transcripts
 * under `~/.claude/projects/` based on the five-tier threshold model.
 *
 * @see packages/core/src/gc/runner.ts for GC logic
 * @see packages/core/src/gc/cleanup.ts for orphan cleanup logic
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @task T731
 * @task T1724
 * @task T9043
 * @epic T726
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOrphanTempDirs, pruneOrphanWorktrees } from '@cleocode/core/gc/cleanup.js';
import { runGC } from '@cleocode/core/gc/runner.js';
import { readGCState } from '@cleocode/core/gc/state.js';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Format a byte count into a human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Human-readable string (e.g. `"1.2 GB"`, `"340 MB"`, `"0 B"`)
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp] ?? 'B'}`;
}

/** cleo gc run — trigger GC immediately (blocking) */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Run GC immediately (blocking). Prunes old transcripts based on disk pressure.',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be pruned without deleting anything',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const dryRun = args['dry-run'];

    try {
      const gcResult = await runGC({ cleoDir, dryRun });
      const dryLabel = dryRun ? ' (dry run)' : '';
      const humanMsg =
        `GC run complete${dryLabel} — ` +
        `Disk: ${gcResult.diskUsedPct.toFixed(1)}% (${gcResult.threshold.toUpperCase()}), ` +
        `Pruned: ${gcResult.pruned.length} paths, ${formatBytes(gcResult.bytesFreed)} freed` +
        (gcResult.escalationSet && gcResult.escalationReason
          ? ` — WARNING: ${gcResult.escalationReason}`
          : '');
      cliOutput(gcResult, {
        command: 'gc',
        operation: 'gc.run',
        message: humanMsg,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `GC run failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'gc.run',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo gc status — show last GC run stats, disk usage, and escalation state */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show last GC run stats, disk usage, and escalation state',
  },
  args: {
    'cleo-dir': {
      type: 'string',
      description: 'Override .cleo/ directory path',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cleoDir = (args['cleo-dir'] as string | undefined) ?? join(homedir(), '.cleo');
    const statePath = join(cleoDir, 'gc-state.json');

    try {
      const state = await readGCState(statePath);
      const diskStr =
        state.lastDiskUsedPct !== null ? `${state.lastDiskUsedPct.toFixed(1)}%` : 'unknown';
      cliOutput(state, {
        command: 'gc',
        operation: 'gc.status',
        message:
          `Last run: ${state.lastRunAt ?? 'never'}, ` +
          `Disk: ${diskStr}, ` +
          `Escalation: ${state.escalationNeeded ? 'YES — run cleo gc run' : 'no'}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Error reading GC status: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        {
          operation: 'gc.status',
        },
      );
      process.exit(1);
    }
  },
});

/** cleo gc worktrees — prune orphaned agent worktree directories */
const worktreesCommand = defineCommand({
  meta: {
    name: 'worktrees',
    description: 'Prune orphaned agent worktree directories (task IDs no longer active)',
  },
  args: {
    'worktrees-root': {
      type: 'string',
      description: 'Override the worktrees root directory',
    },
    'project-hash': {
      type: 'string',
      description: 'Scope pruning to a single project hash',
    },
    'preserve-tasks': {
      type: 'string',
      description: 'Comma-separated list of task IDs to preserve (default: none)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be pruned without deleting anything',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
    const worktreesRoot =
      (args['worktrees-root'] as string | undefined) ?? join(xdgData, 'cleo', 'worktrees');
    const projectHash = args['project-hash'] as string | undefined;
    const dryRun = args['dry-run'];

    // Build the preserve set from comma-separated --preserve-tasks.
    const preserveRaw = args['preserve-tasks'] as string | undefined;
    const activeTaskIds = new Set<string>(
      preserveRaw
        ? preserveRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    );

    try {
      const result = pruneOrphanWorktrees({
        worktreesRoot,
        projectHash,
        activeTaskIds,
        dryRun,
      });

      const dryLabel = dryRun ? ' (dry run)' : '';
      const humanMsg =
        `GC worktrees${dryLabel} — ` +
        `${dryRun ? 'Would remove' : 'Removed'}: ${result.removed} director${result.removed === 1 ? 'y' : 'ies'}` +
        (result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '');

      cliOutput(result, {
        command: 'gc',
        operation: 'gc.worktrees',
        message: humanMsg,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `GC worktrees failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'gc.worktrees' },
      );
      process.exit(1);
    }
  },
});

/** cleo gc temp — prune orphaned CLEO-generated temp directories */
const tempCommand = defineCommand({
  meta: {
    name: 'temp',
    description: 'Prune orphaned CLEO-generated temp directories from os.tmpdir()',
  },
  args: {
    'max-age-hours': {
      type: 'string',
      description: 'Maximum age (hours) before a temp dir is eligible for pruning (default: 2)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be pruned without deleting anything',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const maxAgeHoursRaw = args['max-age-hours'] as string | undefined;
    const maxAgeHours = maxAgeHoursRaw !== undefined ? Number(maxAgeHoursRaw) : 2;
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const dryRun = args['dry-run'];

    try {
      const result = pruneOrphanTempDirs({
        maxAgeMs,
        tempDir: tmpdir(),
        dryRun,
      });

      const dryLabel = dryRun ? ' (dry run)' : '';
      const humanMsg =
        `GC temp${dryLabel} — ` +
        `${dryRun ? 'Would remove' : 'Removed'}: ${result.removed} director${result.removed === 1 ? 'y' : 'ies'}, ` +
        `skipped: ${result.skipped}` +
        (result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '');

      cliOutput(result, {
        command: 'gc',
        operation: 'gc.temp',
        message: humanMsg,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `GC temp failed: ${message}`,
        'E_INTERNAL',
        { name: 'E_INTERNAL' },
        { operation: 'gc.temp' },
      );
      process.exit(1);
    }
  },
});

/**
 * Root GC command group — transcript garbage collection manual trigger and status.
 *
 * Subcommands dispatch directly to the GC runner and state reader without
 * going through the dispatch layer (GC is a local utility, not a domain operation).
 */
export const gcCommand = defineCommand({
  meta: {
    name: 'gc',
    description: 'Transcript garbage collection: manual trigger and status',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
    worktrees: worktreesCommand,
    temp: tempCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
