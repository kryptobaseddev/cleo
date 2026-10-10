/**
 * Owned parser executable for worker-thread and process IPC transports.
 * Calls the per-file extractor directly; never re-enters the pipeline or pool.
 * @task T12262
 */
import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import type { GraphIndexFileReport, ParserExecutionLimits } from '@cleocode/contracts';
import type { FileExtraction } from '../parse-cache.js';
import { extractOriginalSource } from '../parse-loop.js';

/** Original file input; cancellation stays with the owning execution transport. */
export interface ParseWorkerInput {
  /** Repository-relative identity. */
  path: string;
  /** Original Unicode source. */
  content: string;
  /** Serializable native parser bounds. */
  limits?: Omit<ParserExecutionLimits, 'signal'>;
  /** Immutable graph publication identity, allocated by the owning pipeline. */
  publicationGeneration?: string;
}

/**
 * One sub-batch's results, using exactly the same extractor capabilities as
 * sequential parsing.
 *
 * Extractions stay grouped per file (T12315) so the pipeline can merge fresh and
 * cached files in one deterministic order and capture a cache entry per file.
 *
 * Sent once per sub-batch, never accumulated (T13325). An accumulated result
 * per worker made the parent `JSON.parse` one message holding a whole chunk —
 * 68-119 MB of JSON per worker, 765 MB in all, on a 5 357-file repository —
 * and the 1 536 MB CLI process died inside that parse.
 */
export interface ParseWorkerResult {
  /** Per-file success and failure evidence. */
  reports: GraphIndexFileReport[];
  /** One complete extraction per successfully parsed file, in dispatch order. */
  files: FileExtraction[];
  /** Successfully extracted files. */
  fileCount: number;
  /** Failed files; never included in the success count. */
  skippedCount: number;
}

type IncomingMessage = { type: 'sub-batch'; files: ParseWorkerInput[] };

if (!parentPort && !process.send) throw new Error('Parser requires owned IPC transport');

function send(message: object): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function emptyResult(): ParseWorkerResult {
  return {
    reports: [],
    files: [],
    fileCount: 0,
    skippedCount: 0,
  };
}

/** Files this worker has finished, for progress only; results are not retained. */
let processed = 0;
function receive(message: IncomingMessage): void {
  const result = emptyResult();
  for (const file of message.files) {
    try {
      const extracted = extractOriginalSource(
        file.content,
        file.path,
        file.limits,
        file.publicationGeneration,
      );
      result.files.push({
        path: file.path,
        extraction: {
          definitions: extracted.definitions,
          imports: extracted.imports,
          heritage: extracted.heritage,
          calls: extracted.calls,
          reExports: extracted.reExports ?? [],
          accesses: extracted.accesses ?? [],
        },
      });
      result.reports.push({ path: file.path, status: 'analyzed' });
      result.fileCount++;
    } catch (error) {
      result.reports.push({
        path: file.path,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      result.skippedCount++;
    }
  }
  processed += message.files.length;
  send({ type: 'progress', filesProcessed: processed });
  send({ type: 'sub-batch-done', data: result });
}

if (parentPort) parentPort.on('message', receive);
else process.on('message', receive);
send({ type: 'ready', heapBytes: getHeapStatistics().heap_size_limit });
