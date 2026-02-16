/**
 * Execution Mode Detector
 *
 * Detects whether the CLEO CLI is available and determines the execution mode
 * for the MCP server. Supports three modes:
 *
 * - native: TypeScript engine only (cross-platform, no bash needed)
 * - cli: CLI subprocess only (Unix, requires bash + jq)
 * - auto: Detect CLI availability; prefer CLI when found, fallback to native
 *
 * Controlled by MCP_EXECUTION_MODE environment variable.
 */

import { execFileSync } from 'child_process';

/**
 * Execution mode for the MCP server
 */
export type ServerExecutionMode = 'native' | 'cli' | 'auto';

/**
 * Resolved execution mode after detection
 */
export type ResolvedMode = 'native' | 'cli';

/**
 * Detection result with metadata
 */
export interface ModeDetectionResult {
  /** The resolved execution mode */
  mode: ResolvedMode;
  /** The configured mode (from env) */
  configuredMode: ServerExecutionMode;
  /** Whether CLI was detected as available */
  cliAvailable: boolean;
  /** Path to CLI binary (if found) */
  cliPath: string | null;
  /** CLI version (if available) */
  cliVersion: string | null;
  /** Reason for mode selection */
  reason: string;
}

/**
 * Detect CLI availability and determine execution mode.
 *
 * Priority:
 * 1. MCP_EXECUTION_MODE env: 'cli' (force CLI), 'native' (force native), 'auto' (default)
 * 2. If auto: check CLEO_MCP_CLI_PATH env -> if set and executable, prefer CLI
 * 3. If auto: check which/where cleo -> if found, prefer CLI
 * 4. If auto: no CLI found -> native mode
 */
export function detectExecutionMode(): ModeDetectionResult {
  const configuredMode = getConfiguredMode();

  // Force native mode
  if (configuredMode === 'native') {
    return {
      mode: 'native',
      configuredMode,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      reason: 'MCP_EXECUTION_MODE=native (forced)',
    };
  }

  // Check CLI availability
  const cliCheck = checkCLIAvailability();

  // Force CLI mode
  if (configuredMode === 'cli') {
    if (!cliCheck.available) {
      return {
        mode: 'cli',
        configuredMode,
        cliAvailable: false,
        cliPath: null,
        cliVersion: null,
        reason: 'MCP_EXECUTION_MODE=cli (forced, but CLI not found - operations will fail)',
      };
    }
    return {
      mode: 'cli',
      configuredMode,
      cliAvailable: true,
      cliPath: cliCheck.path,
      cliVersion: cliCheck.version,
      reason: 'MCP_EXECUTION_MODE=cli (forced)',
    };
  }

  // Auto mode: detect CLI
  if (cliCheck.available) {
    return {
      mode: 'cli',
      configuredMode: 'auto',
      cliAvailable: true,
      cliPath: cliCheck.path,
      cliVersion: cliCheck.version,
      reason: `CLI detected at ${cliCheck.path} (auto mode, preferring CLI)`,
    };
  }

  return {
    mode: 'native',
    configuredMode: 'auto',
    cliAvailable: false,
    cliPath: null,
    cliVersion: null,
    reason: 'CLI not found (auto mode, using native TypeScript engine)',
  };
}

/**
 * Get configured mode from environment
 */
function getConfiguredMode(): ServerExecutionMode {
  const env = process.env.MCP_EXECUTION_MODE?.toLowerCase();
  if (env === 'native' || env === 'cli' || env === 'auto') {
    return env;
  }
  return 'auto';
}

/**
 * Check if CLEO CLI is available
 */
function checkCLIAvailability(): {
  available: boolean;
  path: string | null;
  version: string | null;
} {
  // 1. Check CLEO_MCP_CLI_PATH env
  const envPath = process.env.CLEO_MCP_CLI_PATH;
  if (envPath) {
    const result = testCLIPath(envPath);
    if (result.available) {
      return result;
    }
  }

  // 2. Check standard CLI path from config
  const configPath = process.env.CLEO_CLI_PATH;
  if (configPath) {
    const result = testCLIPath(configPath);
    if (result.available) {
      return result;
    }
  }

  // 3. Try which/where command to find cleo in PATH
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  for (const binary of ['cleo', 'ct']) {
    try {
      const cliPath = execFileSync(whichCmd, [binary], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n')[0];

      if (cliPath) {
        const result = testCLIPath(cliPath);
        if (result.available) {
          return result;
        }
      }
    } catch {
      // Binary not found in PATH
    }
  }

  return { available: false, path: null, version: null };
}

/**
 * Test if a CLI path is executable and returns a version.
 * Uses execFileSync (no shell) to prevent command injection.
 */
function testCLIPath(cliPath: string): {
  available: boolean;
  path: string | null;
  version: string | null;
} {
  try {
    const output = execFileSync(cliPath, ['version', '--json'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    try {
      const parsed = JSON.parse(output);
      const version = parsed.version || parsed.data?.version || null;
      return { available: true, path: cliPath, version };
    } catch {
      // Non-JSON output but command succeeded
      return { available: true, path: cliPath, version: null };
    }
  } catch {
    return { available: false, path: null, version: null };
  }
}

/**
 * Create the E_CLI_REQUIRED error response
 */
export function createCLIRequiredError(domain: string, operation: string): {
  success: false;
  error: {
    code: string;
    message: string;
    availableInStandaloneMode: boolean;
    nativeAlternatives: string[];
  };
} {
  return {
    success: false,
    error: {
      code: 'E_CLI_REQUIRED',
      message: `Operation '${domain}.${operation}' requires the CLEO CLI (bash). Install with: ./install.sh`,
      availableInStandaloneMode: false,
      nativeAlternatives: [],
    },
  };
}

/**
 * Create the E_NOT_INITIALIZED error response
 */
export function createNotInitializedError(): {
  success: false;
  error: {
    code: string;
    message: string;
    fix: string;
  };
} {
  return {
    success: false,
    error: {
      code: 'E_NOT_INITIALIZED',
      message: 'CLEO project not initialized. Run system.init or set CLEO_AUTO_INIT=true',
      fix: "cleo_mutate({domain: 'system', operation: 'init'})",
    },
  };
}
