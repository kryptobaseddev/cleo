/**
 * Parse-cache checkpoints stay off the parse-result path (T14016): a write is
 * one synchronous transaction, so it runs on a timer, never inside the
 * callback that receives a parsed file.
 *
 * @task T14016
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphParseCacheEntry, GraphPublicationRows } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPipeline } from '../pipeline/index.js';

let repo = '';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'nexus-checkpoint-'));
  mkdirSync(join(repo, 'src'));
  // A large fixture: far more files than the old 64-entry inline batch.
  for (let i = 0; i < 400; i++)
    writeFileSync(
      join(repo, 'src', `m${i}.ts`),
      `export function f${i}(): number { return ${i}; }\n` +
        (i > 0
          ? `import { f${i - 1} } from './m${i - 1}';\nexport const g${i} = () => f${i - 1}();\n`
          : ''),
    );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const noWrites = {
  insert(): never {
    throw new Error('unexpected live store mutation');
  },
};
const tables = { nexusNodes: {}, nexusRelations: {} };

/** Run the pipeline, recording each checkpoint write and how many files were parsed by then. */
async function run(checkpointIntervalMs: number) {
  const writes: Array<{ size: number; parsedBefore: number }> = [];
  let parsed = 0;
  const publications: GraphPublicationRows[] = [];
  await runPipeline(
    repo,
    'checkpoint-fixture',
    noWrites as never,
    tables as never,
    (current) => {
      parsed = current;
    },
    {
      checkpointIntervalMs,
      checkpointParseCache: (entries: readonly GraphParseCacheEntry[]) => {
        writes.push({ size: entries.length, parsedBefore: parsed });
      },
      publishGraph: (rows: GraphPublicationRows) => {
        publications.push(rows);
      },
    },
  );
  return { writes, publications };
}

describe('parse checkpoints off the hot path (T14016)', () => {
  it('a fast parse writes its 400 extractions once, after the parse, not per batch inline', async () => {
    const { writes, publications } = await run(60_000);
    expect(publications).toHaveLength(1);
    expect(writes.reduce((sum, write) => sum + write.size, 0)).toBe(400);
    // The old inline batching wrote ceil(400 / 64) = 7 transactions during the parse.
    expect(writes).toHaveLength(1);
  });

  it('a slow parse is checkpointed by the timer, so a kill keeps earlier work', async () => {
    const { writes } = await run(1);
    expect(writes.reduce((sum, write) => sum + write.size, 0)).toBe(400);
    expect(writes.some((write) => write.parsedBefore < 400)).toBe(true);
  });
});
