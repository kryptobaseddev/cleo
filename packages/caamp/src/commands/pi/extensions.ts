/**
 * `caamp pi extensions` command group.
 *
 * @remarks
 * Three verbs implementing ADR-035 §D1 for Pi extensions:
 *
 * - `list` — walk every tier (project → user → global) and emit an
 *   array of {@link ExtensionEntry} objects with shadow flags.
 * - `install <source>` — copy a source `.ts` file (local path, GitHub
 *   URL/shorthand, or remote HTTPS URL) into the target tier.
 * - `remove <name>` — delete a named extension from the target tier.
 *
 * Every verb follows the established LAFS envelope pattern via
 * {@link runLafsCommand}. Pi-absent detection happens inside
 * {@link requirePiHarness}, so each verb body only handles the happy
 * path plus verb-specific argument validation.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { HarnessInstallOptions } from '../../core/harness/types.js';
import { fetchWithTimeout } from '../../core/network/fetch.js';
import { cloneRepo } from '../../core/sources/github.js';
import { cloneGitLabRepo } from '../../core/sources/gitlab.js';
import { parseSource } from '../../core/sources/parser.js';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import {
  PI_ERROR_CODES,
  type PiCommandBaseOptions,
  parseScope,
  requirePiHarness,
  resolveProjectDir,
} from './common.js';

/**
 * Options accepted by `caamp pi extensions list`.
 *
 * @public
 */
export interface PiExtensionsListOptions extends PiCommandBaseOptions {
  /** Project directory used for the `project` tier. */
  projectDir?: string;
}

/**
 * Options accepted by `caamp pi extensions install`.
 *
 * @public
 */
export interface PiExtensionsInstallOptions extends PiCommandBaseOptions {
  /** Extension name override. Defaults to the inferred source name. */
  name?: string;
}

/**
 * Options accepted by `caamp pi extensions remove`.
 *
 * @public
 */
export type PiExtensionsRemoveOptions = PiCommandBaseOptions;

/**
 * Normalize a raw source argument into an absolute local `.ts` file path.
 *
 * @remarks
 * Handles four source kinds:
 *
 * - Local file path (`./ext.ts`, absolute, `~/ext.ts`)
 * - Remote HTTPS URL to a raw `.ts` file (`https://...ext.ts`)
 * - GitHub shorthand/URL pointing at a `.ts` file inside a repo
 *   (clones the repo shallowly, resolves the file, returns its path)
 * - GitLab URL pointing at a `.ts` file inside a repo
 *
 * Returns a `{ localPath, cleanup }` pair where `cleanup` is a best-
 * effort async function the caller MUST run when it is done with
 * `localPath` (typically inside a `try { ... } finally { ... }` block).
 *
 * Throws {@link LAFSCommandError} for unsupported source shapes or
 * network failures.
 *
 * @internal
 */
async function resolveExtensionSource(
  source: string,
): Promise<{ localPath: string; cleanup: () => Promise<void>; inferredName: string }> {
  // Local file path first — cheapest check.
  if (
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~')
  ) {
    const expanded = source.startsWith('~/')
      ? join(process.env['HOME'] ?? '', source.slice(2))
      : source;
    if (!existsSync(expanded)) {
      throw new LAFSCommandError(
        PI_ERROR_CODES.NOT_FOUND,
        `Source file does not exist: ${expanded}`,
        'Check the path and try again.',
        false,
      );
    }
    const inferredName = inferNameFromPath(expanded);
    return {
      localPath: expanded,
      cleanup: async () => {
        // Local files are not owned by us — never delete.
      },
      inferredName,
    };
  }

  // Remote HTTPS fetch.
  if (/^https?:\/\//.test(source)) {
    const parsed = parseSource(source);
    if (parsed.type === 'github' && parsed.owner !== undefined && parsed.repo !== undefined) {
      const cloneResult = await cloneRepo(parsed.owner, parsed.repo, parsed.ref);
      const filePath =
        parsed.path !== undefined
          ? join(cloneResult.localPath, parsed.path)
          : cloneResult.localPath;
      if (!existsSync(filePath)) {
        await cloneResult.cleanup();
        throw new LAFSCommandError(
          PI_ERROR_CODES.NOT_FOUND,
          `Source path not found inside cloned repo: ${parsed.path ?? '(root)'}`,
          'Check the repository URL and path.',
          false,
        );
      }
      return {
        localPath: filePath,
        cleanup: cloneResult.cleanup,
        inferredName: inferNameFromPath(filePath),
      };
    }
    if (parsed.type === 'gitlab' && parsed.owner !== undefined && parsed.repo !== undefined) {
      const cloneResult = await cloneGitLabRepo(parsed.owner, parsed.repo, parsed.ref);
      const filePath =
        parsed.path !== undefined
          ? join(cloneResult.localPath, parsed.path)
          : cloneResult.localPath;
      if (!existsSync(filePath)) {
        await cloneResult.cleanup();
        throw new LAFSCommandError(
          PI_ERROR_CODES.NOT_FOUND,
          `Source path not found inside cloned repo: ${parsed.path ?? '(root)'}`,
          'Check the repository URL and path.',
          false,
        );
      }
      return {
        localPath: filePath,
        cleanup: cloneResult.cleanup,
        inferredName: inferNameFromPath(filePath),
      };
    }
    // Raw HTTP(S) URL — download to a tmp file.
    const resp = await fetchWithTimeout(source);
    if (!resp.ok) {
      throw new LAFSCommandError(
        PI_ERROR_CODES.TRANSIENT,
        `Failed to download source from ${source}: HTTP ${resp.status}`,
        'Check the URL and network connectivity.',
        true,
      );
    }
    const body = await resp.text();
    const baseName = inferNameFromUrl(source);
    const tmp = join(tmpdir(), `caamp-pi-ext-${process.pid}-${Date.now()}-${baseName}.ts`);
    await writeFile(tmp, body, 'utf8');
    return {
      localPath: tmp,
      cleanup: async () => {
        try {
          await (await import('node:fs/promises')).rm(tmp, { force: true });
        } catch {
          // ignore
        }
      },
      inferredName: baseName,
    };
  }

  // GitHub shorthand: owner/repo[/path.ts]
  const parsed = parseSource(source);
  if (parsed.type === 'github' && parsed.owner !== undefined && parsed.repo !== undefined) {
    const cloneResult = await cloneRepo(parsed.owner, parsed.repo, parsed.ref);
    const filePath =
      parsed.path !== undefined ? join(cloneResult.localPath, parsed.path) : cloneResult.localPath;
    if (!existsSync(filePath)) {
      await cloneResult.cleanup();
      throw new LAFSCommandError(
        PI_ERROR_CODES.NOT_FOUND,
        `Source path not found inside cloned repo: ${parsed.path ?? '(root)'}`,
        'Check the repository shorthand and path.',
        false,
      );
    }
    return {
      localPath: filePath,
      cleanup: cloneResult.cleanup,
      inferredName: inferNameFromPath(filePath),
    };
  }

  throw new LAFSCommandError(
    PI_ERROR_CODES.VALIDATION,
    `Unsupported source: ${source}`,
    'Use a local file path, HTTPS URL, or GitHub shorthand (owner/repo/path.ts).',
    false,
  );
}

