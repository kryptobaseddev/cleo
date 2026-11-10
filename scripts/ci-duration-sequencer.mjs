/**
 * vitest sequencer that shards by measured file duration (T14369).
 *
 * With `VITEST_SHARD_TIMINGS` naming a timings file that has data (see
 * `ci-duration-shards.mjs`), `--shard=i/n` takes the i-th of n
 * duration-balanced groups; otherwise it is vitest's own file-count split.
 * Ordering within a shard is vitest's default.
 *
 * @task T14369
 */

import path from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { partitionByDuration, readTimingsFile } from './ci-duration-shards.mjs';

/** `sequence.sequencer` for the root vitest config. */
export class DurationShardSequencer extends BaseSequencer {
  /**
   * @param {import('vitest/node').TestSpecification[]} files
   * @returns {Promise<import('vitest/node').TestSpecification[]>}
   */
  async shard(files) {
    const timings = readTimingsFile(process.env.VITEST_SHARD_TIMINGS);
    const { root, shard } = this.ctx.config;
    if (timings === null || !shard) return super.shard(files);
    const items = files.map((spec) => {
      const file = path.relative(root, spec.moduleId).split(path.sep).join('/');
      return { spec, file, key: `${spec.project.name}:${file}` };
    });
    const groups = partitionByDuration(items, timings, shard.count);
    if (groups === null) return super.shard(files);
    return groups[shard.index - 1].map((i) => i.spec);
  }
}
