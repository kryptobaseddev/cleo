/**
 * CLI docs command - attachment management + documentation drift detection.
 *
 * Subcommands (T797):
 *   cleo docs add <ownerId> <file|--url <url>> [--desc "..."] [--labels tag1,tag2]
 *   cleo docs list [--task T###] [--session ses_*] [--observation O###]
 *   cleo docs fetch <attachmentId|sha256>
 *   cleo docs remove <attachmentId|sha256> --from <ownerId>
 *
 * Legacy subcommands (T4551):
 *   cleo docs sync       — drift detection between scripts and docs index
 *   cleo docs gap-check  — validate knowledge transfer from review docs
 *
 * @task T4551 (sync/gap-check), T797 (add/list/fetch/remove)
 * @epic T4545 (legacy), T760 (attachments)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CleoError, formatError, getAgentOutputsAbsolute, readJson } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/** Drift detection result. */
interface DriftResult {
  status: 'clean' | 'warning' | 'error';
  missingFromIndex: string[];
  missingFromScripts: string[];
  warnings: string[];
}

/**
 * Get list of script files from scripts/ directory.
 * @task T4551
 */
async function getScriptNames(projectRoot: string): Promise<string[]> {
  const scriptsDir = join(projectRoot, 'scripts');
  try {
    const files = await readdir(scriptsDir);
    return files
      .filter((f) => f.endsWith('.sh'))
      .map((f) => f.replace('.sh', ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get command names from COMMANDS-INDEX.json.
 * @task T4551
 */
async function getIndexedCommands(projectRoot: string): Promise<string[]> {
  const indexPath = join(projectRoot, 'docs', 'commands', 'COMMANDS-INDEX.json');
  const index = await readJson<{ commands: Array<{ name: string }> }>(indexPath);
  if (!index) return [];
  return index.commands.map((c) => c.name).sort();
}

/**
 * Run drift detection between scripts and documentation index.
 * @task T4551
 */
async function detectDrift(projectRoot: string): Promise<DriftResult> {
  const scripts = await getScriptNames(projectRoot);
  const indexed = await getIndexedCommands(projectRoot);

  const scriptSet = new Set(scripts);
  const indexSet = new Set(indexed);

  const missingFromIndex = scripts.filter((s) => !indexSet.has(s));
  const missingFromScripts = indexed.filter((i) => !scriptSet.has(i));
  const warnings: string[] = [];

  if (missingFromIndex.length > 0) {
    warnings.push(`${missingFromIndex.length} scripts not in COMMANDS-INDEX.json`);
  }
  if (missingFromScripts.length > 0) {
    warnings.push(`${missingFromScripts.length} index entries without scripts`);
  }

  let status: 'clean' | 'warning' | 'error' = 'clean';
  if (missingFromIndex.length > 0 || missingFromScripts.length > 0) {
    status = missingFromIndex.length > 5 ? 'error' : 'warning';
  }

  return { status, missingFromIndex, missingFromScripts, warnings };
}

/** Gap check result for a review document. */
interface GapEntry {
  file: string;
  taskId: string;
  gaps: string[];
}

/**
 * Run gap-check validation for review docs.
 * @task T4551
 */
async function runGapCheck(_projectRoot: string, filterId?: string): Promise<GapEntry[]> {
  const reviewDir = getAgentOutputsAbsolute();
  const results: GapEntry[] = [];

  try {
    const files = await readdir(reviewDir);
    const reviewFiles = files.filter((f) => f.endsWith('.md'));

    for (const file of reviewFiles) {
      // Check filter
      if (filterId && !file.includes(filterId)) continue;

      const filePath = join(reviewDir, file);
      const content = await readFile(filePath, 'utf-8');

      // Extract task ID from filename (e.g., T2402-protocol-spec.md)
      const taskMatch = file.match(/^(T\d+)/);
      const taskId = taskMatch ? taskMatch[1] : 'UNKNOWN';

      const gaps: string[] = [];

      // Check for required sections
      if (!content.includes('## Summary')) {
        gaps.push('Missing ## Summary section');
      }
      if (!content.includes('**Task**:') && !content.includes('**Task:**')) {
        gaps.push('Missing Task provenance header');
      }

      if (gaps.length > 0) {
        results.push({ file, taskId, gaps });
      }
    }
  } catch {
    // Review directory might not exist
  }

  return results;
}

/**
 * Register the docs command.
 * @task T4551 (sync/gap-check), T797 (add/list/fetch/remove)
 */
export function registerDocsCommand(program: Command): void {
  const docsCmd = program
    .command('docs')
    .description(
      'Documentation attachment management (add/list/fetch/remove) and drift detection (sync/gap-check)',
    );

  // ── cleo docs add <ownerId> [<file>] [--url <url>] ────────────────────────
  docsCmd
    .command('add <owner-id> [file]')
    .description(
      'Attach a local file or remote URL to a CLEO entity (task, session, observation). ' +
        'Owner type is inferred from the ID prefix: T### → task, ses_* → session, O-* → observation.',
    )
    .option('--url <url>', 'Remote URL to attach (instead of a local file)')
    .option('--desc <text>', 'Free-text description of this attachment')
    .option('--labels <tags>', 'Comma-separated labels (e.g. rfc,spec)')
    .option(
      '--attached-by <agent>',
      'Agent identity that created the attachment (default: "human")',
    )
    .action(async (ownerId: string, file: string | undefined, opts: Record<string, unknown>) => {
      const url = opts['url'] as string | undefined;
      const fileArg = file ?? (opts['file'] as string | undefined);

      if (!fileArg && !url) {
        process.stderr.write(
          'Error: provide a file path (positional argument) or --url <url>\n' +
            'Example: cleo docs add T123 docs/rfc.md --desc "RFC draft"\n' +
            '         cleo docs add T123 --url https://example.com/spec\n',
        );
        process.exit(6);
      }

      await dispatchFromCli(
        'mutate',
        'docs',
        'add',
        {
          ownerId,
          ...(fileArg ? { file: fileArg } : {}),
          ...(url ? { url } : {}),
          ...(opts['desc'] ? { desc: opts['desc'] } : {}),
          ...(opts['labels'] ? { labels: opts['labels'] } : {}),
          ...(opts['attachedBy'] ? { attachedBy: opts['attachedBy'] } : {}),
        },
        { command: 'docs add' },
      );
    });

  // ── cleo docs list [--task T###] [--session ses_*] [--observation O###] ───
  docsCmd
    .command('list')
    .description(
      'List attachments for a CLEO entity. Provide exactly one of --task, --session, or --observation.',
    )
    .option('--task <id>', 'Filter by task ID (e.g. T123)')
    .option('--session <id>', 'Filter by session ID (e.g. ses_abc123)')
    .option('--observation <id>', 'Filter by observation ID (e.g. O-abc123)')
    .action(async (opts: Record<string, unknown>) => {
      const task = opts['task'] as string | undefined;
      const session = opts['session'] as string | undefined;
      const observation = opts['observation'] as string | undefined;

      if (!task && !session && !observation) {
        process.stderr.write(
          'Error: provide one of --task <id>, --session <id>, or --observation <id>\n',
        );
        process.exit(6);
      }

      await dispatchFromCli(
        'query',
        'docs',
        'list',
        {
          ...(task ? { task } : {}),
          ...(session ? { session } : {}),
          ...(observation ? { observation } : {}),
        },
        { command: 'docs list' },
      );
    });

  // ── cleo docs fetch <attachmentId|sha256> ─────────────────────────────────
  docsCmd
    .command('fetch <attachment-ref>')
    .description(
      'Retrieve attachment metadata and bytes by attachment ID (att_*) or SHA-256 hex. ' +
        'Files <= 1 MB are returned base64-encoded inline; larger files report the storage path only.',
    )
    .action(async (attachmentRef: string) => {
      await dispatchFromCli('query', 'docs', 'fetch', { attachmentRef }, { command: 'docs fetch' });
    });

  // ── cleo docs remove <attachmentId|sha256> --from <ownerId> ───────────────
  docsCmd
    .command('remove <attachment-ref>')
    .description(
      'Remove an attachment ref from an owner entity. ' +
        'When refCount reaches zero the blob file is purged from disk.',
    )
    .option('--from <owner-id>', 'Owner entity ID to remove the attachment ref from (required)')
    .action(async (attachmentRef: string, opts: Record<string, unknown>) => {
      const from = opts['from'] as string | undefined;
      if (!from) {
        process.stderr.write('Error: --from <ownerId> is required\n');
        process.exit(6);
      }

      await dispatchFromCli(
        'mutate',
        'docs',
        'remove',
        { attachmentRef, from },
        { command: 'docs remove' },
      );
    });

  // ── cleo docs generate --for <id> [--attach] ──────────────────────────────
  docsCmd
    .command('generate')
    .description(
      'Generate an llms.txt-format document summarising all attachments on a CLEO entity. ' +
        'Internally uses the llmtxt npm package for structural section analysis; ' +
        'falls back to a built-in generator when unavailable. ' +
        'Use --attach to save the output back as an llms-txt attachment on the same entity.',
    )
    .requiredOption('--for <id>', 'Target entity ID (task, session, or observation)')
    .option(
      '--attach',
      'Save the generated llms.txt content back as an attachment on the target entity',
    )
    .action(async (opts: Record<string, unknown>) => {
      const forId = opts['for'] as string;
      const attach = opts['attach'] as boolean | undefined;

      await dispatchFromCli(
        'query',
        'docs',
        'generate',
        {
          for: forId,
          ...(attach ? { attach: true } : {}),
        },
        { command: 'docs generate' },
      );
    });

  // ── Legacy: cleo docs sync ────────────────────────────────────────────────
  docsCmd
    .command('sync')
    .description('Run drift detection between scripts and docs index')
    .option('--quick', 'Quick check (commands only)')
    .option('--strict', 'Exit with error on any drift')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const projectRoot = process.cwd();
        const result = await detectDrift(projectRoot);

        cliOutput(
          {
            status: result.status,
            missingFromIndex: result.missingFromIndex,
            missingFromScripts: result.missingFromScripts,
            warnings: result.warnings,
          },
          {
            command: 'docs',
            message:
              result.status === 'clean'
                ? 'Documentation is in sync'
                : `Drift detected: ${result.warnings.join('; ')}`,
          },
        );

        if (opts['strict'] && result.status !== 'clean') {
          process.exit(result.status === 'error' ? 2 : 1);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── Legacy: cleo docs gap-check ───────────────────────────────────────────
  docsCmd
    .command('gap-check')
    .description('Validate knowledge transfer from review docs to canonical docs')
    .option('--epic <id>', 'Filter by epic ID')
    .option('--task <id>', 'Filter by task ID')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const projectRoot = process.cwd();
        const filterId = (opts['epic'] as string) ?? (opts['task'] as string);
        const gaps = await runGapCheck(projectRoot, filterId);

        if (gaps.length === 0) {
          cliOutput(
            { gapCount: 0, results: [] },
            { command: 'docs', message: 'No documentation gaps found' },
          );
        } else {
          cliOutput(
            {
              gapCount: gaps.length,
              results: gaps,
            },
            { command: 'docs', message: `Found ${gaps.length} document(s) with gaps` },
          );
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
