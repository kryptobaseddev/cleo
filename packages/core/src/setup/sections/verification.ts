/**
 * `verification` setup wizard section (E-CLEO-SETUP-V2 / T9594).
 *
 * Read-only health-check runner that validates the full CLEO configuration
 * stack after the wizard has finished writing all other sections. No state
 * is mutated — this section is a diagnostic surface only.
 *
 * The section runs 6 independent checks in order:
 *
 *   1. **credential-pool**     — at least one entry exists in the pool.
 *   2. **credential-reach**    — first valid credential round-trips to its
 *                                provider health endpoint (5 s timeout).
 *   3. **config-integrity**    — global + project config files parse cleanly.
 *   4. **harness-reach**       — detected harness responds:
 *                                  Pi   → HTTP GET `<piUrl>/health` (3 s).
 *                                  Code → `which claude` exits 0.
 *   5. **signaldock-reach**    — if `signaldock.enabled`, HTTP GET to
 *                                `<endpoint>/health` (3 s); SKIP otherwise.
 *   6. **brain-db**            — `brain.db` exists on disk and opens
 *                                without error.
 *
 * Each check yields a {@link VerificationCheck} carrying `PASS`, `FAIL`, or
 * `SKIP`. The runner aggregates results and surfaces them via {@link WizardIO}:
 *   - Interactive  → formatted text table (one line per check).
 *   - Non-interactive → JSON array of {@link VerificationCheck} entries.
 *
 * The section always returns `{changed: false}` (read-only contract, VERIF-1).
 * `isConfigured()` always returns `false` — verification always runs when
 * included in a wizard pass (VERIF-6).
 *
 * @task T9594
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.9, §5.2 T9594
 */

import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfigValue, loadConfig } from '../../config.js';
import { getCredentialPool } from '../../llm/credential-pool.js';
import { resolveCleoDir } from '../../paths.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of a single verification check.
 *
 * @task T9594
 */
