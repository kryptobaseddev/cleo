/**
 * CleoOS postinstall — scaffolds the global XDG hub and deploys extensions.
 *
 * Runs automatically after `npm install -g @cleocode/cleo-os`.
 * Creates an XDG-compliant directory structure, copies the compiled CANT
 * bridge extension to the extensions directory, and optionally invokes
 * `cleo skills install` for any bundled CleoOS skills.
 *
 * Behaviour:
 *   - Skips silently during workspace/dev installs (non-global).
 *   - All directory creation is idempotent (no-op if directory exists).
 *   - Extensions and starter bundle files are always overwritten on upgrade.
 *   - Skill install is best-effort; failures are logged but not fatal.
 *   - Missing `@mariozechner/pi-coding-agent` is handled gracefully.
 *
 * This source compiles to `bin/postinstall.js` via a dedicated tsconfig
 * (see `tsconfig.postinstall.json`). The `postinstall` script in
 * `package.json` references the compiled output at `bin/postinstall.js`.
 *
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformPaths } from '@cleocode/core/system/platform-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Cross-OS path resolution — delegates to @cleocode/core (the single source
// of truth). Safe to import here because postinstall short-circuits on
// non-global installs (isGlobalInstall check below), so workspace dev
// installs never reach this path before @cleocode/core's dist/ is built.
// ---------------------------------------------------------------------------

/**
 * Resolve CleoOS directory layout. Delegates to core's `getPlatformPaths`
 * for cross-OS data/config roots, then layers CleoOS sub-paths.
 *
 * @returns Resolved CleoOS directory paths.
 */
function resolveCleoOsPaths(): {
  data: string;
  config: string;
  agentDir: string;
  extensions: string;
  cant: string;
  auth: string;
} {
  const { data, config } = getPlatformPaths();
  return {
    data,
    config,
    agentDir: data,
    extensions: join(data, 'extensions'),
    cant: join(data, 'cant'),
    auth: join(config, 'auth'),
  };
}

// ---------------------------------------------------------------------------
// Global install detection
// ---------------------------------------------------------------------------

/**
 * Detect whether this is a global npm / pnpm install.
 *
 * Uses four heuristics in priority order:
 *  1. `npm_config_global=true` env var (set by npm/pnpm for global installs)
 *  2. Package path contains `lib/node_modules/` (npm global pattern)
 *  3. Package path starts with `npm_config_prefix` (npm prefix-based check)
 *  4. Presence of `pnpm-workspace.yaml` two levels up (workspace = dev)
 *
 * @returns `true` if the install appears to be a global install.
 */
function isGlobalInstall(): boolean {
  const pkgRoot = resolve(__dirname, '..');

  // Signal 1: npm_config_global env var (set by npm during global installs)
  if (process.env['npm_config_global'] === 'true') return true;

  // Signal 2: path contains a global node_modules (npm, pnpm, yarn)
  if (/[/\\]lib[/\\]node_modules[/\\]/.test(pkgRoot)) return true;

  // Signal 3: npm_config_prefix matches the package path
  const prefix = process.env['npm_config_prefix'];
  if (prefix !== undefined && pkgRoot.startsWith(prefix)) return true;

  // Signal 4: inside a pnpm workspace — definitely not global
  const workspaceMarker = join(pkgRoot, '..', '..', 'pnpm-workspace.yaml');
  if (existsSync(workspaceMarker)) return false;

  return false;
}

// ---------------------------------------------------------------------------
// Directory scaffolding
// ---------------------------------------------------------------------------

/**
 * Idempotently create a directory if it does not already exist.
 *
 * @param dir - Absolute path to the directory to create.
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    process.stdout.write(`CleoOS: created ${dir}\n`);
  }
}

// ---------------------------------------------------------------------------
// Extension deployment
// ---------------------------------------------------------------------------

/**
 * Copy a compiled extension to the XDG extensions directory.
 *
 * Always overwrites the target so that upgrades deploy the latest version.
 * Extensions are managed files, not user-editable configs.
 *
 * @param extensionName - Filename without the `.js` extension.
 * @param pkgRoot - Absolute path to the installed package root.
 * @param extensionsDir - Absolute path to the XDG extensions directory.
 */
