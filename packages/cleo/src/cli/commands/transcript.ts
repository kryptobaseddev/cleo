/**
 * CLI command: cleo transcript
 *
 * Transcript lifecycle management: inventory, extraction, and pruning.
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
import { parseDurationMs, pruneTranscripts, scanTranscripts } from '../../gc/transcript.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo transcript` command group.
 *
 * @param program - Root CLI command to attach to
 */
export function registerTranscriptCommand(program: Command): void {
  const transcript = program
    .command('transcript')
    .description('Transcript lifecycle management: scan, extract, and prune session transcripts');

  // ---------------------------------------------------------------------------
  // cleo transcript scan
  // ---------------------------------------------------------------------------

  transcript
    .command('scan')
    .description('Inventory all session transcripts with hot/warm/cold tier breakdown')
    .option('--projects-dir <path>', 'Override ~/.claude/projects/ path')
    .option('--pending', 'List sessions queued for warm-tier extraction (T732)')
    .option('--json', 'Output result as JSON (LAFS envelope)')
    .action(async (opts: { projectsDir?: string; pending?: boolean; json?: boolean }) => {
      // T732: --pending mode reads brain_observations for queued sessions
      if (opts.pending) {
        try {
          const projectRoot = getProjectRoot();
          const { scanPendingTranscripts } = await import(
            '@cleocode/core/memory/transcript-scanner.js'
          );
          const pending = await scanPendingTranscripts(projectRoot);
          const envelope = { success: true, data: { count: pending.length, pending } };
          if (opts.json) {
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
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Pending scan failed: ${message}\n`);
          }
          process.exit(1);
        }
        return;
      }

      const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');

      try {
        const result = await scanTranscripts(projectsDir);

        // LAFS envelope (ADR-039)
        const envelope = {
          success: true,
          data: {
            totalSessions: result.totalSessions,
            totalBytes: result.totalBytes,
            totalMB: parseFloat((result.totalBytes / 1024 / 1024).toFixed(2)),
            hot: {
              count: result.hot.length,
              sessions: result.hot.map((s) => ({
                sessionId: s.sessionId,
                projectSlug: s.projectSlug,
                ageHours: parseFloat((s.ageMs / 3600_000).toFixed(1)),
                bytes: s.bytes + s.sessionDirBytes,
              })),
            },
            warm: {
              count: result.warm.length,
              sessions: result.warm.map((s) => ({
                sessionId: s.sessionId,
                projectSlug: s.projectSlug,
                ageDays: parseFloat((s.ageMs / 86_400_000).toFixed(1)),
                bytes: s.bytes + s.sessionDirBytes,
              })),
            },
            projectsDir: result.projectsDir,
          },
        };

        if (opts.json) {
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
        if (opts.json) {
          process.stdout.write(JSON.stringify(envelope) + '\n');
        } else {
          process.stderr.write(`Scan failed: ${message}\n`);
        }
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------------
  // cleo transcript extract <session-id>
  // ---------------------------------------------------------------------------

  transcript
    .command('extract')
    .argument('[session-id]', 'Session UUID to extract (omit for --all-warm)')
    .description('Run LLM extraction on a session transcript and write memories to brain.db')
    .option('--all-warm', 'Extract all warm-tier sessions (1–7d old)')
    .option('--tier <tier>', 'LLM tier: warm (default) or cold (Sonnet)', 'warm')
    .option('--dry-run', 'Report without writing to brain.db or deleting JSONL')
    .option('--projects-dir <path>', 'Override ~/.claude/projects/ path')
    .option('--json', 'Output result as JSON (LAFS envelope)')
    .action(
      async (
        sessionId: string | undefined,
        opts: {
          allWarm?: boolean;
          tier?: string;
          dryRun?: boolean;
          projectsDir?: string;
          json?: boolean;
        },
      ) => {
        const tier = (opts.tier ?? 'warm') as 'warm' | 'cold';
        const dryRun = opts.dryRun ?? false;
        const projectRoot = getProjectRoot();

        try {
          const { extractTranscript } = await import(
            '@cleocode/core/memory/transcript-extractor.js'
          );
          const { findSessionTranscriptPath, listAllTranscripts } = await import(
            '@cleocode/core/memory/transcript-scanner.js'
          );

          // Collect sessions to process
          const sessions: Array<{ sessionId: string; path: string }> = [];

          if (opts.allWarm) {
            const allTranscripts = await listAllTranscripts({ olderThanHours: 1 });
            for (const t of allTranscripts) {
              sessions.push({ sessionId: t.sessionId, path: t.path });
            }
          } else if (sessionId) {
            const path = await findSessionTranscriptPath(sessionId);
            if (!path) {
              const envelope = {
                success: false,
                error: {
                  code: 'E_NOT_FOUND',
                  message: `Session JSONL not found for: ${sessionId}`,
                },
              };
              if (opts.json) {
                process.stdout.write(JSON.stringify(envelope) + '\n');
              } else {
                process.stderr.write(`Session not found: ${sessionId}\n`);
              }
              process.exit(4);
              return;
            }
            sessions.push({ sessionId, path });
          } else {
            process.stderr.write(
              'Provide a session-id or use --all-warm to extract all warm sessions\n',
            );
            process.exit(2);
            return;
          }

          const results = [];
          let totalExtracted = 0;
          let totalStored = 0;
          let totalBytesFreed = 0;

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

          if (opts.json) {
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
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Extract failed: ${message}\n`);
          }
          process.exit(1);
        }
      },
    );

  // ---------------------------------------------------------------------------
  // cleo transcript migrate (T733)
  // ---------------------------------------------------------------------------

  transcript
    .command('migrate')
    .description('Backfill extraction from existing ~/.claude/projects/ session JSONLs (T733)')
    .option('--dry-run', 'Report without writing to brain.db or deleting JSONLs')
    .option('--tier <tier>', 'LLM tier: warm (default) or cold (Sonnet)', 'warm')
    .option('--older-than-hours <hours>', 'Only process sessions older than N hours', '24')
    .option('--project-filter <slug>', 'Limit to a specific Claude project directory slug')
    .option('--limit <n>', 'Maximum number of sessions to process')
    .option('--json', 'Output result as JSON (LAFS envelope)')
    .action(
      async (opts: {
        dryRun?: boolean;
        tier?: string;
        olderThanHours?: string;
        projectFilter?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const tier = (opts.tier ?? 'warm') as 'warm' | 'cold';
        const dryRun = opts.dryRun ?? false;
        const olderThanHours = opts.olderThanHours ? Number.parseInt(opts.olderThanHours, 10) : 24;
        const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
        const projectRoot = getProjectRoot();

        try {
          const { extractTranscript } = await import(
            '@cleocode/core/memory/transcript-extractor.js'
          );
          const { listAllTranscripts } = await import(
            '@cleocode/core/memory/transcript-scanner.js'
          );

          const transcripts = await listAllTranscripts({
            olderThanHours,
            projectFilter: opts.projectFilter,
            limit,
          });

          if (opts.json) {
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

              if (result.warnings.some((w) => w.includes('Already extracted'))) {
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
              mbFreed: parseFloat((bytesFreed / 1024 / 1024).toFixed(2)),
              dryRun,
            },
          };

          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            const dryLabel = dryRun ? ' (dry run — no changes written)' : '';
            process.stdout.write(`Migration complete${dryLabel}\n`);
            process.stdout.write(
              `Processed: ${processed}  Skipped: ${skipped}  Failed: ${failed}\n`,
            );
            process.stdout.write(`Memories extracted: ${memoriesExtracted}\n`);
            process.stdout.write(`Memories stored:    ${memoriesStored}\n`);
            process.stdout.write(
              `Bytes freed:        ${(bytesFreed / 1024 / 1024).toFixed(1)} MB\n`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const envelope = { success: false, error: { code: 'E_INTERNAL', message } };
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Migration failed: ${message}\n`);
          }
          process.exit(1);
        }
      },
    );

  // ---------------------------------------------------------------------------
  // cleo transcript prune
  // ---------------------------------------------------------------------------

  transcript
    .command('prune')
    .description('Prune session transcripts older than the specified duration. Dry-run by default.')
    .requiredOption(
      '--older-than <duration>',
      'Delete sessions older than this (e.g. 7d, 24h, 30m)',
    )
    .option(
      '--confirm',
      'Perform actual deletion. Without this flag, the command dry-runs and reports what would be deleted.',
    )
    .option('--projects-dir <path>', 'Override ~/.claude/projects/ path')
    .option('--json', 'Output result as JSON (LAFS envelope)')
    .action(
      async (opts: {
        olderThan: string;
        confirm?: boolean;
        projectsDir?: string;
        json?: boolean;
      }) => {
        const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        const confirm = opts.confirm ?? false;

        // In non-TTY context (CI, headless agents), auto-confirm only for URGENT+ disk pressure.
        // For standard prune calls without --confirm in non-TTY, still require explicit opt-in.
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
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(
              `Deletion requires --confirm in non-interactive mode. Re-run with --confirm to delete.\n`,
            );
          }
          // Exit 0 (not an error — just informational dry-run behaviour)
          process.exit(0);
        }

        let olderThanMs: number;
        try {
          olderThanMs = parseDurationMs(opts.olderThan);
        } catch (parseErr) {
          const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
          const envelope = { success: false, error: { code: 'E_INVALID_INPUT', message } };
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Invalid duration: ${message}\n`);
          }
          process.exit(2);
          return;
        }

        const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');

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
              mbFreed: parseFloat((pruneResult.bytesFreed / 1024 / 1024).toFixed(2)),
              dryRun: pruneResult.dryRun,
              deletedPaths: pruneResult.deletedPaths,
            },
          };

          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            const dryLabel = pruneResult.dryRun ? ' (dry run — use --confirm to delete)' : '';
            process.stdout.write(`Transcript prune${dryLabel}\n`);
            process.stdout.write(`Older than:   ${opts.olderThan}\n`);
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
          if (opts.json) {
            process.stdout.write(JSON.stringify(envelope) + '\n');
          } else {
            process.stderr.write(`Prune failed: ${message}\n`);
          }
          process.exit(1);
        }
      },
    );
}
