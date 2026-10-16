/**
 * Read the owner-auth password from the terminal with echo off (T1118 L4c),
 * shared by `cleo session start --owner-auth` and the owner-only
 * `cleo config set evidence.overrideCapPerSession` (T13787).
 *
 * @task T1118
 * @task T13787
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { cliError } from '../renderers/index.js';

/** A stdin that may support raw mode. */
type RawStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

/**
 * Prompt for the owner-auth password on an interactive TTY.
 *
 * @param purpose - What the password is for, shown in the prompt.
 * @param operation - Operation name for the error envelope.
 * @returns The password, or null when there is no TTY or the owner cancelled.
 * @task T1118
 * @task T13787
 */
export async function readOwnerPassword(
  purpose: string,
  operation: string,
): Promise<string | null> {
  // T1118 L4c — must be a TTY.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    cliError(
      'owner-auth requires an interactive TTY. stdin.isTTY or stderr.isTTY is false.',
      ExitCode.GENERAL_ERROR,
      { name: 'E_TTY_REQUIRED' },
      { operation },
    );
    return null;
  }
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write(`[cleo] Enter owner-auth password for ${purpose}: `);
  const stdin = process.stdin as RawStdin;
  const password = await new Promise<string>((resolve) => {
    stdin.setRawMode?.(true);
    let pw = '';
    stdin.on('data', function onData(char: Buffer) {
      const ch = char.toString('utf8');
      if (ch === '\n' || ch === '\r') {
        stdin.removeListener('data', onData);
        stdin.pause();
        stdin.setRawMode?.(false);
        process.stderr.write('\n');
        resolve(pw);
      } else if (ch === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n[cleo] Cancelled.\n');
        resolve('');
      } else if (ch === '\u007f' || ch === '\b') {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    });
    stdin.resume();
  });
  rl.close();
  return password || null;
}