function deployExtension(extensionName: string, pkgRoot: string, extensionsDir: string): void {
  const src = join(pkgRoot, 'extensions', `${extensionName}.js`);
  const dest = join(extensionsDir, `${extensionName}.js`);

  if (!existsSync(src)) {
    process.stdout.write(`CleoOS: skipping ${extensionName}.js (source not found at ${src})\n`);
    return;
  }

  const updating = existsSync(dest);
  cpSync(src, dest, { force: true });
  if (updating) {
    process.stdout.write(`CleoOS: updating extension: ${extensionName}.js\n`);
  } else {
    process.stdout.write(`CleoOS: deployed ${extensionName}.js to ${dest}\n`);
  }
}

// ---------------------------------------------------------------------------
// Extension node_modules symlink
// ---------------------------------------------------------------------------

/**
 * Create a symlink from the extensions directory's `node_modules` to the
 * cleo-os package's `node_modules`.
 *
 * Extensions are compiled JS files copied to `~/.local/share/cleo/extensions/`
 * by {@link deployExtension}. When they use `import("@cleocode/cant")` or
 * `import("@cleocode/core")`, Node's module resolution looks for
 * `node_modules` relative to the extension file's directory. Since the
 * extensions directory has no `node_modules`, the import fails.
 *
 * This function creates:
 *   `<extensionsDir>/node_modules` → `<pkgRoot>/node_modules`
 *
 * so that bare-specifier imports from deployed extensions resolve against the
 * cleo-os package's dependency tree. The symlink is idempotent: if it already
 * points to the correct target, it is left in place; if it points elsewhere
 * (e.g., after a prefix change), it is replaced.
 *
 * @param pkgRoot - Absolute path to the installed cleo-os package root.
 * @param extensionsDir - Absolute path to the XDG extensions directory.
 */
