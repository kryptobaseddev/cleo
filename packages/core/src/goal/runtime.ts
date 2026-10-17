/**
 * Find the goal runtime (OpenCode-Goal) and say how to hand it a goal
 * (T13821). Read-only: it never installs anything; the install commands are
 * returned for the owner or agent to run.
 *
 * @epic T13791
 * @task T13821
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GoalRuntimeHandoff } from '@cleocode/contracts';
import { executableOnPath } from '../resources/heavy-command.js';

/**
 * The OpenCode-Goal release `cleo go` asks for. OCG ships from GitHub, not
 * npm (OpenCode >= 2.0.22 installs it as a plugin).
 * shortcut: a pinned tag, bump with each OCG release; replace with the npm optionalDependency once OCG publishes (T13819).
 */
export const OCG_RELEASE_TAG = 'v0.5.1';

/** The OpenCode config files that may list the plugin. */
function opencodeConfigs(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    join(root, 'opencode.json'),
    join(root, 'opencode.jsonc'),
    join(root, '.opencode', 'opencode.json'),
    join(root, '.opencode', 'opencode.jsonc'),
    join(xdg, 'opencode', 'opencode.json'),
    join(xdg, 'opencode', 'opencode.jsonc'),
  ];
}

/**
 * Whether OpenCode-Goal is installed: the `ocg` binary on PATH, or the plugin
 * named in an OpenCode config.
 *
 * @param root - Project root.
 * @param env - Environment (`PATH`, `HOME`, `XDG_CONFIG_HOME`).
 * @returns The runtime, with the install commands when it is missing.
 */
export function detectGoalRuntime(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoalRuntimeHandoff {
  if (executableOnPath('ocg', env.PATH)) {
    return {
      name: 'opencode-goal',
      installed: true,
      via: 'path',
      next: 'Start the goal with OpenCode-Goal.',
    };
  }
  const listed = opencodeConfigs(root, env).some((path) => {
    try {
      return existsSync(path) && readFileSync(path, 'utf8').includes('opencode-goal');
    } catch {
      return false;
    }
  });
  if (listed) {
    return {
      name: 'opencode-goal',
      installed: true,
      via: 'opencode-config',
      next: 'Start the goal with OpenCode-Goal.',
    };
  }
  return {
    name: 'opencode-goal',
    installed: false,
    install: [
      `opencode plugin add "github:kryptobaseddev/opencode-goal#${OCG_RELEASE_TAG}"`,
      'opencode reload',
    ],
    next: `OpenCode-Goal is not installed. It needs OpenCode 2.0.22 or later; install it with: opencode plugin add "github:kryptobaseddev/opencode-goal#${OCG_RELEASE_TAG}" && opencode reload`,
  };
}

/**
 * The runtime with the exact next step for one drafted goal.
 *
 * @param runtime - From {@link detectGoalRuntime}.
 * @param slug - The drafted goal's slug.
 * @returns The handoff.
 */
export function goalRuntimeHandoff(runtime: GoalRuntimeHandoff, slug: string): GoalRuntimeHandoff {
  return runtime.installed
    ? { ...runtime, next: `In OpenCode, run: /goal start ${slug}` }
    : { ...runtime, next: `${runtime.next}; then in OpenCode run: /goal start ${slug}` };
}
