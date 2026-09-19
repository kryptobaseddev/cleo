/**
 * Owned parser executable for worker-thread and process IPC transports.
 * Calls the per-file extractor directly; never re-enters the pipeline or pool.
 * @task T12262
 */
import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import type { GraphIndexFileReport, GraphNode, ParserExecutionLimits } from '@cleocode/contracts';
import type { CommonExtractionResult } from '../parse-loop.js';
import { extractOriginalSource } from '../parse-loop.js';

/** Original file input; cancellation stays with the owning execution transport. */
export interface ParseWorkerInput {
  /** Repository-relative identity. */
  path: string;
  /** Original Unicode source. */
  content: string;
  /** Serializable native parser bounds. */
  limits?: Omit<ParserExecutionLimits, 'signal'>;
}

/** Per-worker results use exactly the same extractor capabilities as sequential parsing. */
export interface ParseWorkerResult {
  /** Per-file success and failure evidence. */
  reports: GraphIndexFileReport[];
  /** Declarations retaining the original graph identities. */
  symbols: GraphNode[];
  /** Import bindings. */
  imports: CommonExtractionResult['imports'];
  /** Type inheritance evidence. */
  heritage: CommonExtractionResult['heritage'];
  /** Static call evidence, without claiming complete runtime discovery. */
  calls: CommonExtractionResult['calls'];
  /** Barrel re-export evidence. */
  reExports: NonNullable<CommonExtractionResult['reExports']>;
  /** Property access evidence. */
  accesses: NonNullable<CommonExtractionResult['accesses']>;
  /** Successfully extracted files. */
  fileCount: number;
  /** Failed files; never included in the success count. */
  skippedCount: number;
}

type IncomingMessage = { type: 'sub-batch'; files: ParseWorkerInput[] } | { type: 'flush' };

if (!parentPort && !process.send) throw new Error('Parser requires owned IPC transport');

function send(message: object): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function emptyResult(): ParseWorkerResult {
  return {
    reports: [],
    symbols: [],
    imports: [],
    heritage: [],
    calls: [],
    reExports: [],
    accesses: [],
    fileCount: 0,
    skippedCount: 0,
  };
}

let accumulated = emptyResult();
function receive(message: IncomingMessage): void {
  if (message.type === 'flush') {
    send({ type: 'result', data: accumulated });
    accumulated = emptyResult();
    return;
  }
  for (const file of message.files) {
    try {
      const extracted = extractOriginalSource(file.content, file.path, file.limits);
      accumulated.symbols.push(...extracted.definitions);
      accumulated.imports.push(...extracted.imports);
      accumulated.heritage.push(...extracted.heritage);
      accumulated.calls.push(...extracted.calls);
      accumulated.reExports.push(...(extracted.reExports ?? []));
      accumulated.accesses.push(...(extracted.accesses ?? []));
      accumulated.reports.push({ path: file.path, status: 'analyzed' });
      accumulated.fileCount++;
    } catch (error) {
      accumulated.reports.push({
        path: file.path,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      accumulated.skippedCount++;
    }
  }
  send({ type: 'progress', filesProcessed: accumulated.fileCount + accumulated.skippedCount });
  send({ type: 'sub-batch-done' });
}

if (parentPort) parentPort.on('message', receive);
else process.on('message', receive);
send({ type: 'ready', heapBytes: getHeapStatistics().heap_size_limit });
