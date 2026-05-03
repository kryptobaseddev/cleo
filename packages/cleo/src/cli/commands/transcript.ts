/**
 * CLI command group for transcript lifecycle management.
 *
 * Subcommands:
 *   cleo transcript scan                           — inventory hot/warm sessions
 *   cleo transcript scan --pending                 — list sessions queued for extraction (T732)
 *   cleo transcript extract <session-id>           — run LLM extraction on one session (T730)
 *   cleo transcript migrate                        — backfill existing sessions (T733)
 *   cleo transcript prune --older-than <duration>  — prune old transcripts
 *
 * All commands respect LAFS envelope format (ADR-039).
 *
 * Storage layout scanned (memory-architecture-spec.md §6.2):
 * ```
 * ~/.claude/projects/<project-slug>/
 *   <session-uuid>.jsonl              ← root-level session transcript
 *   <session-uuid>/subagents/         ← subagent transcripts
 *   <session-uuid>/tool-results/      ← raw tool results (pruned with session)
 * ```
 *
 * @see packages/core/src/gc/transcript.ts for scan/prune logic
 * @see docs/specs/memory-architecture-spec.md §6 and §9.1
 * @task T728 T730 T732 T733 T1723
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectRoot } from '@cleocode/core';
import {
  parseDurationMs,
  pruneTranscripts,
  scanTranscripts,
} from '@cleocode/core/gc/transcript.js';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/** cleo transcript scan — inventory all session transcripts with hot/warm/cold tier breakdown */
const scanCommand = defineCommand({
  meta: {
    name: 'scan',
    description: 'Inventory all session transcripts with hot/warm/cold tier breakdown',
  },
  args: {
    'projects-dir': {
      type: 'string',
      description: 'Override ~/.claude/projects/ path',
    },
    pending: {
      type: 'boolean',
      description: 'List sessions queued for warm-tier extraction (T732)',
    },
  },
  async run({ args }) {
    if (args.pending) {
      try {
        const projectRoot = getProjectRoot();
        const { scanPendingTranscripts } = await import(
          '@cleocode/core/memory/transcript-scanner.js'
        );
        const pending = await scanPendingTranscripts(projectRoot);
        cliOutput(
          { count: pending.length, pending },
          {
            command: 'transcript',
            operation: 'transcript.scan',
            message: `Sessions pending extraction: ${pending.length}`,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cliError(
          'Pending scan failed',
          'E_INTERNAL',
          { name: 'E_INTERNAL', details: message },
          { operation: 'transcript.scan' },
        );
        process.exit(1);
      }
      return;
    }

    const projectsDir = args['projects-dir'] ?? join(homedir(), '.claude', 'projects');

    try {
      const result = await scanTranscripts(projectsDir);

      cliOutput(
        {
          totalSessions: result.totalSessions,
          totalBytes: result.totalBytes,
          totalMB: Number.parseFloat((result.totalBytes / 1024 / 1024).toFixed(2)),
          hot: {
            count: result.hot.length,
            sessions: result.hot.map((s) => ({
              sessionId: s.sessionId,
              projectSlug: s.projectSlug,
              ageHours: Number.parseFloat((s.ageMs / 3600_000).toFixed(1)),
              bytes: s.bytes + s.sessionDirBytes,
            })),
          },
          warm: {
            count: result.warm.length,
            sessions: result.warm.map((s) => ({
              sessionId: s.sessionId,
              projectSlug: s.projectSlug,
              ageDays: Number.parseFloat((s.ageMs / 86_400_000).toFixed(1)),
              bytes: s.bytes + s.sessionDirBytes,
            })),
          },
          projectsDir: result.projectsDir,
        },
        { command: 'transcript', operation: 'transcript.scan' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        'Scan failed',
        'E_INTERNAL',
        { name: 'E_INTERNAL', details: message },
        { operation: 'transcript.scan' },
      );
      process.exit(1);
    }
  },
});

/** cleo transcript extract — run LLM extraction on a session transcript */
const extractCommand = defineCommand({
  meta: {
    name: 'extract',
    description: 'Run LLM extraction on a session transcript and write memories to brain.db',
  },
  args: {
    'session-id': {
      type: 'positional',
      description: 'Session UUID to extract (omit for --all-warm)',
      required: false,
    },
    'all-warm': {
      type: 'boolean',
      description: 'Extract all warm-tier sessions (1–7d old)',
    },
    tier: {
      type: 'string',
      description: 'LLM tier: warm (default) or cold (Sonnet)',
      default: 'warm',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report without writing to brain.db or deleting JSONL',
    },
    'projects-dir': {
      type: 'string',
      description: 'Override ~/.claude/projects/ path',
    },
  },
  async run({ args }) {
    const tier = (args.tier ?? 'warm') as 'warm' | 'cold';
    const dryRun = args['dry-run'] ?? false;
    const projectRoot = getProjectRoot();

    try {
      const { extractTranscript } = await import('@cleocode/core/memory/transcript-extractor.js');
      const { findSessionTranscriptPath, listAllTranscripts } = await import(
        '@cleocode/core/memory/transcript-scanner.js'
      );

      const sessions: Array<{ sessionId: string; path: string }> = [];

      if (args['all-warm']) {
        const allTranscripts = await listAllTranscripts({ olderThanHours: 1 });
        for (const t of allTranscripts) {
          sessions.push({ sessionId: t.sessionId, path: t.path });
        }
      } else if (args['session-id']) {
        const path = await findSessionTranscriptPath(args['session-id']);
        if (!path) {
          cliError(
            `Session JSONL not found for: ${args['session-id']}`,
            4,
            { name: 'E_NOT_FOUND' },
            { operation: 'transcript.extract' },
          );
          process.exit(4);
          return;
        }
        sessions.push({ sessionId: args['session-id'], path });
      } else {
        process.stderr.write(
          'Provide a session-id or use --all-warm to extract all warm sessions\n',
        );
        process.exit(2);
        return;
      }

      let totalExtracted = 0;
      let totalStored = 0;
      let totalBytesFreed = 0;
      const results = [];

      for (const session of sessions) {
        const result = await extractTranscript({
          transcriptPath: session.path,
          projectRoot,
          tier,
          dryRun,
          sessionId: session.sessionId,
        });
        results.push(result);
        totalExtracted += result.extractedCount;
        totalStored += result.storedCount;
        totalBytesFreed += result.bytesFreed;
      }

      const dryLabel = dryRun ? ' (dry run)' : '';
      cliOutput(
        {
          sessionsProcessed: sessions.length,
          memoriesExtracted: totalExtracted,
          memoriesStored: totalStored,
          bytesFreed: totalBytesFreed,
          dryRun,
          results,
        },
        {
          command: 'transcript',
          operation: 'transcript.extract',
          message: `Transcript extraction complete${dryLabel}`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        'Extract failed',
        'E_INTERNAL',
        { name: 'E_INTERNAL', details: message },
        { operation: 'transcript.extract' },
      );
      process.exit(1);
    }
  },
});

/** cleo transcript migrate — backfill extraction from existing session JSONLs (T733) */
const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description: 'Backfill extraction from existing ~/.claude/projects/ session JSONLs (T733)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Report without writing to brain.db or deleting JSONLs',
    },
    tier: {
      type: 'string',
      description: 'LLM tier: warm (default) or cold (Sonnet)',
      default: 'warm',
    },
    'older-than-hours': {
      type: 'string',
      description: 'Only process sessions older than N hours',
      default: '24',
    },
    'project-filter': {
      type: 'string',
      description: 'Limit to a specific Claude project directory slug',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of sessions to process',
    },
  },
  async run({ args }) {
    const tier = (args.tier ?? 'warm') as 'warm' | 'cold';
    const dryRun = args['dry-run'] ?? false;
    const olderThanHours = args['older-than-hours']
      ? Number.parseInt(args['older-than-hours'], 10)
      : 24;
    const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
    const projectRoot = getProjectRoot();

    try {
      const { extractTranscript } = await import('@cleocode/core/memory/transcript-extractor.js');
      const { listAllTranscripts } = await import('@cleocode/core/memory/transcript-scanner.js');

      const transcripts = await listAllTranscripts({
        olderThanHours,
        projectFilter: args['project-filter'] as string | undefined,
        limit,
      });

      // Emit discovery count immediately so callers know how many sessions will be processed
      cliOutput(
        { discovered: transcripts.length, message: 'Starting migration...' },
        {
          command: 'transcript',
          operation: 'transcript.migrate',
          message: `Migrating ${transcripts.length} session transcripts${dryRun ? ' (dry run)' : ''}...`,
        },
      );

      let memoriesExtracted = 0;
      let memoriesStored = 0;
      let bytesFreed = 0;
      let processed = 0;
      let skipped = 0;
      let failed = 0;

      for (const entry of transcripts) {
        try {
          const result = await extractTranscript({
            transcriptPath: entry.path,
            projectRoot,
            tier,
            dryRun,
            sessionId: entry.sessionId,
          });

          if (result.warnings.some((w: string) => w.includes('Already extracted'))) {
            skipped += 1;
          } else {
            processed += 1;
            memoriesExtracted += result.extractedCount;
            memoriesStored += result.storedCount;
            bytesFreed += result.bytesFreed;
          }
        } catch {
          failed += 1;
        }
      }

      const dryLabel = dryRun ? ' (dry run — no changes written)' : '';
      cliOutput(
        {
          sessionsProcessed: processed,
          sessionsSkipped: skipped,
          sessionsFailed: failed,
          memoriesExtracted,
          memoriesStored,
          bytesFreed,
          mbFreed: Number.parseFloat((bytesFreed / 1024 / 1024).toFixed(2)),
          dryRun,
        },
        {
          command: 'transcript',
          operation: 'transcript.migrate',
          message: `Migration complete${dryLabel}`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        'Migration failed',
        'E_INTERNAL',
        { name: 'E_INTERNAL', details: message },
        { operation: 'transcript.migrate' },
      );
      process.exit(1);
    }
  },
});

/** cleo transcript prune — prune session transcripts older than the specified duration */
const pruneCommand = defineCommand({
  meta: {
    name: 'prune',
    description: 'Prune session transcripts older than the specified duration. Dry-run by default.',
  },
  args: {
    'older-than': {
      type: 'string',
      description: 'Delete sessions older than this (e.g. 7d, 24h, 30m)',
      required: true,
    },
    confirm: {
      type: 'boolean',
      description: 'Perform actual deletion. Without this flag, the command dry-runs.',
    },
    'projects-dir': {
      type: 'string',
      description: 'Override ~/.claude/projects/ path',
    },
  },
  async run({ args }) {
    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const confirm = args.confirm ?? false;

    if (!confirm && !isTTY) {
      cliError(
        'Non-interactive mode requires --confirm flag to perform deletion. ' +
          'Use --confirm to bypass the dry-run. Without --confirm, a dry-run report is printed.',
        'E_INVALID_INPUT',
        { name: 'E_INVALID_INPUT' },
        { operation: 'transcript.prune' },
      );
      process.exit(0);
    }

    let olderThanMs: number;
    try {
      olderThanMs = parseDurationMs(args['older-than']);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      cliError(
        `Invalid duration: ${message}`,
        'E_INVALID_INPUT',
        { name: 'E_INVALID_INPUT' },
        { operation: 'transcript.prune' },
      );
      process.exit(2);
      return;
    }

    const projectsDir = args['projects-dir'] ?? join(homedir(), '.claude', 'projects');

    try {
      const pruneResult = await pruneTranscripts({
        olderThanMs,
        confirm,
        projectsDir,
      });

      const dryLabel = pruneResult.dryRun ? ' (dry run — use --confirm to delete)' : '';
      cliOutput(
        {
          pruned: pruneResult.pruned,
          bytesFreed: pruneResult.bytesFreed,
          mbFreed: Number.parseFloat((pruneResult.bytesFreed / 1024 / 1024).toFixed(2)),
          dryRun: pruneResult.dryRun,
          deletedPaths: pruneResult.deletedPaths,
        },
        {
          command: 'transcript',
          operation: 'transcript.prune',
          message: `Transcript prune${dryLabel}`,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        'Prune failed',
        'E_INTERNAL',
        { name: 'E_INTERNAL', details: message },
        { operation: 'transcript.prune' },
      );
      process.exit(1);
    }
  },
});

/**
 * Root transcript command group — scan, extract, migrate, and prune session transcripts.
 *
 * Dispatches transcript lifecycle operations per memory-architecture-spec.md §6 and §9.1.
 */
export const transcriptCommand = defineCommand({
  meta: {
    name: 'transcript',
    description: 'Transcript lifecycle management: scan, extract, and prune session transcripts',
  },
  subCommands: {
    scan: scanCommand,
    extract: extractCommand,
    migrate: migrateCommand,
    prune: pruneCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
