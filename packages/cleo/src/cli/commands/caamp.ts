/**
 * CLI caamp command group — CAAMP injection management.
 *
 * Subcommands:
 *   caamp dedupe [--file <path>]  — remove duplicate CAAMP injection blocks
 *
 * @task T1939
 * @epic T1929
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { humanLine } from '../renderers/index.js';

/** cleo caamp dedupe — deduplicate accumulated CAAMP injection blocks */
const dedupeCommand = defineCommand({
  meta: {
    name: 'dedupe',
    description: 'Remove duplicate CAAMP injection blocks from AGENTS.md files',
  },
  args: {
    file: {
      type: 'string',
      description:
        'Path to a specific AGENTS.md file to deduplicate (default: all standard locations)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be changed without writing',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const { dedupeFiles } = await import('@cleocode/caamp');

    // Resolve the list of files to process
    let filePaths: string[];

    if (args.file) {
      filePaths = [args.file];
    } else {
      // Default: cascade of standard AGENTS.md locations
      const home = homedir();
      filePaths = [
        join(home, '.agents', 'AGENTS.md'),
        // project-level AGENTS.md in cwd
        join(process.cwd(), 'AGENTS.md'),
      ];
    }

    if (args['dry-run']) {
      // Dry-run: parse and report without writing
      const { parseCaampBlocks } = await import('@cleocode/caamp');
      const { existsSync } = await import('node:fs');
      const { readFile } = await import('node:fs/promises');

      const dryResults: Array<{
        filePath: string;
        exists: boolean;
        blockCount: number;
        wouldRemove: number;
      }> = [];

      for (const filePath of filePaths) {
        if (!existsSync(filePath)) {
          dryResults.push({ filePath, exists: false, blockCount: 0, wouldRemove: 0 });
          continue;
        }
        const content = await readFile(filePath, 'utf-8');
        const blocks = parseCaampBlocks(content);
        const uniqueContents = new Set(blocks.map((b) => b.content));
        const wouldRemove = blocks.length - uniqueContents.size;
        dryResults.push({ filePath, exists: true, blockCount: blocks.length, wouldRemove });
      }

      if (args.json) {
        process.stdout.write(
          JSON.stringify({ success: true, data: { dryRun: true, files: dryResults } }, null, 2) +
            '\n',
        );
      } else {
        for (const r of dryResults) {
          if (!r.exists) {
            humanLine(`  (skip) ${r.filePath} — file not found`);
          } else if (r.wouldRemove === 0) {
            humanLine(`  (clean) ${r.filePath} — ${r.blockCount} block(s), no duplicates`);
          } else {
            humanLine(
              `  (would remove) ${r.filePath} — ${r.wouldRemove} duplicate(s) of ${r.blockCount} block(s)`,
            );
          }
        }
        const totalWould = dryResults.reduce((n, r) => n + r.wouldRemove, 0);
        humanLine(`\nDry run complete. Would remove ${totalWould} duplicate block(s).`);
      }
      return;
    }

    // Live run
    const results = await dedupeFiles(filePaths);

    const totalRemoved = results.reduce((n, r) => n + r.removed, 0);
    const filesModified = results.filter((r) => r.modified).length;

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            success: true,
            data: {
              dryRun: false,
              filesProcessed: results.length,
              filesModified,
              totalRemoved,
              files: results,
            },
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      for (const r of results) {
        if (r.removed === 0) {
          humanLine(`  (clean) ${r.filePath} — ${r.kept} block(s), no duplicates`);
        } else {
          humanLine(
            `  (fixed) ${r.filePath} — removed ${r.removed} duplicate(s), kept ${r.kept} block(s)`,
          );
        }
      }
      humanLine(`\nRemoved ${totalRemoved} duplicate block(s) from ${filesModified} file(s).`);
    }
  },
});

/**
 * Root caamp command group — CAAMP injection management.
 *
 * Provides utilities for managing CAAMP injection blocks in
 * provider instruction files (AGENTS.md, CLAUDE.md, etc.).
 *
 * @example
 * ```bash
 * cleo caamp dedupe
 * cleo caamp dedupe --file /home/user/.agents/AGENTS.md
 * cleo caamp dedupe --dry-run
 * ```
 *
 * @public
 */
export const caampCommand = defineCommand({
  meta: {
    name: 'caamp',
    description: 'CAAMP injection management: deduplicate blocks, inspect injection state',
  },
  subCommands: {
    dedupe: dedupeCommand,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    // Default: show help
    humanLine('Usage: cleo caamp <subcommand>');
    humanLine('');
    humanLine('Subcommands:');
    humanLine('  dedupe   Remove duplicate CAAMP injection blocks from AGENTS.md files');
  },
});
