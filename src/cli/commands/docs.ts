/**
 * CLI docs command - documentation management with drift detection and gap checking.
 * Ported from scripts/docs.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { readJson } from '../../store/json.js';
import { getAgentOutputsAbsolute } from '../../core/paths.js';

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
 * @task T4551
 */
export function registerDocsCommand(program: Command): void {
  const docsCmd = program
    .command('docs')
    .description('Documentation management: drift detection and gap validation');

  docsCmd
    .command('sync')
    .description('Run drift detection between scripts and docs index')
    .option('--quick', 'Quick check (commands only)')
    .option('--strict', 'Exit with error on any drift')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const projectRoot = process.cwd();
        const result = await detectDrift(projectRoot);

        console.log(formatSuccess({
          status: result.status,
          missingFromIndex: result.missingFromIndex,
          missingFromScripts: result.missingFromScripts,
          warnings: result.warnings,
        }, result.status === 'clean' ? 'Documentation is in sync' : `Drift detected: ${result.warnings.join('; ')}`));

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
          console.log(formatSuccess(
            { gapCount: 0, results: [] },
            'No documentation gaps found',
          ));
        } else {
          console.log(formatSuccess({
            gapCount: gaps.length,
            results: gaps,
          }, `Found ${gaps.length} document(s) with gaps`));
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
