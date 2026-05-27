#!/usr/bin/env node

/**
 * T733 Migration: Extract value from existing Claude session transcripts.
 *
 * Walks `~/.claude/projects/` and runs LLM extraction on all root-level
 * session JSONLs that have not yet been processed (no tombstone in brain.db).
 *
 * Usage:
 *   node scripts/extract-existing-transcripts.mjs [options]
 *
 * Options:
 *   --dry-run          Report what would happen without writing to brain.db
 *   --project-root     CLEO project root (default: process.cwd())
 *   --project-filter   Only process transcripts from a specific Claude project dir
 *                      (e.g. -mnt-projects-cleocode)
 *   --older-than-hours Only process sessions older than N hours (default: 24)
 *   --limit            Maximum number of sessions to process
 *   --tier             LLM tier to use: warm|cold (default: warm)
 *
 * Exit codes:
 *   0 — Success (even if some sessions failed — partial is OK)
 *   1 — Critical failure (e.g. project root not found)
 *
 * @task T733
 * @epic T726
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const result = {
    dryRun: false,
    projectRoot: cwd(),
    projectFilter: undefined,
    olderThanHours: 24,
    limit: undefined,
    tier: 'warm',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--project-root' && args[i + 1]) {
      result.projectRoot = resolve(args[++i]);
    } else if (arg === '--project-filter' && args[i + 1]) {
      result.projectFilter = args[++i];
    } else if (arg === '--older-than-hours' && args[i + 1]) {
      result.olderThanHours = Number.parseInt(args[++i], 10);
    } else if (arg === '--limit' && args[i + 1]) {
      result.limit = Number.parseInt(args[++i], 10);
    } else if (arg === '--tier' && args[i + 1]) {
      result.tier = args[++i];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Progress reporter
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(argv.slice(2));

  if (args.dryRun) {
    console.log('[T733] DRY RUN — no files will be deleted, no memories will be stored');
  }

  // Validate project root
  if (!existsSync(args.projectRoot)) {
    console.error(`[T733] Project root not found: ${args.projectRoot}`);
    exit(1);
  }

  console.log(`[T733] Project root: ${args.projectRoot}`);
  console.log(`[T733] LLM tier: ${args.tier}`);
  console.log(`[T733] Processing sessions older than ${args.olderThanHours}h`);
  if (args.projectFilter) {
    console.log(`[T733] Project filter: ${args.projectFilter}`);
  }

  // -------------------------------------------------------------------------
  // Discover transcripts
  // -------------------------------------------------------------------------
  const { listAllTranscripts } = await import(
    resolve(args.projectRoot, 'packages/core/dist/memory/transcript-scanner.js')
  ).catch(async () => {
    // Try source path if dist not built
    return import(resolve(args.projectRoot, 'packages/core/src/memory/transcript-scanner.ts'));
  });

  let transcripts;
  try {
    transcripts = await listAllTranscripts({
      olderThanHours: args.olderThanHours,
      projectFilter: args.projectFilter,
      limit: args.limit,
    });
  } catch (err) {
    console.error('[T733] Failed to list transcripts:', err.message ?? String(err));
    exit(1);
  }

  console.log(`[T733] Found ${transcripts.length} session JSONL files to process`);

  if (transcripts.length === 0) {
    console.log('[T733] Nothing to process.');
    exit(0);
  }

  // -------------------------------------------------------------------------
  // Extract each transcript
  // -------------------------------------------------------------------------
  const { extractTranscript } = await import(
    resolve(args.projectRoot, 'packages/core/dist/memory/transcript-extractor.js')
  ).catch(async () => {
    return import(resolve(args.projectRoot, 'packages/core/src/memory/transcript-extractor.ts'));
  });

  const stats = {
    processed: 0,
    skipped: 0,
    failed: 0,
    memoriesExtracted: 0,
    memoriesStored: 0,
    bytesFreed: 0,
  };

  for (let i = 0; i < transcripts.length; i++) {
    const entry = transcripts[i];
    const progress = `[${i + 1}/${transcripts.length}]`;

    console.log(
      `${progress} Processing ${entry.sessionId} (${formatBytes(entry.sizeBytes)}) from ${entry.projectDir}`,
    );

    try {
      const result = await extractTranscript({
        transcriptPath: entry.path,
        projectRoot: args.projectRoot,
        tier: args.tier,
        dryRun: args.dryRun,
        sessionId: entry.sessionId,
      });

      if (result.warnings.some((w) => w.includes('tombstone') || w.includes('Already extracted'))) {
        console.log(`  → Skipped (already processed)`);
        stats.skipped += 1;
        continue;
      }

      stats.processed += 1;
      stats.memoriesExtracted += result.extractedCount;
      stats.memoriesStored += result.storedCount;
      stats.bytesFreed += result.bytesFreed;

      console.log(
        `  → Backend: ${result.backend} | Extracted: ${result.extractedCount} | Stored: ${result.storedCount} | ${result.deleted ? `Deleted (${formatBytes(result.bytesFreed)} freed)` : args.dryRun ? 'dry-run' : 'kept'}`,
      );

      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          console.log(`  ⚠ ${w}`);
        }
      }
    } catch (err) {
      stats.failed += 1;
      console.log(`  → Failed: ${err.message ?? String(err)}`);
    }

    // Brief pause between sessions to avoid overwhelming brain.db
    if (i < transcripts.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // -------------------------------------------------------------------------
  // Summary report
  // -------------------------------------------------------------------------
  console.log('\n[T733] Migration Report:');
  console.log(`  Sessions processed:  ${stats.processed}`);
  console.log(`  Sessions skipped:    ${stats.skipped}`);
  console.log(`  Sessions failed:     ${stats.failed}`);
  console.log(`  Memories extracted:  ${stats.memoriesExtracted}`);
  console.log(`  Memories stored:     ${stats.memoriesStored}`);
  console.log(`  Bytes freed:         ${formatBytes(stats.bytesFreed)}`);

  if (args.dryRun) {
    console.log('\n[T733] DRY RUN complete — no changes were made.');
    console.log('[T733] Re-run without --dry-run to perform actual migration.');
  } else {
    console.log('\n[T733] Migration complete.');
  }

  exit(0);
}

main().catch((err) => {
  console.error('[T733] Fatal error:', err.message ?? String(err));
  exit(1);
});
