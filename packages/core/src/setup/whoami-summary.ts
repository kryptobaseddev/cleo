/**
 * Post-wizard whoami summary + TUI-offer helper (T11983).
 *
 * Called after a successful first-run setup completion. Prints a brief
 * identity snapshot to the wizard's `io` surface and offers to launch the
 * CLEO TUI.
 *
 * Lives in `packages/core/src/setup/` alongside the other wizard section
 * modules so the CLI command (`packages/cleo/src/cli/commands/setup.ts`)
 * can import it without violating the CLI-boundary gate (ADR Gate 6 /
 * T9837e / T10076).
 *
 * @module setup/whoami-summary
 * @task T11983
 */

import type { WizardIO } from './wizard.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a best-effort CLEO identity snapshot for the whoami-style summary.
 *
 * Never throws — returns partial data on any config/credential error.
 *
 * @internal
 */
async function _readWhoamiSnapshot(): Promise<{
  agentName: string;
  provider: string;
  model: string;
  credentialCount: number;
}> {
  try {
    const { loadConfig, getConfigValue } = await import('../config.js');
    const { getCredentialPool } = await import('../llm/credential-pool.js');
    const cfg = await loadConfig();
    const nameResult = await getConfigValue<string>('agent.name').catch(() => null);
    const agentName =
      typeof nameResult?.value === 'string' && nameResult.value ? nameResult.value : 'cleo-agent';
    const provider = cfg?.llm?.default?.provider ?? '';
    const model = cfg?.llm?.default?.model ?? '';
    let credentialCount = 0;
    try {
      const pool = getCredentialPool();
      const entries = await pool.list();
      credentialCount = entries.length;
    } catch {
      // best-effort
    }
    return { agentName, provider, model, credentialCount };
  } catch {
    return { agentName: 'cleo-agent', provider: '', model: '', credentialCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print a whoami-style summary to the wizard IO surface and offer to launch
 * the TUI.
 *
 * Called after a successful first-run completion. Output goes to `io.info()`
 * (which routes to stderr in the CLI) so the LAFS envelope already written to
 * stdout is never corrupted.
 *
 * The TUI offer uses `io.confirm()` — if the user accepts, launches
 * `cleo tui` via a child_process spawn (non-blocking fire-and-forget so the
 * wizard process exits cleanly regardless of TUI lifetime).
 *
 * @param io - Wizard I/O surface (for the TUI offer prompt).
 *
 * @task T11983
 */
export async function printWhoamiSummaryAndOfferTui(io: WizardIO): Promise<void> {
  const snap = await _readWhoamiSnapshot();

  const lines = [
    '',
    '─────────────────────────────────────────',
    'CLEO Setup Complete',
    '─────────────────────────────────────────',
    `  Agent name : ${snap.agentName}`,
    `  Provider   : ${snap.provider || '(not set)'}`,
    `  Model      : ${snap.model || '(not set)'}`,
    `  Credentials: ${snap.credentialCount} in pool`,
    '',
    "Run 'cleo whoami' for full identity details.",
    "Run 'cleo llm health' to verify your credentials.",
    '─────────────────────────────────────────',
    '',
  ];
  for (const line of lines) {
    io.info(line);
  }

  // Offer to launch the TUI — non-blocking (fire-and-forget spawn).
  try {
    const launch = await io.confirm('Launch the CLEO TUI now?', false);
    if (launch) {
      io.info("Launching 'cleo tui'…");
      const { spawn } = await import('node:child_process');
      // Detach so the wizard process exits cleanly regardless of TUI lifetime.
      spawn('cleo', ['tui'], {
        stdio: 'inherit',
        detached: false,
      });
    }
  } catch {
    // If the prompt fails (non-TTY or stdin closed), skip silently.
  }
}