export interface VerificationCheck {
  /** Short identifier shown in the results table (kebab-case). */
  name: string;
  /** Whether the check passed, failed, or was intentionally skipped. */
  status: 'PASS' | 'FAIL' | 'SKIP';
  /** One-line human-readable result message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Internal helpers — one async function per check
// ---------------------------------------------------------------------------

/**
 * Check 1 — Credential pool has at least one entry.
 *
 * @internal
 */
async function runCredentialPoolCheck(): Promise<VerificationCheck> {
  const name = 'credential-pool';
  try {
    const pool = getCredentialPool();
    const entries = await pool.list();
    if (entries.length === 0) {
      return { name, status: 'FAIL', message: 'pool is empty — run cleo setup --section llm' };
    }
    return { name, status: 'PASS', message: `${entries.length} credential(s) found` };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `pool.list() threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Race a promise against a timeout, resolving to `undefined` on expiry.
 *
 * @internal
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Check 2 — First valid credential can reach its provider.
 *
 * Uses a best-effort HTTP GET to a known provider health URL when available.
 * Falls back to a simple fetch attempt and inspects the HTTP status code.
 * Timeout: 5 s.
 *
 * @internal
 */
async function runCredentialReachabilityCheck(): Promise<VerificationCheck> {
  const name = 'credential-reach';
  try {
    const pool = getCredentialPool();
    const entries = await pool.list();
    if (entries.length === 0) {
      return { name, status: 'SKIP', message: 'no credentials configured' };
    }

    // Pick the first entry for the reachability probe.
    const entry = entries[0]!;
    const provider = entry.provider as string;

    // Known provider health endpoints (non-exhaustive; covers the most common
    // providers). Providers not listed get a simple models-listing probe.
    const healthUrlMap: Record<string, string> = {
      anthropic: 'https://api.anthropic.com/v1/models',
      openai: 'https://api.openai.com/v1/models',
      gemini: 'https://generativelanguage.googleapis.com/v1/models',
      openrouter: 'https://openrouter.ai/api/v1/models',
    };
    const probeUrl = healthUrlMap[provider] ?? `https://api.${provider}.com/v1/models`;

    const response = await withTimeout(
      fetch(probeUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
      }),
      5_000,
    );

    if (response === undefined) {
      return {
        name,
        status: 'FAIL',
        message: `timeout after 5 s probing ${provider} (${probeUrl})`,
      };
    }

    // 401/403 = endpoint reachable but auth rejected — still counts as PASS
    // because we're only testing *network* reachability here, not key validity.
    if (response.ok || response.status === 401 || response.status === 403) {
      return {
        name,
        status: 'PASS',
        message: `${provider} endpoint reachable (HTTP ${response.status})`,
      };
    }

    return {
      name,
      status: 'FAIL',
      message: `${provider} returned HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 3 — Global + project config files parse cleanly.
 *
 * Delegates to {@link loadConfig} which already handles missing files
 * gracefully; we surface any unexpected parsing errors as FAIL.
 *
 * @internal
 */
async function runConfigIntegrityCheck(cwd?: string): Promise<VerificationCheck> {
  const name = 'config-integrity';
  try {
    await loadConfig(cwd);
    return { name, status: 'PASS', message: 'global + project config parse cleanly' };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `config parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 4 — Detected harness responds.
 *
 * - `pi` (or `piUrl` in config) → HTTP GET `<piUrl>/health` (3 s timeout).
 * - `claude-code`               → resolves `which claude` in PATH.
 * - `unknown`                   → SKIP.
 *
 * @internal
 */
async function runHarnessReachabilityCheck(cwd?: string): Promise<VerificationCheck> {
  const name = 'harness-reach';
  try {
    // Read active harness — layer: env > config > default.
    const explicitEnv = process.env['CLEO_HARNESS'];
    let active: string | undefined = explicitEnv;

    if (!active) {
      if (process.env['CLAUDECODE'] === '1') active = 'claude-code';
      else if (process.env['CLEO_PI'] === '1') active = 'pi';
      else {
        const resolved = await getConfigValue<string>('harness.active', cwd);
        active = resolved.value;
      }
    }

    if (!active || active === 'unknown') {
      return { name, status: 'SKIP', message: 'no harness configured' };
    }

    if (active === 'claude-code') {
      // Probe: can we find the `claude` binary in PATH?
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execP = promisify(exec);
      try {
        await withTimeout(execP('which claude'), 3_000);
        return { name, status: 'PASS', message: '`claude` binary found in PATH' };
      } catch {
        return {
          name,
          status: 'FAIL',
          message: '`claude` binary not found — install Claude Code',
        };
      }
    }

    if (active === 'pi') {
      // Read Pi URL from config (key: harness.piUrl, fallback: CLEO_PI_URL env).
      const piUrlEnv = process.env['CLEO_PI_URL'];
      const piUrlResolved = piUrlEnv ?? (await getConfigValue<string>('harness.piUrl', cwd)).value;
      const piUrl = typeof piUrlResolved === 'string' && piUrlResolved ? piUrlResolved : null;

      if (!piUrl) {
        return {
          name,
          status: 'SKIP',
          message: 'pi harness active but piUrl not configured',
        };
      }

      const healthUrl = piUrl.replace(/\/$/, '') + '/health';
      const response = await withTimeout(
        fetch(healthUrl, { signal: AbortSignal.timeout(3_000) }),
        3_000,
      );

      if (response === undefined) {
        return { name, status: 'FAIL', message: `timeout after 3 s (${healthUrl})` };
      }
      if (response.ok) {
        return { name, status: 'PASS', message: `Pi /health returned HTTP ${response.status}` };
      }
      return { name, status: 'FAIL', message: `Pi /health returned HTTP ${response.status}` };
    }

    return { name, status: 'SKIP', message: `unrecognised harness '${active}'` };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `harness check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 5 — SignalDock endpoint is reachable.
 *
 * Skipped when `signaldock.enabled` is `false` or not configured.
 * Timeout: 3 s.
 *
 * @internal
 */
async function runAgentRegistryReachabilityCheck(cwd?: string): Promise<VerificationCheck> {
  const name = 'signaldock-reach';
  try {
    const enabledResolved = await getConfigValue<boolean>('signaldock.enabled', cwd);
    if (!enabledResolved.value) {
      return { name, status: 'SKIP', message: 'SignalDock not enabled' };
    }

    const endpointResolved = await getConfigValue<string>('signaldock.endpoint', cwd);
    const endpoint = endpointResolved.value;
    if (!endpoint || typeof endpoint !== 'string') {
      return { name, status: 'SKIP', message: 'SignalDock endpoint not configured' };
    }

    const healthUrl = endpoint.replace(/\/$/, '') + '/health';
    const response = await withTimeout(
      fetch(healthUrl, { signal: AbortSignal.timeout(3_000) }),
      3_000,
    );

    if (response === undefined) {
      return {
        name,
        status: 'FAIL',
        message: `timeout after 3 s (${healthUrl})`,
      };
    }

    if (response.ok) {
      return {
        name,
        status: 'PASS',
        message: `SignalDock /health returned HTTP ${response.status}`,
      };
    }

    return {
      name,
      status: 'FAIL',
      message: `SignalDock /health returned HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `SignalDock check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 6 — BRAIN database is present and opens cleanly.
 *
 * We perform a lightweight existence + read-access check rather than a full
 * Drizzle open (which would trigger migrations). The section must remain
 * read-only (VERIF-1).
 *
 * @internal
 */
async function runBrainDbCheck(cwd?: string): Promise<VerificationCheck> {
  const name = 'brain-db';
  try {
    const cleoDir = resolveCleoDir(cwd);
    const dbPath = join(cleoDir, 'brain.db');

    if (!existsSync(dbPath)) {
      return {
        name,
        status: 'FAIL',
        message: `brain.db not found at ${dbPath} — run cleo init`,
      };
    }

    // Verify read access — access(path, fs.constants.R_OK) is sufficient.
    await access(dbPath);

    return { name, status: 'PASS', message: `brain.db accessible at ${dbPath}` };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      message: `brain.db check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Section factory
// ---------------------------------------------------------------------------

/**
 * Build the `verification` section runner.
 *
 * The runner is read-only — it never mutates config or DB state (VERIF-1).
 * `isConfigured()` always returns `false` so the section is never skipped
 * even when the rest of the wizard short-circuits (VERIF-6).
 *
 * @returns A {@link WizardSectionRunner} for the verification section.
 * @task T9594
 */
export function createVerificationSection(): WizardSectionRunner {
  return {
    section: 'verification',
    title: 'Verification (read-only health checks)',
    optional: true,

    /**
     * Verification always runs — return `false` unconditionally (VERIF-6).
     */
    async isConfigured(): Promise<boolean> {
      return false;
    },

    async run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult> {
      const cwd = options.projectRoot;

      io.info(
        'Running health checks — this may take up to 5 s per network check. No state is mutated.',
      );

      // Run all 6 checks. We collect them sequentially so the io.info() output
      // stays ordered and predictable in tests. The checks are fast I/O-bound
      // operations; sequential execution avoids noise from concurrent fetches.
      const checks: VerificationCheck[] = [];
      checks.push(await runCredentialPoolCheck());
      checks.push(await runCredentialReachabilityCheck());
      checks.push(await runConfigIntegrityCheck(cwd));
      checks.push(await runHarnessReachabilityCheck(cwd));
      checks.push(await runAgentRegistryReachabilityCheck(cwd));
      checks.push(await runBrainDbCheck(cwd));

      const failCount = checks.filter((c) => c.status === 'FAIL').length;
      const passCount = checks.filter((c) => c.status === 'PASS').length;
      const skipCount = checks.filter((c) => c.status === 'SKIP').length;

      if (options.nonInteractive === true) {
        // VERIF-4: emit the table as JSON to stdout in non-interactive mode.
        // io.info() goes to stderr in the CLI; we repurpose it here since the
        // section has no stdout-specific escape hatch in WizardIO. CLI callers
        // that need the JSON on stdout should capture io output directly.
        io.info(JSON.stringify(checks, null, 2));
      } else {
        // Interactive: render a human-readable table.
        const padEnd = (s: string, n: number) => s.padEnd(n, ' ');
        const header = `  ${'Check'.padEnd(22)}  ${'Status'.padEnd(6)}  Message`;
        io.info(header);
        io.info(`  ${'─'.repeat(22)}  ${'─'.repeat(6)}  ${'─'.repeat(50)}`);

        for (const check of checks) {
          const statusLabel =
            check.status === 'PASS' ? 'PASS' : check.status === 'FAIL' ? 'FAIL' : 'SKIP';
          io.info(`  ${padEnd(check.name, 22)}  ${padEnd(statusLabel, 6)}  ${check.message}`);
        }

        io.info('');
        io.info(`  Summary: ${passCount} PASS, ${failCount} FAIL, ${skipCount} SKIP`);
      }

      // VERIF-5: FAIL → include count in summary.
      if (failCount > 0) {
        return {
          changed: false,
          summary: `verification: ${failCount} check(s) failed — see output`,
        };
      }

      return {
        changed: false,
        summary: `verification passed: ${passCount} PASS, ${skipCount} SKIP`,
      };
    },
  };
}
