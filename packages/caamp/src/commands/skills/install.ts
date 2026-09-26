/**
 * skills install command - LAFS-compliant with JSON-first output
 *
 * @remarks
 * Since T12384 this command owns only argument parsing and rendering. Source
 * resolution, the federation checksum gate, the skills-guard scan, the staged
 * copy and the lock record all happen in the library pipeline
 * ({@link installSkillFromSource}), which is the same function
 * `cleo tools skill install` calls — so both entry points refuse the same
 * skills, and both refuse when the gate cannot be loaded.
 */

import type { LAFSErrorCategory } from '@cleocode/lafs';
import type { Command } from 'commander';
import pc from 'picocolors';
import { resolveDefaultTargetProviders } from '../../core/harness/index.js';
import {
  buildEnvelope,
  ErrorCategories,
  ErrorCodes,
  emitError,
  emitJsonError,
  type MVILevel,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getProvider } from '../../core/registry/providers.js';
import * as catalog from '../../core/skills/catalog.js';
import {
  type GatedSkillInstallResult,
  installResolvedSkill,
  installSkillFromSource,
  SkillInstallError,
  type SkillSourceProgress,
} from '../../core/skills/install-pipeline.js';
import type { Provider } from '../../types.js';

interface InstallResultItem {
  name: string;
  scopedName: string;
  canonicalPath: string;
  providers: string[];
}

interface FailedResultItem {
  name: string;
  error: string;
}

interface InstallSummary {
  installed: InstallResultItem[];
  failed: FailedResultItem[];
  count: {
    installed: number;
    failed: number;
    total: number;
  };
}

/** Print a human-mode resolution step. */
function renderProgress(event: SkillSourceProgress): void {
  switch (event.kind) {
    case 'marketplace-search':
      console.log(pc.dim(`Searching marketplace for ${event.source}...`));
      return;
    case 'marketplace-found':
      console.log(`  Found: ${pc.bold(event.name)} by ${event.author} (${pc.dim(event.repo)})`);
      return;
    case 'catalog-found':
      console.log(
        `  Found in catalog: ${pc.bold(event.name)} v${event.version} (${pc.dim(event.category)})`,
      );
      return;
  }
}

/** LAFS category for each pipeline refusal code. */
function categoryFor(err: SkillInstallError): LAFSErrorCategory {
  switch (err.code) {
    case ErrorCodes.NETWORK_ERROR:
      return ErrorCategories.TRANSIENT;
    case ErrorCodes.SKILL_NOT_FOUND:
      return ErrorCategories.NOT_FOUND;
    case ErrorCodes.SKILL_GATE_UNAVAILABLE:
      return ErrorCategories.INTERNAL;
    default:
      return ErrorCategories.VALIDATION;
  }
}

/**
 * Render a pipeline refusal in the requested format and exit non-zero.
 *
 * @remarks
 * A trust-gate block carries the scan in the envelope's `result` so callers
 * can inspect the findings, matching the pre-T12384 envelope shape.
 */
function reportRefusal(
  err: SkillInstallError,
  format: 'json' | 'human',
  operation: string,
  mvi: MVILevel,
): never {
  const scan = err.details.scan;
  if (format === 'json') {
    if (scan && err.code === ErrorCodes.SKILL_TRUST_GATE_BLOCKED) {
      const envelope = buildEnvelope(
        operation,
        mvi,
        { scan },
        {
          code: err.code,
          message: err.message,
          category: categoryFor(err),
          retryable: false,
          retryAfterMs: null,
          details: {
            verdict: scan.verdict,
            trustLevel: scan.trustLevel,
            findingsCount: scan.findings.length,
          },
        },
      );
      console.error(JSON.stringify(envelope, null, 2));
    } else {
      const details: Record<string, unknown> = {};
      if (err.details.availableSkills) details.availableSkills = err.details.availableSkills;
      if (err.details.federation) {
        details.expectedChecksum = err.details.federation.expectedChecksum;
        details.computedChecksum = err.details.federation.computedChecksum;
        details.peer = err.details.federation.peer?.url ?? null;
      }
      if (err.details.cause) details.cause = err.details.cause;
      emitJsonError(operation, mvi, err.code, err.message, categoryFor(err), details);
    }
  }
  console.error(pc.red(err.message));
  if (scan && err.code === ErrorCodes.SKILL_TRUST_GATE_BLOCKED && format === 'human') {
    for (const f of scan.findings.slice(0, 5)) {
      console.error(
        pc.dim(`  [${f.severity}] ${f.category} ${f.file}:${f.line} — ${f.description}`),
      );
    }
    console.error(pc.yellow('  Use --force to override (audited).'));
  }
  if (err.details.availableSkills && format === 'human') {
    console.log(pc.dim(`Available skills: ${err.details.availableSkills.join(', ')}`));
  }
  process.exit(1);
}

