/**
 * BRAIN single-writer thread script.
 *
 * Runs inside a `worker_threads.Worker`. Owns the only `getBrainDb` write
 * handle in the process. Receives `WriterRequestEnvelope` messages, dispatches
 * via `handleWriteOp`, and posts `WriterResponseEnvelope` back to the main
 * thread. **All hot-path brain.db writes go through here.**
 *
 * See `brain-writer-thread.ts` for the public API and architecture overview.
 *
 * @task T10351
 * @epic T10286
 * @saga T10281
 */

import { parentPort } from 'node:worker_threads';
import { handleWriteOp } from './brain-writer-handlers.js';
import type { WriterRequestEnvelope, WriterResponseEnvelope } from './brain-writer-thread.js';

if (!parentPort) {
  throw new Error('brain-writer-worker.ts must be run as a worker thread');
}

const port = parentPort;

/**
 * Process one request envelope and emit a corresponding response.
 * Errors are converted to `ok:false` responses (never re-thrown), so the
 * worker stays alive even when individual ops fail.
 */
async function processEnvelope(envelope: WriterRequestEnvelope): Promise<void> {
  try {
    const result = await handleWriteOp(envelope.op);
    const response: WriterResponseEnvelope = {
      seq: envelope.seq,
      ok: true,
      result,
    };
    port.postMessage(response);
  } catch (err) {
    const response: WriterResponseEnvelope = {
      seq: envelope.seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  }
}

// ---------------------------------------------------------------------------
// Single-consumer queue — guarantee in-order processing of one op at a time.
// Multiple postMessage() arrivals are queued internally by node:worker_threads;
// we additionally serialize the *handling* so the DB writes never interleave.
// ---------------------------------------------------------------------------

let processingChain: Promise<unknown> = Promise.resolve();

port.on('message', (envelope: WriterRequestEnvelope) => {
  // Chain each new request to the tail of the current processing chain so
  // ops execute strictly sequentially.
  processingChain = processingChain.then(() => processEnvelope(envelope)).catch(() => undefined); // chain marker is failure-tolerant
});
