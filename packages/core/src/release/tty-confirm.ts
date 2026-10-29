/**
 * Typed confirmation for `cleo release cut --yes` (owner decision D11212): the
 * person at the controlling terminal types the version. Read from `/dev/tty`,
 * not stdin, so a pipe cannot answer it. It stops casual misuse, not a
 * determined caller who controls a pseudo-terminal.
 *
 * @task T14102
 */

import { closeSync, openSync, readSync, writeSync } from 'node:fs';

/**
 * Ask on the controlling terminal and read one line.
 *
 * @param prompt - Text written to the terminal before reading.
 * @returns The trimmed line, or null when there is no controlling terminal.
 *
 * @example
 * ```ts
 * const typed = readTtyConfirmation('Type v2026.10.28 to tag abc123: ');
 * ```
 *
 * @task T14102
 */
export function readTtyConfirmation(prompt: string): string | null {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return null;
  }
  try {
    writeSync(fd, prompt);
    const byte = Buffer.alloc(1);
    let line = '';
    while (line.length < 200 && readSync(fd, byte, 0, 1, null) === 1) {
      const ch = byte.toString('utf-8');
      if (ch === '\n') break;
      line += ch;
    }
    return line.trim();
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
