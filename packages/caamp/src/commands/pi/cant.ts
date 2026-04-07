/**
 * `caamp pi cant` command group.
 *
 * @remarks
 * Four verbs implementing ADR-035 §D5 (CANT single engine) for the Pi
 * harness:
 *
 * - `list` — walk every tier (project → user → global) and emit an
 *   array of {@link CantProfileEntry} objects with shadow flags and
 *   per-profile section counts.
 * - `install <source>` — copy a source `.cant` file (local path, GitHub
 *   URL/shorthand, or remote HTTPS URL) into the target tier after
 *   running it through cant-core's 42-rule validator.
 * - `remove <name>` — delete a named CANT profile from the target tier.
 * - `validate <path>` — pure validation helper that runs the 42-rule
 *   engine against an arbitrary `.cant` file without installing it.
 *
 * Every verb follows the established LAFS envelope pattern via
 * {@link runLafsCommand}. Pi-absent detection happens inside
 * {@link requirePiHarness}, so each verb body only handles the happy
 * path plus verb-specific argument validation.
 *
 * The installed `.cant` files are consumed at runtime by the canonical
 * `cant-bridge.ts` Pi extension via `/cant:load <file>`; this command
 * group is the management plane for those files.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { PiHarness } from '../../core/harness/pi.js';
import type { HarnessTier } from '../../core/harness/scope.js';
import type { CantProfileCounts, HarnessInstallOptions } from '../../core/harness/types.js';
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
 * Options accepted by `caamp pi cant list`.
 *
 * @public
 */
export interface PiCantListOptions extends PiCommandBaseOptions {
  /** Project directory used for the `project` tier. */
  projectDir?: string;
}

/**
 * Options accepted by `caamp pi cant install`.
 *
 * @public
 */
export interface PiCantInstallOptions extends PiCommandBaseOptions {
  /** Profile name override. Defaults to the inferred source name. */
  name?: string;
}

/**
 * Options accepted by `caamp pi cant remove`.
 *
 * @public
 */
export type PiCantRemoveOptions = PiCommandBaseOptions;

/**
 * Resolved CANT source descriptor returned by {@link resolveCantSource}.
 *
 * @internal
 */
interface ResolvedCantSource {
  /** Absolute path to a local copy of the `.cant` file. */
  localPath: string;
  /** Best-effort cleanup callback (deletes tmp files / cloned repos). */
  cleanup: () => Promise<void>;
  /** Inferred profile name (basename without `.cant`). */
  inferredName: string;
}

/**
 * Normalize a raw source argument into an absolute local `.cant` file
 * path.
 *
 * @remarks
 * Handles four source kinds:
 *
 * - Local file path (`./profile.cant`, absolute, `~/profile.cant`)
 * - Remote HTTPS URL to a raw `.cant` file (`https://...profile.cant`)
 * - GitHub shorthand/URL pointing at a `.cant` file inside a repo
 *   (clones the repo shallowly, resolves the file, returns its path)
 * - GitLab URL pointing at a `.cant` file inside a repo
 *
 * Returns a `{ localPath, cleanup }` pair where `cleanup` is a best-
 * effort async function the caller MUST run when it is done with
 * `localPath` (typically inside a `try { ... } finally { ... }` block).
 *
 * Mirrors the resolution flow in `extensions.ts`'s
 * `resolveExtensionSource` so both verbs accept the same source kinds.
 *
 * Throws {@link LAFSCommandError} for unsupported source shapes or
 * network failures.
 *
 * @internal
 */
async function resolveCantSource(source: string): Promise<ResolvedCantSource> {
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
    return {
      localPath: expanded,
      cleanup: async () => {
        // Local files are not owned by us — never delete.
      },
      inferredName: inferNameFromPath(expanded),
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
    const tmp = join(tmpdir(), `caamp-pi-cant-${process.pid}-${Date.now()}-${baseName}.cant`);
    await writeFile(tmp, body, 'utf8');
    return {
      localPath: tmp,
      cleanup: async () => {
        try {
          await (await import('node:fs/promises')).rm(tmp, { force: true });
        } catch {
          // ignore — best-effort cleanup
        }
      },
      inferredName: baseName,
    };
  }

  // GitHub shorthand: owner/repo[/path.cant]
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
    'Use a local file path, HTTPS URL, or GitHub shorthand (owner/repo/path.cant).',
    false,
  );
}

/**
 * Infer a stable profile name from a file path by stripping the
 * directory portion and the `.cant` suffix.
 *
 * @internal
 */
function inferNameFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  return base.replace(/\.cant$/, '');
}

/**
 * Infer a stable profile name from an HTTPS URL by using the final
 * path segment (without querystring or extension).
 *
 * @internal
 */
function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? 'profile';
    return seg.replace(/\.cant$/, '');
  } catch {
    return 'profile';
  }
}

/**
 * Wrap {@link PiHarness.installCantProfile} so any thrown harness error
 * is rethrown as a typed {@link LAFSCommandError}.
 *
 * @remarks
 * Centralises the try/catch wrapper so the install verb body stays
 * linear and the result type stays narrow (avoiding `let` declarations
 * with deferred assignment).
 *
 * @internal
 */
