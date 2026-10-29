/**
 * A command gate's `cmd` is one executable; its arguments go in `args`
 * (T14155).
 *
 * The runner spawns `cmd` with `args` and no shell, so `cmd: "node -e 0"`
 * starts a program literally named `node -e 0` and fails with a bare ENOENT
 * on every platform. Writes (`cleo req add`, `cleo req replace`) refuse such a
 * gate; reading or parsing a stored one never does, so tasks that already hold
 * one keep working; running one reports this message instead of ENOENT.
 *
 * @module tasks/command-gate-cmd
 * @task T14155
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AcceptanceGate } from '@cleocode/contracts';

/** The one sentence every refusal and run-time error carries. */
export const COMMAND_GATE_CMD_MESSAGE = 'cmd is one executable; put its arguments in args';

/**
 * Why a command gate's `cmd` carries its arguments, or null when it does not:
 * `cmd` contains whitespace and names no existing file (an executable whose
 * path has a space in it is fine).
 *
 * @param gate - Any acceptance gate; only `command` gates are judged.
 * @param root - The tree the gate runs in (its `cwd` is resolved against it).
 * @returns The problem, with the split it should have been, or null.
 * @example
 * ```ts
 * commandGateCmdProblem({ kind: 'command', cmd: 'node -e 0', description: 'd' }, root);
 * // 'command gate cmd "node -e 0": cmd is one executable; put its arguments in args (…)'
 * ```
 * @task T14155
 */
export function commandGateCmdProblem(gate: AcceptanceGate, root: string): string | null {
  if (gate.kind !== 'command' || !/\s/.test(gate.cmd)) return null;
  const candidates = isAbsolute(gate.cmd)
    ? [gate.cmd]
    : [resolve(root, gate.cwd ?? '.', gate.cmd), resolve(root, gate.cmd)];
  if (candidates.some((path) => existsSync(path))) return null;
  const [first = gate.cmd, ...rest] = gate.cmd.trim().split(/\s+/);
  return (
    `command gate cmd "${gate.cmd}": ${COMMAND_GATE_CMD_MESSAGE} ` +
    `(e.g. "cmd":${JSON.stringify(first)},"args":${JSON.stringify([...rest, ...(gate.args ?? [])])})`
  );
}
