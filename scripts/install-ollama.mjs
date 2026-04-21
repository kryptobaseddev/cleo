#!/usr/bin/env node
/**
 * Ollama auto-installer for CLEO.
 *
 * Runs as a postinstall script. Installs Ollama if not already present and
 * pulls the recommended warm-tier model (gemma4:e2b or fallback) in the
 * background.
 *
 * DESIGN PRINCIPLES:
 *   - NEVER fail npm install — all errors are caught and logged as warnings
 *   - Idempotent — safe to run multiple times
 *   - Non-blocking — model pull does not block install completion
 *   - Cross-platform — handles Linux, macOS, Windows gracefully
 *
 * @task T730
 * @epic T726
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

const RECOMMENDED_MODEL = 'gemma4:e4b-it';
const FALLBACK_MODEL = 'llama3.2:3b';
const INSTALL_TIMEOUT_MS = 300_000; // 5 minutes max for installer
const MODEL_PULL_TIMEOUT_MS = 600_000; // 10 minutes max for model pull

/**
 * Check if Ollama binary is already installed and reachable.
 */
function isOllamaInstalled() {
  try {
    execFileSync('ollama', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific Ollama model is already pulled.
 */
function isModelPulled(modelName) {
  try {
    const result = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0 || result.error) return false;
    return result.stdout.includes(modelName.split(':')[0]);
  } catch {
    return false;
  }
}

/**
 * Install Ollama on Linux or macOS using the official install script.
 *
 * @returns true on success, false on failure
 */
function installOllamaUnix() {
  console.log('[CLEO] Installing Ollama (required for local LLM extraction)...');
  try {
    // Official Ollama install script — curl to sh pattern
    execFileSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
      stdio: 'inherit',
      timeout: INSTALL_TIMEOUT_MS,
    });
    console.log('[CLEO] Ollama installed successfully.');
    return true;
  } catch (err) {
    console.warn('[CLEO] Ollama installation failed (non-fatal):', err.message ?? String(err));
    return false;
  }
}

/**
 * Pull the recommended Ollama model in the foreground.
 * Falls back to a smaller model if the recommended one fails.
 */
function pullModel(modelName) {
  console.log(`[CLEO] Pulling model ${modelName} (this may take several minutes)...`);
  try {
    execFileSync('ollama', ['pull', modelName], {
      stdio: 'inherit',
      timeout: MODEL_PULL_TIMEOUT_MS,
    });
    console.log(`[CLEO] Model ${modelName} ready.`);
    return true;
  } catch (err) {
    console.warn(
      `[CLEO] Model pull for ${modelName} failed (non-fatal):`,
      err.message ?? String(err),
    );
    return false;
  }
}

async function main() {
  const os = platform();

  // -------------------------------------------------------------------------
  // Check if Ollama already installed
  // -------------------------------------------------------------------------
  if (isOllamaInstalled()) {
    console.log('[CLEO] Ollama already installed — skipping installation.');

    // Check if recommended model is already pulled
    if (isModelPulled(RECOMMENDED_MODEL)) {
      console.log(`[CLEO] Model ${RECOMMENDED_MODEL} already present.`);
      return;
    }

    // Model not present — pull it (non-blocking warning if fails)
    console.log(`[CLEO] Scheduling model pull for ${RECOMMENDED_MODEL}...`);
    const pulled = pullModel(RECOMMENDED_MODEL);
    if (!pulled) {
      // Try fallback model
      console.log(`[CLEO] Trying fallback model ${FALLBACK_MODEL}...`);
      pullModel(FALLBACK_MODEL);
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Install Ollama per platform
  // -------------------------------------------------------------------------
  if (os === 'linux' || os === 'darwin') {
    const installed = installOllamaUnix();

    if (installed) {
      // Pull the model after installation
      const pulled = pullModel(RECOMMENDED_MODEL);
      if (!pulled) {
        console.log(`[CLEO] Trying fallback model ${FALLBACK_MODEL}...`);
        pullModel(FALLBACK_MODEL);
      }
    } else {
      // Install failed but CLEO will still work (falls back to transformers.js or Sonnet)
      console.log('[CLEO] CLEO will use transformers.js or Claude API as LLM backend.');
      console.log('[CLEO] To enable local LLM: install Ollama from https://ollama.com');
      console.log(`[CLEO] Then run: ollama pull ${RECOMMENDED_MODEL}`);
    }
  } else if (os === 'win32') {
    // Windows: cannot run curl | sh; provide manual instructions
    // Note: CLEO still works without Ollama (falls back to transformers.js or Sonnet)
    const wingetPath =
      existsSync('C:\\Windows\\System32\\winget.exe') ||
      existsSync(process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\winget.exe');

    if (wingetPath) {
      console.log('[CLEO] Attempting Ollama installation via winget...');
      try {
        execFileSync(
          'winget',
          ['install', 'Ollama.Ollama', '--accept-source-agreements', '--accept-package-agreements'],
          {
            stdio: 'inherit',
            timeout: INSTALL_TIMEOUT_MS,
          },
        );
        console.log('[CLEO] Ollama installed via winget. Run: ollama pull ' + RECOMMENDED_MODEL);
      } catch {
        console.log('[CLEO] winget install failed. Manual install required.');
        console.log('[CLEO] Download from: https://ollama.com/download/windows');
        console.log(
          '[CLEO] CLEO will use Claude API (set ANTHROPIC_API_KEY) until Ollama is installed.',
        );
      }
    } else {
      console.log('[CLEO] Windows detected. Ollama requires manual installation:');
      console.log('[CLEO] 1. Download from: https://ollama.com/download/windows');
      console.log('[CLEO] 2. After install, run: ollama pull ' + RECOMMENDED_MODEL);
      console.log(
        '[CLEO] CLEO will use Claude API (set ANTHROPIC_API_KEY) until Ollama is installed.',
      );
    }
  } else {
    console.log(
      `[CLEO] Unsupported platform: ${os}. Install Ollama manually from https://ollama.com`,
    );
    console.log('[CLEO] CLEO will use Claude API as fallback (set ANTHROPIC_API_KEY).');
  }
}

// Run and always exit 0 — postinstall MUST NEVER fail npm install
main().catch((err) => {
  console.warn('[CLEO] Ollama setup skipped (non-fatal):', err?.message ?? String(err));
  process.exit(0);
});
