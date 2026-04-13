/**
 * Pi Adapter
 *
 * Main CLEOProviderAdapter implementation for the Pi coding agent
 * (https://github.com/badlogic/pi-mono). Pi is CAAMP's first-class primary
 * harness and owns skills, instructions, extensions, and subagent spawning
 * through native filesystem conventions.
 *
 * Pi supports 11 of 16 CAAMP canonical events through its TypeScript extension
 * system (session_start, session_shutdown, input, turn_end, tool_call,
 * tool_result, before_agent_start, agent_end, before_provider_request, context).
 *
 * Detection: PI_CLI_PATH env var, PI_CODING_AGENT_DIR env var, PI_HOME env var,
 * or presence of ~/.pi/agent/ directory.
 *
 * @task T553
 */

import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { PiHookProvider } from './hooks.js';
import { PiInstallProvider } from './install.js';
import { PiSpawnProvider } from './spawn.js';

const execAsync = promisify(exec);

/**
 * Resolve the Pi global state root directory.
 *
 * Honours `PI_CODING_AGENT_DIR` env var when set (with `~` expansion),
 * then `PI_HOME`, then falls back to `~/.pi/agent`.
 */
function getPiAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  if (env !== undefined && env.length > 0) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  const piHome = process.env['PI_HOME'];
  if (piHome !== undefined && piHome.length > 0) {
    return join(piHome, 'agent');
  }
  return join(homedir(), '.pi', 'agent');
}

/**
 * CLEO provider adapter for Pi coding agent.
 *
 * Bridges CLEO's adapter system with Pi's native capabilities:
 * - Hooks: Maps Pi events (session_start, tool_call, etc.) to CAAMP events
 * - Spawn: Launches subagent processes via the `pi` CLI
 * - Install: Manages AGENTS.md instruction files and global Pi state root
 *
 * @remarks
 * Pi is CAAMP's first-class primary harness (ADR-035). It supports 11 of 16
 * canonical hook events through its TypeScript extension system. Extensions
 * live at `~/.pi/agent/extensions/` (global) or `<projectDir>/.pi/extensions/`
 * (project scope).
 *
 * The session_shutdown event handler in `cleo-cant-bridge.ts` clears module
 * cache. The adapter's hook mapping ensures that Pi's session lifecycle events
 * are visible in the CAAMP event stream for downstream listeners (e.g. memory
 * refresh triggers, backup triggers).
 *
 * Detection hierarchy (first match wins):
 * 1. `PI_CLI_PATH` env var set
 * 2. `PI_CODING_AGENT_DIR` env var set
 * 3. `PI_HOME` env var set
 * 4. `~/.pi/agent/` directory exists
 * 5. `pi` CLI available in PATH
 */
export class PiAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'pi';
  /** Human-readable provider name. */
  readonly name = 'Pi';
  /** Adapter version string. */
  readonly version = '1.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    // 11/16 canonical events — derived from piEventCatalog in CAAMP hook-mappings.json.
    // ResponseComplete, PostToolUseFailure, PermissionRequest, PostModel, PostCompact,
    // and ConfigChange are not supported by Pi's extension system.
    supportedHookEvents: [
      'SessionStart',
      'SessionEnd',
      'PromptSubmit',
      'Notification',
      'PreToolUse',
      'PostToolUse',
      'SubagentStart',
      'SubagentStop',
      'PreModel',
      'PreCompact',
    ],
    supportsSpawn: true,
    supportsInstall: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'AGENTS.md',
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: true,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  /** Hook provider for CAAMP event mapping and registration. */
  hooks: PiHookProvider;
  /** Spawn provider for launching subagent processes via `pi` CLI. */
  spawn: PiSpawnProvider;
  /** Install provider for managing AGENTS.md instruction files. */
  install: PiInstallProvider;

  /** Project directory this adapter was initialized with, or null. */
  private projectDir: string | null = null;
  /** Whether {@link initialize} has been called. */
  private initialized = false;

  constructor() {
    this.hooks = new PiHookProvider();
    this.spawn = new PiSpawnProvider();
    this.install = new PiInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * Validates the environment by checking for the Pi CLI and Pi state root.
   *
   * @param projectDir - Root directory of the project
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clean up resources.
   *
   * Unregisters hooks and releases any tracked state.
   */
  async dispose(): Promise<void> {
    if (this.hooks.isRegistered()) {
      await this.hooks.unregisterNativeHooks();
    }
    this.initialized = false;
    this.projectDir = null;
  }

  /**
   * Run a health check to verify Pi is accessible.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. Pi CLI is available (via PI_CLI_PATH or `which pi`)
   * 3. Pi global state root (~/.pi/agent/ or PI_CODING_AGENT_DIR) exists
   *
   * @returns Health status with details about each check
   */
  async healthCheck(): Promise<AdapterHealthStatus> {
    const details: Record<string, unknown> = {};

    if (!this.initialized) {
      return {
        healthy: false,
        provider: this.id,
        details: { error: 'Adapter not initialized' },
      };
    }

    // Check Pi CLI availability
    let cliAvailable = false;
    const cliPath = process.env['PI_CLI_PATH'] ?? 'pi';
    try {
      if (cliPath !== 'pi') {
        const { stdout } = await execAsync(`test -x "${cliPath}" && echo ok`);
        cliAvailable = stdout.trim() === 'ok';
        details.cliPath = cliPath;
      } else {
        const { stdout } = await execAsync('which pi');
        cliAvailable = stdout.trim().length > 0;
        details.cliPath = stdout.trim();
      }
    } catch {
      details.cliAvailable = false;
    }

    // Check for Pi global state root
    const agentDir = getPiAgentDir();
    const agentDirExists = existsSync(agentDir);
    details.agentDirExists = agentDirExists;
    details.agentDir = agentDir;

    // Check for project-level .pi/ directory
    if (this.projectDir) {
      const projectPiDir = join(this.projectDir, '.pi');
      details.projectPiDirExists = existsSync(projectPiDir);
    }

    // Check detection env vars
    details.piCodingAgentDirSet = process.env['PI_CODING_AGENT_DIR'] !== undefined;
    details.piHomeSet = process.env['PI_HOME'] !== undefined;
    details.piCliPathSet = process.env['PI_CLI_PATH'] !== undefined;

    // Healthy if either CLI is available or global state root exists
    const healthy = cliAvailable || agentDirExists;
    details.cliAvailable = cliAvailable;

    return {
      healthy,
      provider: this.id,
      details,
    };
  }

  /**
   * Check whether the adapter has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project directory this adapter was initialized with.
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }
}
