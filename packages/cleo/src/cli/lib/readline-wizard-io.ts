/**
 * Readline-backed {@link WizardIO} implementation for `cleo setup` (T9421).
 *
 * Wraps `node:readline/promises` so the core setup wizard engine
 * ({@link WizardRunner} from `@cleocode/core/setup`) can prompt the
 * operator over a TTY without the engine itself importing `node:readline`.
 *
 * Lives in `packages/cleo/src/cli/lib/` (not under `commands/`) so the
 * command-manifest generator — which scans top-level `commands/*.ts` for
 * `defineCommand` blocks — never tries to register this as a command.
 *
 * @task T9421
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 */

import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import type { WizardIO } from '@cleocode/core/setup';

/**
 * `WizardIO` backed by `node:readline/promises` and the parent process's
 * `stdin`/`stdout`.
 *
 * The instance owns a single long-lived `readline.Interface` so that
 * sequential prompts do not race for control of the TTY. {@link close}
 * MUST be called when the wizard finishes so the process can exit cleanly.
 *
 * `info` writes to stdout (the human channel), `warn` and `error` write
 * to stderr so JSON consumers reading stdout never see informational
 * chatter mixed into their structured envelope.
 *
 * @task T9421
 */
export class ReadlineWizardIO implements WizardIO {
  private readonly rl: readline.Interface;

  /**
   * Construct a readline interface bound to the supplied streams.
   *
   * The defaults (`process.stdin` / `process.stdout`) are correct for
   * production use; tests inject in-memory streams.
   *
   * @param inStream - Input stream; defaults to `process.stdin`.
   * @param outStream - Output stream; defaults to `process.stdout`.
   */
  constructor(inStream: NodeJS.ReadableStream = input, outStream: NodeJS.WritableStream = output) {
    this.rl = readline.createInterface({ input: inStream, output: outStream });
  }

  /**
   * Release the underlying readline interface.
   *
   * Safe to call multiple times — `readline.Interface.close()` is
   * idempotent.
   */
  close(): void {
    this.rl.close();
  }

  async prompt(question: string): Promise<string> {
    const answer = await this.rl.question(`${question} `);
    return answer.trim();
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const hint = defaultValue === undefined ? '[y/n]' : defaultValue ? '[Y/n]' : '[y/N]';
    const raw = (await this.rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (raw === '') {
      if (defaultValue === undefined) {
        // No default provided and operator hit enter — re-prompt once.
        return this.confirm(question, defaultValue);
      }
      return defaultValue;
    }
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    // Unrecognised answer — re-prompt.
    return this.confirm(question, defaultValue);
  }

  async select<T extends string>(question: string, options: readonly T[]): Promise<T> {
    if (options.length === 0) {
      throw new Error(`ReadlineWizardIO.select: option list is empty for '${question}'`);
    }
    // Print the menu once, then loop until a valid choice arrives. The loop
    // is bounded by a hard retry cap so a stuck pipe / EOF cannot spin
    // indefinitely — and by EOF from readline (which surfaces as a
    // rejected promise) in the interactive case.
    process.stdout.write(`${question}\n`);
    options.forEach((opt, idx) => {
      process.stdout.write(`  ${idx + 1}) ${opt}\n`);
    });
    const MAX_RETRIES = 10;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const raw = (await this.rl.question(`Choose [1-${options.length}]: `)).trim();
      // Allow both numeric index and verbatim option name.
      if (/^\d+$/.test(raw)) {
        const idx = Number.parseInt(raw, 10) - 1;
        if (idx >= 0 && idx < options.length) return options[idx] as T;
      }
      if (options.includes(raw as T)) return raw as T;
      process.stdout.write(`Invalid choice '${raw}'. Try again.\n`);
    }
    throw new Error(
      `ReadlineWizardIO.select: gave up after ${MAX_RETRIES} invalid responses for '${question}'`,
    );
  }

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}