async function invokeInstallCantProfile(
  harness: PiHarness,
  sourcePath: string,
  name: string,
  tier: HarnessTier,
  projectDir: string | undefined,
  installOpts: HarnessInstallOptions,
): Promise<{ targetPath: string; tier: HarnessTier; counts: CantProfileCounts }> {
  try {
    return await harness.installCantProfile(sourcePath, name, tier, projectDir, installOpts);
  } catch (err) {
    rethrowAsLafs(err);
  }
}

/**
 * Translate a PiHarness error message into a LAFS-typed error so the
 * envelope carries the right code.
 *
 * @remarks
 * The harness layer throws plain `Error` instances with descriptive
 * messages (e.g. `installCantProfile: target already exists at ...`).
 * Each verb in this file uses this helper to map those messages onto
 * one of the four canonical Pi error codes so callers see consistent
 * envelopes regardless of the failure mode.
 *
 * @internal
 */
function rethrowAsLafs(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/already exists/i.test(message)) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.CONFLICT,
      message,
      'Pass --force to overwrite the existing profile.',
      false,
    );
  }
  if (/does not exist|not found/i.test(message)) {
    throw new LAFSCommandError(PI_ERROR_CODES.NOT_FOUND, message, 'Check the path.', false);
  }
  if (/failed cant-core validation|expected a CANT source file|not a regular file/i.test(message)) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.VALIDATION,
      message,
      'Run `caamp pi cant validate <path>` to inspect the diagnostics.',
      false,
    );
  }
  throw new LAFSCommandError(
    'E_INTERNAL_UNEXPECTED',
    message,
    'Inspect the message for the underlying cant-core failure mode.',
    false,
  );
}

/**
 * Registers the `caamp pi cant` command group.
 *
 * @remarks
 * Attaches `list`, `install <source>`, `remove <name>`, and
 * `validate <path>` subcommands under the parent `pi` group. All
 * output is LAFS-compliant via {@link runLafsCommand}; all errors
 * surface as typed {@link LAFSCommandError}s so the envelope carries a
 * code.
 *
 * @param parent - The parent `pi` Command to attach the cant group to.
 *
 * @example
 * ```bash
 * caamp pi cant list
 * caamp pi cant install ./my-profile.cant --scope user
 * caamp pi cant install owner/repo/path/profile.cant --scope global
 * caamp pi cant remove my-profile --scope user
 * caamp pi cant validate ./my-profile.cant
 * ```
 *
 * @public
 */
export function registerPiCantCommands(parent: Command): void {
  const cant = parent.command('cant').description('Manage Pi CANT profiles across tiers');

  cant
    .command('list')
    .description('List Pi CANT profiles across project, user, and global tiers')
    .option('--scope <tier>', 'Filter to a single tier: project|user|global')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (opts: PiCantListOptions) =>
      runLafsCommand('pi.cant.list', 'standard', async () => {
        const harness = requirePiHarness();
        const projectDir = opts.projectDir ?? process.cwd();
        const allEntries = await harness.listCantProfiles(projectDir);
        const filterTier = opts.scope === undefined ? null : parseScope(opts.scope, 'project');
        const entries =
          filterTier === null ? allEntries : allEntries.filter((e) => e.tier === filterTier);
        const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
        return {
          count: sorted.length,
          entries: sorted,
        };
      }),
    );

  cant
    .command('install <source>')
    .description('Install a Pi CANT profile from a local path, HTTPS URL, or GitHub shorthand')
    .option('--scope <tier>', 'Install tier: project|user|global (default: project)')
    .option('--name <name>', 'Override the inferred profile name')
    .option('--force', 'Overwrite an existing profile at the target tier')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (source: string, opts: PiCantInstallOptions) =>
      runLafsCommand('pi.cant.install', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);

        const resolved = await resolveCantSource(source);
        try {
          const name = opts.name ?? resolved.inferredName;
          const installOpts: HarnessInstallOptions = { force: opts.force ?? false };
          const result = await invokeInstallCantProfile(
            harness,
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
              counts: result.counts,
              source,
            },
          };
        } finally {
          await resolved.cleanup();
        }
      }),
    );

  cant
    .command('remove <name>')
    .description('Remove a Pi CANT profile from the given tier')
    .option('--scope <tier>', 'Target tier: project|user|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (name: string, opts: PiCantRemoveOptions) =>
      runLafsCommand('pi.cant.remove', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);
        const removed = await harness.removeCantProfile(name, tier, projectDir);
        return {
          name,
          tier,
          removed,
        };
      }),
    );

  cant
    .command('validate <path>')
    .description('Validate a .cant file via cant-core without installing it')
    .action(async (path: string) =>
      runLafsCommand('pi.cant.validate', 'standard', async () => {
        const harness = requirePiHarness();
        if (!existsSync(path)) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.NOT_FOUND,
            `Source file does not exist: ${path}`,
            'Check the path and try again.',
            false,
          );
        }
        const result = await harness.validateCantProfile(path);
        if (!result.valid) {
          // Surface the validation failure as a typed error so the
          // envelope carries an exit code 1; the diagnostics ride along
          // in the error details for tooling to consume.
          throw new LAFSCommandError(
            PI_ERROR_CODES.VALIDATION,
            `cant-core validation failed with ${result.errors.length} diagnostic(s)`,
            'See the `errors` field for ruleId/line/col/message details.',
            false,
            { valid: false, counts: result.counts, errors: result.errors },
          );
        }
        return {
          valid: true,
          counts: result.counts,
          errors: result.errors,
        };
      }),
    );
}
