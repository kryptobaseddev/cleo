/**
 * CLI generate-changelog command - generate changelog from completed tasks.
 * Supports multiple output platforms (Mintlify, Docusaurus, plain).
 *
 * @task T4555
 * @epic T4545
 */

// TODO T4894: pipeline.release.changelog exists in registry but generate-changelog\n// implements local file generation from CHANGELOG.md, not a dispatch operation. Leave bypass.
import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getConfigPath, getProjectRoot } from '../../core/paths.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

/**
 * Platform output config shape from config.json.
 * @task T4555
 */
interface ChangelogOutputConfig {
  platform: string;
  enabled: boolean;
  path: string;
}

/**
 * Get changelog source path from config.
 * @task T4555
 */
function getChangelogSource(cwd?: string): string {
  const configPath = getConfigPath(cwd);
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.release?.changelog?.source ?? 'CHANGELOG.md';
  } catch {
    return 'CHANGELOG.md';
  }
}

/**
 * Get enabled output platforms from config.
 * @task T4555
 */
function getEnabledPlatforms(cwd?: string): ChangelogOutputConfig[] {
  const configPath = getConfigPath(cwd);
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const outputs = config?.release?.changelog?.outputs ?? [];
    return outputs.filter((o: ChangelogOutputConfig) => o.enabled);
  } catch {
    return [];
  }
}

/**
 * Get default output path for a platform.
 * @task T4555
 */
function getDefaultOutputPath(platform: string): string {
  switch (platform) {
    case 'mintlify': return 'docs/changelog/overview.mdx';
    case 'docusaurus': return 'docs/changelog.md';
    case 'github':
    case 'plain':
    default:
      return 'CHANGELOG.md';
  }
}

/**
 * Get GitHub repo slug from git remote using execFileSync (no shell injection).
 * @task T4555
 */
function getGitHubRepoSlug(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return remoteUrl
      .replace(/.*github\.com[:/]/, '')
      .replace(/\.git$/, '');
  } catch {
    return '';
  }
}

/**
 * Generate changelog for a specific platform using CHANGELOG.md as source.
 * @task T4555
 */
function generateForPlatform(
  platform: string,
  sourceContent: string,
  repoSlug: string,
  limit: number,
): string {
  switch (platform) {
    case 'mintlify':
      return generateMintlify(sourceContent, repoSlug, limit);
    case 'docusaurus':
      return generateDocusaurus(sourceContent, limit);
    case 'plain':
    case 'github':
    default:
      return sourceContent;
  }
}

/**
 * Generate Mintlify MDX changelog format.
 * @task T4555
 */
function generateMintlify(source: string, repoSlug: string, limit: number): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('title: "Changelog"');
  lines.push('description: "CLEO release history and product updates"');
  lines.push('icon: "clock-rotate-left"');
  lines.push('rss: true');
  lines.push('---');
  lines.push('');
  lines.push('# Changelog');
  lines.push('');

  // Parse version blocks from source
  const sourceLines = source.split('\n');
  const blocks: Array<{ version: string; date: string; content: string }> = [];
  let currentBlock: { version: string; date: string; startLine: number } | null = null;

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]!;
    const vMatch = line.match(/^## \[v?(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/);
    if (vMatch) {
      if (currentBlock) {
        blocks.push({
          version: currentBlock.version,
          date: currentBlock.date,
          content: sourceLines.slice(currentBlock.startLine + 1, i).join('\n').trim(),
        });
      }
      currentBlock = { version: vMatch[1]!, date: vMatch[2]!, startLine: i };
    }
  }
  if (currentBlock) {
    blocks.push({
      version: currentBlock.version,
      date: currentBlock.date,
      content: sourceLines.slice(currentBlock.startLine + 1).join('\n').trim(),
    });
  }

  for (const block of blocks.slice(0, limit)) {
    lines.push(`## v${block.version} - ${block.date}`);
    lines.push('');
    lines.push(block.content);
    lines.push('');
    if (repoSlug) {
      lines.push(`[View full release notes](https://github.com/${repoSlug}/releases/tag/v${block.version})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate Docusaurus markdown changelog format.
 * @task T4555
 */
function generateDocusaurus(source: string, limit: number): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('id: changelog');
  lines.push('title: Changelog');
  lines.push('sidebar_label: Changelog');
  lines.push('---');
  lines.push('');
  lines.push('# Changelog');
  lines.push('');

  const sourceLines = source.split('\n');
  let versionCount = 0;
  let inUnreleased = false;

  for (const line of sourceLines) {
    if (/^## \[Unreleased\]/.test(line)) {
      inUnreleased = true;
      continue;
    }
    if (/^## \[v?\d+\.\d+\.\d+\]/.test(line)) {
      inUnreleased = false;
      versionCount++;
      if (versionCount > limit) break;
    }
    if (!inUnreleased && versionCount > 0) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * Register the generate-changelog command.
 * @task T4555
 */
export function registerGenerateChangelogCommand(program: Command): void {
  program
    .command('generate-changelog')
    .description('Generate platform-specific changelog from CHANGELOG.md')
    .option('--platform <platform>', 'Target platform (mintlify, docusaurus, plain, github)')
    .option('--limit <n>', 'Max versions to include', '15')
    .option('--dry-run', 'Show what would be generated without writing')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const limit = Number(opts['limit'] ?? 15);
        const targetPlatform = opts['platform'] as string | undefined;
        const dryRun = !!opts['dryRun'];

        const sourceFile = getChangelogSource();
        const sourcePath = join(getProjectRoot(), sourceFile);

        if (!existsSync(sourcePath)) {
          throw new CleoError(ExitCode.NOT_FOUND, `Changelog source not found: ${sourcePath}`);
        }

        const sourceContent = readFileSync(sourcePath, 'utf-8');
        const repoSlug = getGitHubRepoSlug();
        const results: Array<{ platform: string; path: string; written: boolean }> = [];

        if (targetPlatform) {
          const platforms = getEnabledPlatforms();
          const platformConfig = platforms.find(p => p.platform === targetPlatform);
          const outputPath = platformConfig?.path ?? getDefaultOutputPath(targetPlatform);
          const content = generateForPlatform(targetPlatform, sourceContent, repoSlug, limit);

          if (!dryRun) {
            const fullPath = join(getProjectRoot(), outputPath);
            mkdirSync(dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, content, 'utf-8');
          }
          results.push({ platform: targetPlatform, path: outputPath, written: !dryRun });
        } else {
          const platforms = getEnabledPlatforms();
          if (platforms.length === 0) {
            throw new CleoError(
              ExitCode.CONFIG_ERROR,
              'No changelog output platforms configured. Configure in .cleo/config.json under release.changelog.outputs',
            );
          }

          for (const platformConfig of platforms) {
            const content = generateForPlatform(
              platformConfig.platform,
              sourceContent,
              repoSlug,
              limit,
            );
            if (!dryRun) {
              const fullPath = join(getProjectRoot(), platformConfig.path);
              mkdirSync(dirname(fullPath), { recursive: true });
              writeFileSync(fullPath, content, 'utf-8');
            }
            results.push({
              platform: platformConfig.platform,
              path: platformConfig.path,
              written: !dryRun,
            });
          }
        }

        cliOutput({
          dryRun,
          source: sourceFile,
          repoSlug: repoSlug || null,
          generated: results,
        }, { command: 'generate-changelog' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
