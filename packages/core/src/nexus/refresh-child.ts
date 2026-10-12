/**
 * Child-process entry for a query's inline index refresh (T13537 · T13548).
 *
 * {@link runRefreshInChild} starts this module as an owned process with its
 * own V8 heap limit and sends it one {@link NexusRefreshInput}. A refresh that
 * outgrows the limit, or overruns its budget, ends this process and every
 * SQLite handle and lock with it; publication is atomic, so the previous graph
 * stays intact.
 *
 * @module
 * @task T13548
 */

import {
  type NexusRefreshInput,
  type NexusRefreshReply,
  runRefreshInProcess,
} from './freshness.js';

process.once('message', async (input: NexusRefreshInput) => {
  let reply: NexusRefreshReply;
  try {
    reply = { ok: true, summary: await runRefreshInProcess(input) };
  } catch (error) {
    reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.send?.(reply);
});
