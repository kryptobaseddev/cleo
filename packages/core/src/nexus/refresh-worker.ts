/**
 * Worker entry for a query's inline index refresh (T13537).
 *
 * {@link runRefreshInWorker} starts this module in a worker thread with its
 * own V8 heap limit, so a refresh that outgrows it ends the worker
 * (`ERR_WORKER_OUT_OF_MEMORY`) instead of aborting the CLI. Publication is
 * atomic, so a worker that dies mid-run leaves the previous graph intact.
 *
 * @module
 * @task T13537
 */

import { parentPort, workerData } from 'node:worker_threads';
import { type NexusRefreshInput, runRefreshInProcess } from './freshness.js';

parentPort?.postMessage(await runRefreshInProcess(workerData as NexusRefreshInput));
