/**
 * Child runner for the daemon-survives-forced-Pi-error smoke test
 * (T11761 · S2 · T11898).
 *
 * Models the daemon: it pins the process-exit guard at startup, then a Pi code
 * path attempts a daemon-fatal `process.exit(1)`. The guard MUST neutralize it
 * — the call throws a typed containment error, the daemon process SURVIVES, and
 * the runner exits 0 after emitting a typed error envelope to stdout. If the
 * trap failed, this process would terminate with exit code 1 instead.
 *
 * Run with `tsx`. Not a vitest file (lives under `fixtures/`).
 */

import { createEnvelope } from '@cleocode/lafs';
import { installDaemonExitGuard, isPiContainmentError, wrapPiCall } from '../../pi-errors.js';

async function main(): Promise<void> {
  // Daemon bootstrap: pin the exit trap for the whole process lifetime.
  const unpin = installDaemonExitGuard();
  process.stderr.write('daemon: exit guard pinned\n');

  let contained = false;
  let piCode = '';
  try {
    await wrapPiCall(async () => {
      process.stderr.write('pi: simulating daemon-fatal process.exit(1)\n');
      // This MUST be trapped — a real exit would kill the daemon here.
      process.exit(1);
    });
  } catch (err) {
    if (isPiContainmentError(err)) {
      contained = true;
      piCode = err.piCode;
    } else {
      process.stderr.write(`daemon: unexpected non-containment error: ${String(err)}\n`);
    }
  }

  // The daemon is still alive — emit a typed error envelope to stdout (ADR-086).
  const envelope = createEnvelope({
    success: false,
    result: { contained, piCode },
    meta: { operation: 'pi.exit-trap', requestId: 'fixture-survive-1' },
    error: {
      code: piCode || 'E_PI_PROCESS_EXIT_TRAPPED',
      message: 'Pi process.exit neutralized; daemon survived',
    },
  });
  process.stdout.write(`${JSON.stringify(envelope)}\n`);

  unpin();
  // Survived: exit cleanly (0). A failed trap would have exited 1 above.
  process.exit(contained ? 0 : 2);
}

main().catch((err) => {
  process.stderr.write(`fixture error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
});
