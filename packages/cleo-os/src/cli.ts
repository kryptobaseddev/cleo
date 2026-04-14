#!/usr/bin/env node
/**
 * CleoOS launcher — the batteries-included agentic development environment.
 *
 * Wraps Pi's `main()` entry point with the cleo-cant-bridge pre-loaded
 * as an extension. Pi stays upstream (ULTRAPLAN L1). This is a thin
 * launcher that injects CleoOS extensions into Pi's CLI argument list.
 *
 * Usage: `cleoos [pi-args...]` — launches Pi with CANT bridge extension.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCleoOsPaths } from './xdg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read the version field from a package.json file.
 *
 * @param packageJsonPath - Absolute path to a package.json file.
 * @returns The version string, or 'unknown' if not readable.
 */
function readPackageVersion(packageJsonPath: string): string {
  try {
    const raw = readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Handle version flags before delegating to Pi.
 *
 * - `--version` / `-V`: prints the CleoOS version from its own package.json.
 * - `--cleo-version`: prints the @cleocode/cleo CLI version.
 *
 * @param args - User-supplied CLI arguments.
 * @returns `true` if a version flag was handled (caller should exit), `false` otherwise.
 */
function handleVersionFlags(args: string[]): boolean {
  if (args.includes('--version') || args.includes('-V')) {
    const version = readPackageVersion(join(__dirname, '..', 'package.json'));
    console.log(`CleoOS v${version}`);
    return true;
  }

  if (args.includes('--cleo-version')) {
    // Resolve @cleocode/cleo package.json via require.resolve pattern
    let cleoVersion = 'unknown';
    try {
      const cleoPkgPath = join(
        __dirname,
        '..',
        'node_modules',
        '@cleocode',
        'cleo',
        'package.json',
      );
      cleoVersion = readPackageVersion(cleoPkgPath);
    } catch {
      // fallback: already 'unknown'
    }
    console.log(`CLEO CLI v${cleoVersion}`);
    return true;
  }

  return false;
}

/**
 * Collect CleoOS extension paths that exist on disk.
 *
 * Resolves the CANT bridge extension from the XDG data directory.
 * Only returns paths for extensions that actually exist on the filesystem.
 *
 * @returns Array of absolute extension file paths.
 */
function collectExtensionPaths(): string[] {
  const paths = resolveCleoOsPaths();
  const extensions: string[] = [];

  // cleo-startup: branded session banner + memory bridge display (load first
  // so the welcome panel appears before CANT bridge status bar entries)
  const startupPath = join(paths.extensions, 'cleo-startup.js');
  if (existsSync(startupPath)) {
    extensions.push(startupPath);
  }

  const bridgePath = join(paths.extensions, 'cleo-cant-bridge.js');
  if (existsSync(bridgePath)) {
    extensions.push(bridgePath);
  }

  // cleo-hooks-bridge: CAAMP hooks (PreToolUse, PostToolUse, SubagentStart)
  const hooksBridgePath = join(paths.extensions, 'cleo-hooks-bridge.js');
  if (existsSync(hooksBridgePath)) {
    extensions.push(hooksBridgePath);
  }

  // cleo-chatroom: inter-agent messaging TUI
  const chatroomPath = join(paths.extensions, 'cleo-chatroom.js');
  if (existsSync(chatroomPath)) {
    extensions.push(chatroomPath);
  }

  const monitorPath = join(paths.extensions, 'cleo-agent-monitor.js');
  if (existsSync(monitorPath)) {
    extensions.push(monitorPath);
  }

  return extensions;
}

/**
 * Build the argument list for Pi's `main()`, injecting CleoOS extensions.
 *
 * Takes the user's CLI arguments (everything after `cleoos`) and prepends
 * `--extension <path>` flags for each discovered CleoOS extension.
 *
 * @param userArgs - Arguments passed to `cleoos` by the user.
 * @param extensionPaths - Resolved extension paths to inject.
 * @returns Combined argument array for Pi's `main()`.
 */
function buildArgs(userArgs: string[], extensionPaths: string[]): string[] {
  const extensionFlags = extensionPaths.flatMap((p) => ['--extension', p]);
  return [...extensionFlags, ...userArgs];
}

/**
 * Entry point for the `cleoos` binary.
 *
 * Dynamically imports Pi's coding agent (peerDependency), resolves CleoOS
 * extension paths, and delegates to Pi's `main()` with the bridge extension
 * injected into the argument list.
 *
 * Exits with code 1 if Pi is not installed, providing install instructions.
 */
async function main(): Promise<void> {
  // Intercept version flags before touching Pi — prevents Pi from printing
  // its own version (e.g. 0.67.1) when the user asks for CleoOS's version.
  const userArgs = process.argv.slice(2);
  if (handleVersionFlags(userArgs)) {
    return;
  }

  // Dynamically import Pi — it's a peerDependency, may not be installed
  let piMain: (args: string[]) => Promise<void>;
  try {
    const pi = await import('@mariozechner/pi-coding-agent');
    piMain = pi.main;
  } catch {
    console.error(
      'CleoOS requires Pi Coding Agent to be installed.\n' +
        'Run: npm install -g @mariozechner/pi-coding-agent\n' +
        'Then try again: cleoos',
    );
    process.exit(1);
  }

  const extensionPaths = collectExtensionPaths();
  const args = buildArgs(userArgs, extensionPaths);

  await piMain(args);
}

main().catch((err: unknown) => {
  console.error('CleoOS fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
