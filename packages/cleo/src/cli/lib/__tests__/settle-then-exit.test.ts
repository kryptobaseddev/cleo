/**
 * The CLI's error exit settles best-effort writes first (T13164).
 *
 * @task T13164
 */

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
});
