/**
 * Platform compatibility layer.
 *
 * Detects the runtime platform and provides cross-platform utilities
 * for timestamps, checksums, temp files, and tool detection.
 *
 * @task T4454
 * @epic T4454
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

/** Detected platform. */
export type Platform = 'linux' | 'macos' | 'windows' | 'unknown';

/** Detect the current platform. */
export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'linux': return 'linux';
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'unknown';
  }
}

/** Cached platform value. */
export const PLATFORM: Platform = detectPlatform();

/** Check if a command exists on PATH. */
export function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    // On Windows, 'which' may not exist
    if (PLATFORM === 'windows') {
      try {
        execFileSync('where', [command], { stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Require a tool to be available, returning an error message if missing. */
export function requireTool(tool: string, installHint?: string): { available: boolean; error?: string } {
  if (commandExists(tool)) {
    return { available: true };
  }

  let error = `Required tool not found: ${tool}`;
  if (installHint) error += `. Install with: ${installHint}`;
  return { available: false, error };
}

/** Check all required tools. */
export function checkRequiredTools(
  tools: Array<{ name: string; installHint?: string }>,
): { allAvailable: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const tool of tools) {
    if (!commandExists(tool.name)) {
      missing.push(tool.name);
    }
  }

  return { allAvailable: missing.length === 0, missing };
}

/** Get ISO 8601 UTC timestamp. */
export function getIsoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Convert ISO timestamp to epoch seconds. */
export function isoToEpoch(isoTimestamp: string): number {
  return Math.floor(new Date(isoTimestamp).getTime() / 1000);
}

/** Get ISO date for N days ago. */
export function dateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/** Get file size in bytes. */
export function getFileSize(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return statSync(filePath).size;
}

/** Get file modification time as ISO string. */
export function getFileMtime(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mtime.toISOString();
}

/** Generate N random hex characters. */
export function generateRandomHex(bytes: number = 6): string {
  return randomBytes(bytes).toString('hex');
}

/** Compute SHA-256 checksum of a string. */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Create a temporary file path. */
export function createTempFilePath(prefix: string = 'cleo-', suffix: string = '.tmp'): string {
  const random = generateRandomHex(8);
  return join(tmpdir(), `${prefix}${random}${suffix}`);
}

/** Minimum required Node.js major version. */
export const MINIMUM_NODE_MAJOR = 24;

/** Get Node.js version info. */
export function getNodeVersionInfo(): {
  version: string;
  major: number;
  minor: number;
  patch: number;
  meetsMinimum: boolean;
} {
  const version = process.version.replace('v', '');
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);

  return {
    version,
    major,
    minor,
    patch,
    meetsMinimum: major >= MINIMUM_NODE_MAJOR,
  };
}

/**
 * Get platform-specific Node.js upgrade instructions.
 * Returns actionable install/upgrade guidance based on OS and available tools.
 */
export function getNodeUpgradeInstructions(): {
  platform: Platform;
  arch: string;
  instructions: string[];
  recommended: string;
} {
  const platform = detectPlatform();
  const arch = process.arch;
  const instructions: string[] = [];

  // Check for version managers first
  const hasFnm = commandExists('fnm');
  const hasNvm = commandExists('nvm') || commandExists('nvm.sh');
  const hasVolta = commandExists('volta');

  if (hasFnm) {
    instructions.push(`fnm install ${MINIMUM_NODE_MAJOR} && fnm use ${MINIMUM_NODE_MAJOR}`);
  }
  if (hasNvm) {
    instructions.push(`nvm install ${MINIMUM_NODE_MAJOR} && nvm use ${MINIMUM_NODE_MAJOR}`);
  }
  if (hasVolta) {
    instructions.push(`volta install node@${MINIMUM_NODE_MAJOR}`);
  }

  // Platform-specific fallbacks
  switch (platform) {
    case 'linux':
      if (commandExists('dnf')) {
        instructions.push(`sudo dnf module enable nodejs:${MINIMUM_NODE_MAJOR} && sudo dnf install nodejs`);
      } else if (commandExists('apt')) {
        instructions.push(`curl -fsSL https://deb.nodesource.com/setup_${MINIMUM_NODE_MAJOR}.x | sudo -E bash - && sudo apt install -y nodejs`);
      } else if (commandExists('pacman')) {
        instructions.push(`sudo pacman -S nodejs`);
      } else if (commandExists('apk')) {
        instructions.push(`apk add nodejs npm`);
      }
      break;
    case 'macos':
      if (commandExists('brew')) {
        instructions.push(`brew install node@${MINIMUM_NODE_MAJOR}`);
      }
      break;
    case 'windows':
      instructions.push(`winget install OpenJS.NodeJS.LTS`);
      break;
  }

  // Universal fallback
  if (!hasFnm && !hasNvm && !hasVolta) {
    instructions.push(`curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${MINIMUM_NODE_MAJOR}`);
  }
  instructions.push(`https://nodejs.org/en/download/`);

  const recommended = instructions[0] ?? `https://nodejs.org/en/download/`;

  return { platform, arch, instructions, recommended };
}

// =============================================================================
// File I/O re-exports
//
// dispatch/engines/ must import from core/, not store/ directly (ADR-008).
// These re-exports make store/file-utils available to the engine layer via
// the core boundary without creating inverted dependencies.
// =============================================================================

export {
  resolveProjectRoot,
  getDataPath,
  readJsonFile,
  writeJsonFileAtomic,
  readLogFileEntries,
} from '../store/file-utils.js';
