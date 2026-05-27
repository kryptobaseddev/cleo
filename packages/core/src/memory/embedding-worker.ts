/**
 * Embedding Worker Thread Script
 *
 * Runs inside a `worker_threads.Worker` to perform embedding generation
 * off the main thread. Receives messages with text to embed, calls
 * LocalEmbeddingProvider, and sends results back via parentPort.
 *
 * Message protocol:
 *   Inbound:  { id: string; text: string }
 *   Outbound: { id: string; embedding: number[] } on success
 *             { id: string; error: string }       on failure
 *
 * @epic T134
 * @task T137
 * @why Prevent @huggingface/transformers model inference from blocking the main thread
 * @what Worker thread script for async embedding generation
 */

import { parentPort } from 'node:worker_threads';

/** Inbound message from the queue manager. */
interface WorkerRequest {
  id: string;
  text: string;
}

/** Successful embedding result sent to the queue manager. */
interface WorkerSuccess {
  id: string;
  embedding: number[];
}

/** Error result sent to the queue manager. */
interface WorkerError {
  id: string;
  error: string;
}

if (!parentPort) {
  throw new Error('embedding-worker.ts must be run as a worker thread');
}

const port = parentPort;

/**
 * Handle a single embedding request from the queue manager.
 * Imports LocalEmbeddingProvider lazily so the model loads once
 * per worker lifetime.
 */
async function handleRequest(req: WorkerRequest): Promise<void> {
  try {
    const { getLocalEmbeddingProvider } = await import('./embedding-local.js');
    const provider = getLocalEmbeddingProvider();
    const vector = await provider.embed(req.text);
    // Transfer as plain number[] — structured clone handles Float32Array
    const response: WorkerSuccess = {
      id: req.id,
      embedding: Array.from(vector),
    };
    port.postMessage(response);
  } catch (err) {
    const response: WorkerError = {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  }
}

port.on('message', (req: WorkerRequest) => {
  handleRequest(req).catch((err) => {
    // Catch any unhandled rejection in handleRequest itself
    const response: WorkerError = {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
  });
});