function linkExtensionNodeModules(pkgRoot: string, extensionsDir: string): void {
  const target = join(pkgRoot, 'node_modules');
  const link = join(extensionsDir, 'node_modules');

  // Bail if the package's node_modules doesn't exist (shouldn't happen, but be safe)
  if (!existsSync(target)) {
    process.stdout.write(`CleoOS: skipping node_modules symlink (${target} not found)\n`);
    return;
  }

  try {
    // Check if symlink already exists and points to the right place.
    // Use lstatSync first (doesn't follow symlinks) to handle dangling symlinks.
    let linkExists = false;
    try {
      linkExists = lstatSync(link).isSymbolicLink() || existsSync(link);
    } catch {
      // Path doesn't exist at all — fine, we'll create it
    }

    if (linkExists) {
      try {
        const currentTarget = readlinkSync(link);
        if (currentTarget === target) {
          // Already correct — nothing to do
          return;
        }
      } catch {
        // readlinkSync fails if it's not a symlink — remove and re-create
      }
      // Points elsewhere or is stale — remove and re-create
      unlinkSync(link);
    }
  } catch {
    // Cleanup failed — try creating anyway
  }

  try {
    symlinkSync(target, link, 'dir');
    process.stdout.write(`CleoOS: linked extensions/node_modules → ${target}\n`);
  } catch (err: unknown) {
    // Best-effort: log and continue. The extension has a createRequire fallback.
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`CleoOS: warning: could not symlink node_modules: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Default CANT file scaffolding
// ---------------------------------------------------------------------------

/**
 * Write a default `model-routing.cant` stub to the XDG CANT directory if
 * no `.cant` files are present. This gives the user a starting point for
 * CANT declarations without overwriting any existing work.
 *
 * @param cantDir - Absolute path to the XDG CANT directory.
 */
function scaffoldDefaultCant(cantDir: string): void {
  const modelRoutingPath = join(cantDir, 'model-routing.cant');
  if (existsSync(modelRoutingPath)) return;

  const stub = [
    '# CleoOS default model-routing.cant',
    '# Declare agents, teams, and routing rules here.',
    '# See: https://github.com/kryptobaseddev/cleo/blob/main/docs/cant-dsl.md',
    '',
  ].join('\n');

  try {
    writeFileSync(modelRoutingPath, stub, 'utf-8');
    process.stdout.write(`CleoOS: created default ${modelRoutingPath}\n`);
  } catch {
    // Best-effort: non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Starter bundle deployment
// ---------------------------------------------------------------------------

/**
 * Deploy the starter CANT bundle to the global XDG CANT directory.
 *
 * Copies `starter-bundle/` contents (team.cant + agents/*.cant) to
 * `~/.local/share/cleo/cant/starter/`. Always overwrites existing files
 * so that upgrades deploy the latest bundle versions. These are managed
 * files in the global tier, not user-editable project configs.
 *
 * @param pkgRoot - Absolute path to the installed package root.
 * @param cantDir - Absolute path to the XDG CANT directory.
 */
function deployStarterBundle(pkgRoot: string, cantDir: string): void {
  const bundleSrc = join(pkgRoot, 'starter-bundle');
  if (!existsSync(bundleSrc)) {
    process.stdout.write('CleoOS: skipping starter bundle (source not found)\n');
    return;
  }

  const starterDest = join(cantDir, 'starter');
  const agentsDest = join(starterDest, 'agents');

  // Ensure destination directories exist
  ensureDir(starterDest);
  ensureDir(agentsDest);

  // Copy team.cant (always overwrite on upgrade)
  const teamSrc = join(bundleSrc, 'team.cant');
  const teamDest = join(starterDest, 'team.cant');
  if (existsSync(teamSrc)) {
    const updating = existsSync(teamDest);
    cpSync(teamSrc, teamDest, { force: true });
    process.stdout.write(
      updating
        ? `CleoOS: updating extension: starter team.cant\n`
        : `CleoOS: deployed starter team.cant to ${teamDest}\n`,
    );
  }

  // Copy agent .cant files (always overwrite on upgrade)
  const agentsSrcDir = join(bundleSrc, 'agents');
  if (existsSync(agentsSrcDir)) {
    try {
      const entries = readdirSync(agentsSrcDir);
      for (const entry of entries) {
        if (!entry.endsWith('.cant')) continue;
        const src = join(agentsSrcDir, entry);
        const dest = join(agentsDest, entry);
        const updating = existsSync(dest);
        cpSync(src, dest, { force: true });
        process.stdout.write(
          updating
            ? `CleoOS: updating extension: starter ${entry}\n`
            : `CleoOS: deployed starter ${entry} to ${dest}\n`,
        );
      }
    } catch {
      // Best-effort: non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Skill installation
// ---------------------------------------------------------------------------

/**
 * Invoke `cleo skills install` via `execFileSync` to register the CleoOS
 * bundled skills with the project. This is best-effort — if `cleo` is not
 * on PATH or the command fails, we log and continue.
 *
 * Uses `execFileSync` (not `exec`) to prevent shell injection: the command
 * and arguments are passed as separate parameters so no shell is spawned.
 */
function installSkills(): void {
  try {
    execFileSync('cleo', ['skills', 'install'], { stdio: 'inherit' });
    process.stdout.write('CleoOS: skills install complete\n');
  } catch {
    // cleo may not be installed or skills may already be up to date.
    process.stdout.write('CleoOS: skipping skills install (cleo not found or already installed)\n');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point for the CleoOS postinstall script.
 *
 * Orchestrates directory scaffolding, extension deployment, node_modules
 * linking, CANT stub creation, and optional skill installation. All
 * operations are idempotent.
 */
function main(): void {
  if (!isGlobalInstall()) {
    process.stdout.write('CleoOS: skipping postinstall (not global install)\n');
    return;
  }

  const paths = resolveCleoOsPaths();
  const pkgRoot = resolve(__dirname, '..');

  // 1. Scaffold XDG directories
  for (const dir of [paths.data, paths.config, paths.extensions, paths.cant, paths.auth]) {
    ensureDir(dir);
  }

  // 2. Deploy compiled extensions
  // tui-theme is a shared library imported by all other extensions — deploy first.
  deployExtension('tui-theme', pkgRoot, paths.extensions);
  deployExtension('cleo-startup', pkgRoot, paths.extensions);
  deployExtension('cleo-cant-bridge', pkgRoot, paths.extensions);
  deployExtension('cleo-hooks-bridge', pkgRoot, paths.extensions);
  deployExtension('cleo-chatroom', pkgRoot, paths.extensions);
  deployExtension('cleo-agent-monitor', pkgRoot, paths.extensions);

  // 2b. Symlink extensions/node_modules → pkgRoot/node_modules so that
  // deployed extensions can resolve @cleocode/* and @mariozechner/*
  // bare-specifier imports against the cleo-os dependency tree.
  linkExtensionNodeModules(pkgRoot, paths.extensions);

  // 3. Write default CANT stub (only if file does not exist)
  scaffoldDefaultCant(paths.cant);

  // 4. Deploy starter CANT bundle (team + agents) to global tier
  deployStarterBundle(pkgRoot, paths.cant);

  // 5. Install CleoOS skills (best-effort)
  installSkills();

  process.stdout.write('CleoOS: postinstall complete\n');
}

main();
