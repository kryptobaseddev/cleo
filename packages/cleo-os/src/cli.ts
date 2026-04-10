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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCleoOsPaths } from './xdg.js';

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

  const bridgePath = join(paths.extensions, 'cleo-cant-bridge.js');
  if (existsSync(bridgePath)) {
    extensions.push(bridgePath);
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
  const args = buildArgs(process.argv.slice(2), extensionPaths);

  await piMain(args);
}

main().catch((err: unknown) => {
  console.error('CleoOS fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
