/**
 * Tests for the `cleo <op> --describe` CLI wiring (T11692 / DHQ-057).
 *
 * The `--describe` short-circuit has two halves:
 *   1. The describe-context singleton (set by the global flag parser in
 *      cli/index.ts, read by dispatchFromCli / add-batch). Covered here.
 *   2. `maybeEmitDescribe`, which composes the descriptor via the SDK
 *      `describeOperation` and emits it through cliOutput. The descriptor
 *      composition + the `/data/task/title` pointer fix are proven directly
 *      against the SDK in
 *      `packages/core/src/dispatch/__tests__/describe-operation.test.ts`.
 *
 * This file intentionally avoids importing the heavy dispatch adapter (which
 * pulls the full @cleocode/runtime gateway chain) and tests the pure CLI
 * singleton in isolation.
 *
 * @task T11692
 * @epic T11679
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isDescribeMode, setDescribeMode } from '../describe-context.js';

afterEach(() => {
  // Reset the singleton so cross-test leakage never produces false positives.
  setDescribeMode(false);
});

describe('describe-context singleton (T11692 · DHQ-057)', () => {
  it('defaults to false (describe mode off)', () => {
    expect(isDescribeMode()).toBe(false);
  });

  it('records when --describe was requested', () => {
    setDescribeMode(true);
    expect(isDescribeMode()).toBe(true);
  });

  it('clears the flag back to false', () => {
    setDescribeMode(true);
    setDescribeMode(false);
    expect(isDescribeMode()).toBe(false);
  });
});
