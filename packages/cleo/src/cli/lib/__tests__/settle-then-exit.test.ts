/**
 * The CLI's error exit settles best-effort writes first (T13164).
 *
 * @task T13164
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { settleThenExit } from '../settle-then-exit.js';

describe('settleThenExit (T13164)', () => {
  it('exits with the code only after the settle resolves', async () => {
    const order: string[] = [];
    const exit = (code: number): never => {
      order.push(`exit:${code}`);
      return undefined as never;
    };
    await settleThenExit(
      4,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('settled');
      },
      exit,
    );
    expect(order).toEqual(['settled', 'exit:4']);
  });

  it('still exits with the code when the settle fails', async () => {
    const codes: number[] = [];
    await settleThenExit(
      6,
      async () => {
        throw new Error('core failed to load');
      },
      (code) => {
        codes.push(code);
        return undefined as never;
      },
    );
    expect(codes).toEqual([6]);
  });

  it('a settle that never resolves still ends the process with the code, not 0', () => {
    // review-p0 on #1846: with only an unref'd timer pending, the loop drains
    // during the await and Node exits with process.exitCode, which was unset.
    const module = pathToFileURL(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'settle-then-exit.ts'),
    ).href;
    const script = [
      `const { settleThenExit } = await import(${JSON.stringify(module)});`,
      'setTimeout(() => {}, 60_000).unref();',
      'void settleThenExit(4, () => new Promise(() => {}), (c) => process.exit(c));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(4);
  });
});