/**
 * Infer a stable extension name from a file path by stripping the
 * directory portion and the `.ts` suffix.
 *
 * @internal
 */
function inferNameFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return base.replace(/\.(ts|tsx|mts)$/, '');
}

/**
 * Infer a stable extension name from an HTTPS URL by using the final
 * path segment (without querystring or extension).
 *
 * @internal
 */
function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? 'extension';
    return seg.replace(/\.(ts|tsx|mts)$/, '');
  } catch {
    return 'extension';
  }
}

/**
 * Registers the `caamp pi extensions` command group.
 *
 * @remarks
 * Attaches `list`, `install <source>`, and `remove <name>` subcommands
 * under the parent `pi` group. All output is LAFS-compliant via
 * {@link runLafsCommand}; all errors surface as typed
 * {@link LAFSCommandError}s so the envelope carries a code.
 *
 * @param parent - The parent `pi` Command to attach the extensions group to.
 *
 * @example
 * ```bash
 * caamp pi extensions list
 * caamp pi extensions install ./my-ext.ts --scope user
 * caamp pi extensions install owner/repo/path/ext.ts --scope global
 * caamp pi extensions remove my-ext --scope user
 * ```
 *
 * @public
 */
export function registerPiExtensionsCommands(parent: Command): void {
  const ext = parent.command('extensions').description('Manage Pi extensions across tiers');

  ext
    .command('list')
    .description('List Pi extensions across project, user, and global tiers')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (opts: PiExtensionsListOptions) =>
      runLafsCommand('pi.extensions.list', 'standard', async () => {
        const harness = requirePiHarness();
        const projectDir = opts.projectDir ?? process.cwd();
        const entries = await harness.listExtensions(projectDir);
        return {
          count: entries.length,
          extensions: entries,
        };
      }),
    );

  ext
    .command('install <source>')
    .description('Install a Pi extension from a local path, HTTPS URL, or GitHub shorthand')
    .option('--scope <tier>', 'Install tier: project|user|global (default: project)')
    .option('--name <name>', 'Override the inferred extension name')
    .option('--force', 'Overwrite an existing extension at the target tier')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (source: string, opts: PiExtensionsInstallOptions) =>
      runLafsCommand('pi.extensions.install', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);

        const resolved = await resolveExtensionSource(source);
        try {
          const name = opts.name ?? resolved.inferredName;
          const installOpts: HarnessInstallOptions = { force: opts.force ?? false };
          const result = await harness.installExtension(
            resolved.localPath,
            name,
            tier,
            projectDir,
            installOpts,
          );
          return {
            installed: {
              name,
              tier: result.tier,
              targetPath: result.targetPath,
              source,
            },
          };
        } finally {
          await resolved.cleanup();
        }
      }),
    );

  ext
    .command('remove <name>')
    .description('Remove a Pi extension from the given tier')
    .option('--scope <tier>', 'Target tier: project|user|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (name: string, opts: PiExtensionsRemoveOptions) =>
      runLafsCommand('pi.extensions.remove', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);
        const removed = await harness.removeExtension(name, tier, projectDir);
        return {
          name,
          tier,
          removed,
        };
      }),
    );
}