/**
 * Registers the `skills install` subcommand for installing skills from various sources.
 *
 * @remarks
 * Supports GitHub URLs, owner/repo shorthand, marketplace scoped names, and skill library profiles.
 * Uses the canonical+symlink model to store skills once and symlink to each targeted agent.
 *
 * @param parent - The parent `skills` Command to attach the install subcommand to
 *
 * @example
 * ```bash
 * caamp skills install owner/repo
 * caamp skills install @author/skill-name --agent claude-code
 * caamp skills install --profile recommended --all
 * ```
 *
 * @public
 */
export function registerSkillsInstall(parent: Command): void {
  parent
    .command('install')
    .description('Install a skill from GitHub, URL, marketplace, or registered skill library')
    .argument('[source]', 'Skill source (GitHub URL, owner/repo, @author/name, skill-name)')
    .option(
      '-a, --agent <name>',
      'Target specific agent(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('-g, --global', 'Install globally')
    .option('-y, --yes', 'Skip confirmation')
    .option('--all', 'Install to all detected agents')
    .option(
      '--profile <name>',
      'Install a skill library profile (minimal, core, recommended, full)',
    )
    .option(
      '--force',
      'Override trust-gate block decisions (audited to .cleo/audit/skill-trust-bypass.jsonl)',
    )
    .option(
      '--allow-new-source',
      'Bypass first-install confirmation prompt for unknown federation sources (non-TTY safe)',
    )
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (
        source: string | undefined,
        opts: {
          agent: string[];
          global?: boolean;
          yes?: boolean;
          all?: boolean;
          profile?: string;
          force?: boolean;
          allowNewSource?: boolean;
          json?: boolean;
          human?: boolean;
        },
      ) => {
        const operation = 'skills.install';
        const mvi: MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: opts.human ?? false,
            projectDefault: 'json',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FORMAT_CONFLICT,
            message,
            ErrorCategories.VALIDATION,
          );
          process.exit(1);
        }

        // Determine target providers. Default (no --agent, no --all) prefers
        // the registry's primary harness when it is installed; otherwise it
        // falls back to the legacy installed-providers list.
        let providers: Provider[];

        if (opts.all) {
          providers = getInstalledProviders();
        } else if (opts.agent.length > 0) {
          providers = opts.agent
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else {
          providers = resolveDefaultTargetProviders();
        }

        if (providers.length === 0) {
          const message = 'No target providers found. Use --agent or --all.';
          if (format === 'json') {
            emitError(
              operation,
              mvi,
              ErrorCodes.PROVIDER_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
            );
          }
          console.error(pc.red(message));
          process.exit(1);
        }

        // Handle --profile: install an entire skill library profile
        if (opts.profile) {
          await handleProfileInstall(
            opts.profile,
            providers,
            opts.global ?? false,
            format,
            operation,
            mvi,
          );
          return;
        }

        // Require source when not using --profile
        if (!source) {
          const message = 'Missing required argument: source';
          if (format === 'json') {
            emitError(
              operation,
              mvi,
              ErrorCodes.INVALID_INPUT,
              message,
              ErrorCategories.VALIDATION,
            );
          }
          console.error(pc.red(message));
          console.log(
            pc.dim('Usage: caamp skills install <source> or caamp skills install --profile <name>'),
          );
          process.exit(1);
        }

        if (format === 'human') {
          console.log(pc.dim(`Installing to ${providers.length} provider(s)...`));
        }

        let result: GatedSkillInstallResult;
        try {
          result = await installSkillFromSource(source, {
            providers,
            isGlobal: opts.global ?? false,
            force: opts.force ?? false,
            allowNewSource: opts.allowNewSource === true,
            recordLock: true,
            onProgress: format === 'human' ? renderProgress : undefined,
          });
        } catch (error) {
          if (error instanceof SkillInstallError) {
            reportRefusal(error, format, operation, mvi);
          }
          throw error;
        }

        if (result.success) {
          const installedItem: InstallResultItem = {
            name: result.name,
            scopedName: result.sourceValue,
            canonicalPath: result.canonicalPath,
            providers: result.linkedAgents,
          };

          const summary: InstallSummary = {
            installed: [installedItem],
            failed: [],
            count: { installed: 1, failed: 0, total: 1 },
          };

          if (format === 'json') {
            outputSuccess(operation, mvi, summary);
          } else {
            console.log(pc.green(`\n✓ Installed ${pc.bold(result.name)}`));
            console.log(`  Canonical: ${pc.dim(result.canonicalPath)}`);
            console.log(`  Linked to: ${result.linkedAgents.join(', ')}`);

            if (result.errors.length > 0) {
              console.log(pc.yellow('\nWarnings:'));
              for (const err of result.errors) {
                console.log(`  ${pc.yellow('!')} ${err}`);
              }
            }
          }
          return;
        }

        const summary: InstallSummary = {
          installed: [],
          failed: [{ name: result.name, error: result.errors.join(', ') }],
          count: { installed: 0, failed: 1, total: 1 },
        };

        if (format === 'json') {
          const envelope = buildEnvelope(operation, mvi, summary, {
            code: ErrorCodes.INSTALL_FAILED,
            message: result.errors.join(', '),
            category: ErrorCategories.INTERNAL,
            retryable: false,
            retryAfterMs: null,
            details: { skillName: result.name, sourceValue: result.sourceValue },
          });
          console.error(JSON.stringify(envelope, null, 2));
        } else {
          console.log(pc.yellow(`\n✗ Failed to install ${pc.bold(result.name)}`));
          console.log(pc.yellow('Errors:'));
          for (const err of result.errors) {
            console.log(`  ${pc.yellow('!')} ${err}`);
          }
        }
        process.exit(1);
      },
    );
}

