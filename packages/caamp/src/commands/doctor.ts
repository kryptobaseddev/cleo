/**
 * doctor command - diagnose configuration issues and health
 * LAFS-compliant with JSON-first output
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { readConfig } from '../core/formats/index.js';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  handleFormatError,
  outputSuccess,
  resolveFormat,
} from '../core/lafs.js';
import { resolveChannelFromServerName } from '../core/mcp/cleo.js';
import { readLockFile } from '../core/mcp/lock.js';
import { listMcpServers } from '../core/mcp/reader.js';
import { CANONICAL_SKILLS_DIR } from '../core/paths/agents.js';
import { detectAllProviders } from '../core/registry/detection.js';
import { getAllProviders, getProviderCount } from '../core/registry/providers.js';
import { getCaampVersion } from '../core/version.js';

interface CheckResult {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
}

interface SectionResult {
  name: string;
  checks: CheckResult[];
}

interface DoctorResult {
  environment: {
    node: string;
    npm: string;
    caamp: string;
    platform: string;
  };
  registry: {
    loaded: boolean;
    count: number;
    valid: boolean;
  };
  providers: {
    installed: number;
    list: string[];
  };
  skills: {
    canonical: number;
    brokenLinks: number;
    staleLinks: number;
  };
  mcpServers: {
    tracked: number;
    untracked: number;
    orphaned: number;
  };
  checks: Array<{
    label: string;
    status: 'pass' | 'fail' | 'warn';
    message?: string;
  }>;
}

function getNodeVersion(): string {
  return process.version;
}

function getNpmVersion(): string | null {
  try {
    return execFileSync('npm', ['--version'], { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function checkEnvironment(): SectionResult {
  const checks: CheckResult[] = [];

  checks.push({ label: `Node.js ${getNodeVersion()}`, status: 'pass' });

  const npmVersion = getNpmVersion();
  if (npmVersion) {
    checks.push({ label: `npm ${npmVersion}`, status: 'pass' });
  } else {
    checks.push({ label: 'npm not found', status: 'warn' });
  }

  checks.push({ label: `CAAMP v${getCaampVersion()}`, status: 'pass' });
  checks.push({ label: `${process.platform} ${process.arch}`, status: 'pass' });

  return { name: 'Environment', checks };
}

function checkRegistry(): SectionResult {
  const checks: CheckResult[] = [];

  try {
    const providers = getAllProviders();
    const count = getProviderCount();
    checks.push({ label: `${count} providers loaded`, status: 'pass' });

    const malformed: string[] = [];
    for (const p of providers) {
      if (!p.id || !p.toolName || !p.configKey || !p.configFormat) {
        malformed.push(p.id || '(unknown)');
      }
    }

    if (malformed.length === 0) {
      checks.push({ label: 'All entries valid', status: 'pass' });
    } else {
      checks.push({
        label: `${malformed.length} malformed entries`,
        status: 'fail',
        detail: malformed.join(', '),
      });
    }
  } catch (err) {
    checks.push({
      label: 'Failed to load registry',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { name: 'Registry', checks };
}

function checkInstalledProviders(): SectionResult {
  const checks: CheckResult[] = [];

  try {
    const results = detectAllProviders();
    const installed = results.filter((r) => r.installed);

    checks.push({ label: `${installed.length} found`, status: 'pass' });

    for (const r of installed) {
      const methods = r.methods.join(', ');
      checks.push({ label: `${r.provider.toolName} (${methods})`, status: 'pass' });
    }
  } catch (err) {
    checks.push({
      label: 'Detection failed',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { name: 'Installed Providers', checks };
}

function checkSkillSymlinks(): SectionResult {
  const checks: CheckResult[] = [];

  const canonicalDir = CANONICAL_SKILLS_DIR;

  if (!existsSync(canonicalDir)) {
    checks.push({ label: '0 canonical skills', status: 'pass' });
    checks.push({ label: 'No broken symlinks', status: 'pass' });
    return { name: 'Skills', checks };
  }

  let canonicalCount = 0;
  let canonicalNames: string[] = [];
  try {
    canonicalNames = readdirSync(canonicalDir).filter((name) => {
      const full = join(canonicalDir, name);
      try {
        const stat = lstatSync(full);
        return stat.isDirectory() || stat.isSymbolicLink();
      } catch {
        return false;
      }
    });
    canonicalCount = canonicalNames.length;
    checks.push({ label: `${canonicalCount} canonical skills`, status: 'pass' });
  } catch {
    checks.push({ label: 'Cannot read skills directory', status: 'warn' });
    return { name: 'Skills', checks };
  }

  // Check symlinks in installed provider skill directories
  const broken: string[] = [];
  const stale: string[] = [];
  const results = detectAllProviders();
  const installed = results.filter((r) => r.installed);

  for (const r of installed) {
    const provider = r.provider;
    const skillDir = provider.pathSkills;
    if (!existsSync(skillDir)) continue;

    try {
      const entries = readdirSync(skillDir);
      for (const entry of entries) {
        const fullPath = join(skillDir, entry);
        try {
          const stat = lstatSync(fullPath);
          if (!stat.isSymbolicLink()) continue;

          if (!existsSync(fullPath)) {
            broken.push(`${provider.id}/${entry}`);
          } else {
            // Check if symlink points to canonical location
            const target = readlinkSync(fullPath);
            const isCanonical =
              target.includes('/.agents/skills/') || target.includes('\\.agents\\skills\\');
            if (!isCanonical) {
              stale.push(`${provider.id}/${entry}`);
            }
          }
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  if (broken.length === 0) {
    checks.push({ label: 'No broken symlinks', status: 'pass' });
  } else {
    checks.push({
      label: `${broken.length} broken symlink${broken.length !== 1 ? 's' : ''}`,
      status: 'warn',
      detail: broken.join(', '),
    });
  }

  if (stale.length === 0) {
    checks.push({ label: 'No stale symlinks', status: 'pass' });
  } else {
    checks.push({
      label: `${stale.length} stale symlink${stale.length !== 1 ? 's' : ''} (not pointing to ~/.agents/skills/)`,
      status: 'warn',
      detail: stale.join(', '),
    });
  }

  return { name: 'Skills', checks };
}

async function checkLockFile(): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  try {
    const lock = await readLockFile();
    checks.push({ label: 'Lock file valid', status: 'pass' });

    const lockSkillNames = Object.keys(lock.skills);
    checks.push({ label: `${lockSkillNames.length} skill entries`, status: 'pass' });

    // Check for orphaned skill entries (canonical path no longer exists)
    const orphaned: string[] = [];
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (entry.canonicalPath && !existsSync(entry.canonicalPath)) {
        orphaned.push(name);
      }
    }

    if (orphaned.length === 0) {
      checks.push({ label: '0 orphaned entries', status: 'pass' });
    } else {
      checks.push({
        label: `${orphaned.length} orphaned skill${orphaned.length !== 1 ? 's' : ''} (in lock, missing from disk)`,
        status: 'warn',
        detail: orphaned.join(', '),
      });
    }

    // Check for untracked skills (on disk but not in lock)
    const canonicalDir = CANONICAL_SKILLS_DIR;
    if (existsSync(canonicalDir)) {
      const onDisk = readdirSync(canonicalDir).filter((name) => {
        try {
          const stat = lstatSync(join(canonicalDir, name));
          return stat.isDirectory() || stat.isSymbolicLink();
        } catch {
          return false;
        }
      });
      const untracked = onDisk.filter((name) => !lock.skills[name]);

      if (untracked.length === 0) {
        checks.push({ label: '0 untracked skills', status: 'pass' });
      } else {
        checks.push({
          label: `${untracked.length} untracked skill${untracked.length !== 1 ? 's' : ''} (on disk, not in lock)`,
          status: 'warn',
          detail: untracked.join(', '),
        });
      }
    }

    // Check lock agent-list vs actual symlinks
    const results = detectAllProviders();
    const installed = results.filter((r) => r.installed);
    const mismatches: string[] = [];

    for (const [name, entry] of Object.entries(lock.skills)) {
      if (!entry.agents || entry.agents.length === 0) continue;

      for (const agentId of entry.agents) {
        const provider = installed.find((r) => r.provider.id === agentId);
        if (!provider) continue;

        const linkPath = join(provider.provider.pathSkills, name);
        if (!existsSync(linkPath)) {
          mismatches.push(`${name} missing from ${agentId}`);
        }
      }
    }

    if (mismatches.length === 0) {
      checks.push({ label: 'Lock agent-lists match symlinks', status: 'pass' });
    } else {
      checks.push({
        label: `${mismatches.length} agent-list mismatch${mismatches.length !== 1 ? 'es' : ''}`,
        status: 'warn',
        detail:
          mismatches.slice(0, 5).join(', ') +
          (mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : ''),
      });
    }
  } catch (err) {
    checks.push({
      label: 'Failed to read lock file',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { name: 'Lock File', checks };
}

async function checkMcpLockEntries(): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  try {
    const lock = await readLockFile();
    const lockNames = Object.keys(lock.mcpServers);
    checks.push({ label: `${lockNames.length} MCP server entries in lock`, status: 'pass' });

    // Detect untracked CLEO servers (in config, not in lock)
    const results = detectAllProviders();
    const installed = results.filter((r) => r.installed);
    const liveCleoNames = new Set<string>();
    let untrackedCount = 0;

    for (const scope of ['project', 'global'] as const) {
      for (const r of installed) {
        try {
          const entries = await listMcpServers(r.provider, scope);
          for (const entry of entries) {
            const channel = resolveChannelFromServerName(entry.name);
            if (!channel) continue;
            liveCleoNames.add(entry.name);

            if (!lock.mcpServers[entry.name]) {
              untrackedCount++;
            }
          }
        } catch {
          // skip unreadable configs
        }
      }
    }

    if (untrackedCount === 0) {
      checks.push({ label: 'All CLEO servers tracked in lock', status: 'pass' });
    } else {
      checks.push({
        label: `${untrackedCount} untracked CLEO server${untrackedCount !== 1 ? 's' : ''} (in config, not in lock)`,
        status: 'warn',
        detail: 'Run `caamp cleo repair` to backfill lock entries',
      });
    }

    // Detect orphaned CLEO entries (in lock, not in any config)
    let orphanedCount = 0;
    const orphanedNames: string[] = [];

    for (const serverName of lockNames) {
      const channel = resolveChannelFromServerName(serverName);
      if (!channel) continue;

      if (!liveCleoNames.has(serverName)) {
        orphanedCount++;
        orphanedNames.push(serverName);
      }
    }

    if (orphanedCount === 0) {
      checks.push({ label: 'No orphaned CLEO lock entries', status: 'pass' });
    } else {
      checks.push({
        label: `${orphanedCount} orphaned CLEO lock entr${orphanedCount !== 1 ? 'ies' : 'y'} (in lock, not in any config)`,
        status: 'warn',
        detail: orphanedNames.join(', ') + ' — Run `caamp cleo repair --prune` to clean up',
      });
    }
  } catch (err) {
    checks.push({
      label: 'Failed to check MCP lock entries',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { name: 'MCP Lock', checks };
}

async function checkConfigFiles(): Promise<SectionResult> {
  const checks: CheckResult[] = [];

  const results = detectAllProviders();
  const installed = results.filter((r) => r.installed);

  for (const r of installed) {
    const provider = r.provider;
    const configPath = provider.configPathGlobal;

    if (!existsSync(configPath)) {
      checks.push({
        label: `${provider.id}: no config file found`,
        status: 'warn',
        detail: configPath,
      });
      continue;
    }

    try {
      await readConfig(configPath, provider.configFormat);
      const relPath = configPath.replace(homedir(), '~');
      checks.push({
        label: `${provider.id}: ${relPath} readable`,
        status: 'pass',
      });
    } catch (err) {
      checks.push({
        label: `${provider.id}: config parse error`,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (installed.length === 0) {
    checks.push({ label: 'No installed providers to check', status: 'pass' });
  }

  return { name: 'Config Files', checks };
}

function formatSection(section: SectionResult): string {
  const lines: string[] = [];
  lines.push(`  ${pc.bold(section.name)}`);

  for (const check of section.checks) {
    const icon =
      check.status === 'pass'
        ? pc.green('✓')
        : check.status === 'warn'
          ? pc.yellow('⚠')
          : pc.red('✗');

    lines.push(`    ${icon} ${check.label}`);

    if (check.detail) {
      lines.push(`      ${pc.dim(check.detail)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Registers the `doctor` command for diagnosing configuration issues and overall system health.
 *
 * @remarks
 * Runs checks across environment, registry, installed providers, skill symlinks, lock file
 * integrity, MCP lock entries, and config file parseability. Returns a structured result
 * with pass/warn/fail status for each check.
 *
 * @param program - The root Commander program to attach the doctor command to
 *
 * @example
 * ```bash
 * caamp doctor --human
 * caamp doctor --json
 * ```
 *
 * @public
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose configuration issues and health')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (opts: { json?: boolean; human?: boolean }) => {
      const operation = 'doctor.check';
      const mvi: import('../core/lafs.js').MVILevel = 'standard';

      let format: 'json' | 'human';
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: opts.human ?? false,
          projectDefault: 'json',
        });
      } catch (error) {
        handleFormatError(error, operation, mvi, opts.json);
      }

      try {
        const sections: SectionResult[] = [];

        sections.push(checkEnvironment());
        sections.push(checkRegistry());
        sections.push(checkInstalledProviders());
        sections.push(checkSkillSymlinks());
        sections.push(await checkLockFile());
        sections.push(await checkMcpLockEntries());
        sections.push(await checkConfigFiles());

        // Tally results
        let passed = 0;
        let warnings = 0;
        let errors = 0;

        for (const section of sections) {
          for (const check of section.checks) {
            if (check.status === 'pass') passed++;
            else if (check.status === 'warn') warnings++;
            else errors++;
          }
        }

        // Build result for LAFS envelope
        const npmVersion = getNpmVersion() ?? 'not found';
        const allProviders = getAllProviders();
        const malformedCount = allProviders.filter(
          (p) => !p.id || !p.toolName || !p.configKey || !p.configFormat,
        ).length;
        const detectionResults = detectAllProviders();
        const installedProviders = detectionResults.filter((r) => r.installed);
        const { canonicalCount, brokenCount, staleCount } = countSkillIssues();

        const {
          tracked: mcpTracked,
          untracked: mcpUntracked,
          orphaned: mcpOrphaned,
        } = countMcpLockIssues(sections);

        const result: DoctorResult = {
          environment: {
            node: getNodeVersion(),
            npm: npmVersion,
            caamp: getCaampVersion(),
            platform: `${process.platform} ${process.arch}`,
          },
          registry: {
            loaded: true,
            count: getProviderCount(),
            valid: malformedCount === 0,
          },
          providers: {
            installed: installedProviders.length,
            list: installedProviders.map((r) => r.provider.id),
          },
          skills: {
            canonical: canonicalCount,
            brokenLinks: brokenCount,
            staleLinks: staleCount,
          },
          mcpServers: {
            tracked: mcpTracked,
            untracked: mcpUntracked,
            orphaned: mcpOrphaned,
          },
          checks: sections.flatMap((s) =>
            s.checks.map((c) => ({
              label: `${s.name}: ${c.label}`,
              status: c.status,
              message: c.detail,
            })),
          ),
        };

        if (format === 'json') {
          outputSuccess(operation, mvi, result);

          if (errors > 0) {
            process.exit(1);
          }
          return;
        }

        // Human-readable output
        console.log(pc.bold('\ncaamp doctor\n'));

        for (const section of sections) {
          console.log(formatSection(section));
          console.log();
        }

        // Summary line
        const parts: string[] = [];
        parts.push(pc.green(`${passed} checks passed`));
        if (warnings > 0) parts.push(pc.yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
        if (errors > 0) parts.push(pc.red(`${errors} error${errors !== 1 ? 's' : ''}`));

        console.log(`  ${pc.bold('Summary')}: ${parts.join(', ')}`);
        console.log();

        if (errors > 0) {
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (format === 'json') {
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.INTERNAL_ERROR,
            message,
            ErrorCategories.INTERNAL,
          );
        } else {
          console.error(pc.red(`Error: ${message}`));
        }
        process.exit(1);
      }
    });
}

function countSkillIssues(): { canonicalCount: number; brokenCount: number; staleCount: number } {
  const canonicalDir = CANONICAL_SKILLS_DIR;
  let canonicalCount = 0;

  if (existsSync(canonicalDir)) {
    try {
      const names = readdirSync(canonicalDir).filter((name) => {
        const full = join(canonicalDir, name);
        try {
          const stat = lstatSync(full);
          return stat.isDirectory() || stat.isSymbolicLink();
        } catch {
          return false;
        }
      });
      canonicalCount = names.length;
    } catch {
      // ignore
    }
  }

  let brokenCount = 0;
  let staleCount = 0;

  const results = detectAllProviders();
  const installed = results.filter((r) => r.installed);

  for (const r of installed) {
    const provider = r.provider;
    const skillDir = provider.pathSkills;
    if (!existsSync(skillDir)) continue;

    try {
      const entries = readdirSync(skillDir);
      for (const entry of entries) {
        const fullPath = join(skillDir, entry);
        try {
          const stat = lstatSync(fullPath);
          if (!stat.isSymbolicLink()) continue;

          if (!existsSync(fullPath)) {
            brokenCount++;
          } else {
            const target = readlinkSync(fullPath);
            const isCanonical =
              target.includes('/.agents/skills/') || target.includes('\\.agents\\skills\\');
            if (!isCanonical) {
              staleCount++;
            }
          }
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return { canonicalCount, brokenCount, staleCount };
}

function countMcpLockIssues(sections: SectionResult[]): {
  tracked: number;
  untracked: number;
  orphaned: number;
} {
  const mcpSection = sections.find((s) => s.name === 'MCP Lock');
  if (!mcpSection) return { tracked: 0, untracked: 0, orphaned: 0 };

  let tracked = 0;
  let untracked = 0;
  let orphaned = 0;

  for (const check of mcpSection.checks) {
    const countMatch = check.label.match(/^(\d+)/);
    if (!countMatch?.[1]) continue;

    const count = Number.parseInt(countMatch[1], 10);
    if (check.label.includes('MCP server entries in lock')) {
      tracked = count;
    } else if (check.label.includes('untracked')) {
      untracked = count;
    } else if (check.label.includes('orphaned')) {
      orphaned = count;
    }
  }

  return { tracked, untracked, orphaned };
}
