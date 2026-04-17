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
 * @see packages/cleo/src/gc/transcript.ts for scan/prune logic
 * @see docs/specs/memory-architecture-spec.md §6 and §9.1
 * @task T728 T730 T732 T733
 * @epic T726
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectRoot } from '@cleocode/core';
import { defineCommand } from 'citty';
import { parseDurationMs, pruneTranscripts, scanTranscripts } from '../../gc/transcript.js';

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
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope)',
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
        const envelope = { success: true, data: { count: pending.length, pending } };
        if (args.json) {
          process.stdout.write(JSON.stringify(envelope) + '\n');
        } else {
          process.stdout.write(`Sessions pending extraction: ${pending.length}\n`);
          for (const p of pending) {
            process.stdout.write(
              `  ${p.sessionId}  ${p.filePath || '(file not found)'}  queued: ${p.createdAt}\n`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
        if (args.json) {
          process.stdout.write(JSON.stringify(envelope) + '\n');
        } else {
          process.stderr.write(`Pending scan failed: ${message}\n`);
        }
        process.exit(1);
      }
      return;
    }

    const projectsDir = args['projects-dir'] ?? join(homedir(), '.claude', 'projects');

    try {
      const result = await scanTranscripts(projectsDir);

      const envelope = {
        success: true,
        data: {
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
      };

      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stdout.write(`Transcript scan results\n`);
        process.stdout.write(`=======================\n`);
        process.stdout.write(`Projects dir:  ${result.projectsDir}\n`);
        process.stdout.write(`Total sessions: ${result.totalSessions}\n`);
        process.stdout.write(
          `Total size:     ${(result.totalBytes / 1024 / 1024).toFixed(1)} MB\n`,
        );
        process.stdout.write(`\nTier breakdown:\n`);
        process.stdout.write(`  HOT  (0–24h): ${result.hot.length} sessions\n`);
        process.stdout.write(`  WARM (1–7d):  ${result.warm.length} sessions\n`);
        process.stdout.write(`  COLD (>7d):   (transcripts deleted; brain.db entries only)\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(`Scan failed: ${message}\n`);
      }
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
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope)',
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
          const envelope = {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Session JSONL not found for: ${args['session-id']}`,
            },
          };
          if (args.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Session not found: ${args['session-id']}\n`);
          }
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

      const envelope = {
        success: true,
        data: {
          sessionsProcessed: sessions.length,
          memoriesExtracted: totalExtracted,
          memoriesStored: totalStored,
          bytesFreed: totalBytesFreed,
          dryRun,
          results,
        },
      };

      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        const dryLabel = dryRun ? ' (dry run)' : '';
        process.stdout.write(`Transcript extraction complete${dryLabel}\n`);
        process.stdout.write(`Sessions:  ${sessions.length}\n`);
        process.stdout.write(`Extracted: ${totalExtracted} memories\n`);
        process.stdout.write(`Stored:    ${totalStored} memories\n`);
        process.stdout.write(`Freed:     ${(totalBytesFreed / 1024 / 1024).toFixed(1)} MB\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(`Extract failed: ${message}\n`);
      }
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
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope)',
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

      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            success: true,
            data: { discovered: transcripts.length, message: 'Starting migration...' },
          }) + '\n',
        );
      } else {
        process.stdout.write(
          `Migrating ${transcripts.length} session transcripts${dryRun ? ' (dry run)' : ''}...\n`,
        );
      }

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

      const envelope = {
        success: true,
        data: {
          sessionsProcessed: processed,
          sessionsSkipped: skipped,
          sessionsFailed: failed,
          memoriesExtracted,
          memoriesStored,
          bytesFreed,
          mbFreed: Number.parseFloat((bytesFreed / 1024 / 1024).toFixed(2)),
          dryRun,
        },
      };

      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        const dryLabel = dryRun ? ' (dry run — no changes written)' : '';
        process.stdout.write(`Migration complete${dryLabel}\n`);
        process.stdout.write(`Processed: ${processed}  Skipped: ${skipped}  Failed: ${failed}\n`);
        process.stdout.write(`Memories extracted: ${memoriesExtracted}\n`);
        process.stdout.write(`Memories stored:    ${memoriesStored}\n`);
        process.stdout.write(`Bytes freed:        ${(bytesFreed / 1024 / 1024).toFixed(1)} MB\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(`Migration failed: ${message}\n`);
      }
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
    json: {
      type: 'boolean',
      description: 'Output result as JSON (LAFS envelope)',
    },
  },
  async run({ args }) {
    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const confirm = args.confirm ?? false;

    if (!confirm && !isTTY) {
      const envelope = {
        success: false,
        error: {
          code: 'E_INVALID_INPUT',
          message:
            'Non-interactive mode requires --confirm flag to perform deletion. ' +
            'Use --confirm to bypass the dry-run. Without --confirm, a dry-run report is printed.',
        },
      };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(
          `Deletion requires --confirm in non-interactive mode. Re-run with --confirm to delete.\n`,
        );
      }
      process.exit(0);
    }

    let olderThanMs: number;
    try {
      olderThanMs = parseDurationMs(args['older-than']);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      const envelope = { success: false, error: { code: 'E_INVALID_INPUT', message } };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(`Invalid duration: ${message}\n`);
      }
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

      const envelope = {
        success: true,
        data: {
          pruned: pruneResult.pruned,
          bytesFreed: pruneResult.bytesFreed,
          mbFreed: Number.parseFloat((pruneResult.bytesFreed / 1024 / 1024).toFixed(2)),
          dryRun: pruneResult.dryRun,
          deletedPaths: pruneResult.deletedPaths,
        },
      };

      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        const dryLabel = pruneResult.dryRun ? ' (dry run — use --confirm to delete)' : '';
        process.stdout.write(`Transcript prune${dryLabel}\n`);
        process.stdout.write(`Older than:   ${args['older-than']}\n`);
        process.stdout.write(`Sessions:     ${pruneResult.pruned}\n`);
        process.stdout.write(
          `Bytes freed:  ${(pruneResult.bytesFreed / 1024 / 1024).toFixed(1)} MB\n`,
        );
        if (pruneResult.deletedPaths.length > 0 && pruneResult.dryRun) {
          process.stdout.write(`\nWould delete (${pruneResult.deletedPaths.length} paths):\n`);
          for (const p of pruneResult.deletedPaths.slice(0, 10)) {
            process.stdout.write(`  ${p}\n`);
          }
          if (pruneResult.deletedPaths.length > 10) {
            process.stdout.write(`  ... and ${pruneResult.deletedPaths.length - 10} more\n`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
      if (args.json) {
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stderr.write(`Prune failed: ${message}\n`);
      }
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
});