async function handleProfileInstall(
  profileName: string,
  providers: Provider[],
  isGlobal: boolean,
  format: 'json' | 'human',
  operation: string,
  mvi: MVILevel,
): Promise<void> {
  if (!catalog.isCatalogAvailable()) {
    const message =
      'No skill library registered. Register one with registerSkillLibraryFromPath() or set CAAMP_SKILL_LIBRARY env var.';
    if (format === 'json') {
      emitError(operation, mvi, ErrorCodes.INVALID_INPUT, message, ErrorCategories.VALIDATION);
    }
    console.error(pc.red(message));
    process.exit(1);
  }

  const profileSkills = catalog.resolveProfile(profileName);
  if (profileSkills.length === 0) {
    const message = `Profile not found: ${profileName}`;
    if (format === 'json') {
      emitJsonError(
        operation,
        mvi,
        ErrorCodes.SKILL_NOT_FOUND,
        message,
        ErrorCategories.NOT_FOUND,
        {
          availableProfiles: catalog.listProfiles(),
        },
      );
    }
    console.error(pc.red(message));
    const available = catalog.listProfiles();
    if (available.length > 0) {
      console.log(pc.dim('Available profiles: ' + available.join(', ')));
    }
    process.exit(1);
  }

  if (format === 'human') {
    console.log(`Installing profile ${pc.bold(profileName)} (${profileSkills.length} skill(s))...`);
    console.log(pc.dim(`Target: ${providers.length} provider(s)`));
  }

  const installed: InstallResultItem[] = [];
  const failed: FailedResultItem[] = [];

  for (const name of profileSkills) {
    try {
      // T12384: profile skills go through the same gate as any other install.
      const result = await installResolvedSkill(
        {
          localPath: catalog.getSkillDir(name),
          skillName: name,
          sourceValue: `library:${name}`,
          sourceType: 'library',
        },
        { providers, isGlobal, recordLock: true },
      );

      if (result.success) {
        if (format === 'human') {
          console.log(pc.green(`  + ${name}`));
        }
        installed.push({
          name,
          scopedName: `library:${name}`,
          canonicalPath: result.canonicalPath,
          providers: result.linkedAgents,
        });
      } else {
        if (format === 'human') {
          console.log(pc.yellow(`  ! ${name}: ${result.errors.join(', ')}`));
        }
        failed.push({
          name,
          error: result.errors.join(', '),
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (format === 'human') {
        console.log(pc.red(`  x ${name}: ${errorMsg}`));
      }
      failed.push({
        name,
        error: errorMsg,
      });
    }
  }

  const summary: InstallSummary = {
    installed,
    failed,
    count: {
      installed: installed.length,
      failed: failed.length,
      total: profileSkills.length,
    },
  };

  if (format === 'json') {
    if (failed.length > 0) {
      const envelope = buildEnvelope(operation, mvi, summary, {
        code: ErrorCodes.INSTALL_FAILED,
        message: `${failed.length} skill(s) failed to install`,
        category: ErrorCategories.INTERNAL,
        retryable: false,
        retryAfterMs: null,
        details: { failed: failed.map((f) => f.name) },
      });
      console.error(JSON.stringify(envelope, null, 2));
      process.exit(1);
    } else {
      outputSuccess(operation, mvi, summary);
    }
  } else {
    console.log(
      `\n${pc.green(`${installed.length} installed`)}, ${failed.length > 0 ? pc.yellow(`${failed.length} failed`) : '0 failed'}`,
    );
    if (failed.length > 0) {
      process.exit(1);
    }
  }
}
