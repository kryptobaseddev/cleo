/**
 * Reference spool — encodes retained references into their stored form as
 * resolution produces them (T13656).
 *
 * A generation retains one reference per unresolved or unmodeled static site:
 * 951 146 of them on a 7 000-file repository, ~270 MiB of heap as objects.
 * Holding them until publication made peak heap grow with the repository, so
 * each reference is serialized the moment it is reported and only its
 * compressed bytes (outside the V8 heap) and a count are kept.
 *
 * The bytes are exactly the `graph_assessment_references` value: the JSON
 * array `[\n<ref>,\n<ref>\n]`, one reference per line, written as concatenated
 * gzip members so no string longer than one member's text is ever built
 * (T13326). The publisher stores them verbatim.
 *
 * @task T13656
 * @module pipeline/reference-spool
 */

import { gzipSync } from 'node:zlib';
import type { GraphIndexReferenceReport, GraphStoredReferences } from '@cleocode/contracts';

/** gzip level of the stored reference list: level 1 is ~16x smaller at ~1 s per 450 MB. */
const REFERENCES_GZIP_LEVEL = 1;

/**
 * References compressed per gzip member of the stored list.
 *
 * Bounds the largest string the encoder builds to one member's worth (a few
 * MB) whatever the repository size, while keeping members large enough that
 * per-member gzip framing does not cost compression.
 */
const REFERENCES_PER_MEMBER = 4096;

/** Incremental encoder of a generation's retained references. */
export interface ReferenceSpool {
  /** Number of references appended so far. */
  readonly count: number;
  /** Serialize one reference; the object is not retained. */
  append(reference: GraphIndexReferenceReport): void;
  /** Close the list and return its stored form; the spool must not be appended to afterwards. */
  finish(): GraphStoredReferences;
}

/**
 * Create a reference spool.
 *
 * @param publicationGeneration - When given, a reference carrying a different
 *   publication generation is refused, as the publisher refuses mixed generations.
 * @returns An empty spool.
 * @example
 * ```ts
 * const spool = createReferenceSpool(generation);
 * spool.append(report);
 * const stored = spool.finish(); // { count: 1, payload }
 * ```
 */
export function createReferenceSpool(publicationGeneration?: string): ReferenceSpool {
  const members: Buffer[] = [];
  let text = '[';
  let count = 0;
  return {
    get count() {
      return count;
    },
    append(reference) {
      if (
        publicationGeneration !== undefined &&
        reference.publicationGeneration !== undefined &&
        reference.publicationGeneration !== publicationGeneration
      )
        throw new Error('Staged reference publication generation does not match rows');
      text += `${count === 0 ? '\n' : ',\n'}${JSON.stringify(reference)}`;
      if (++count % REFERENCES_PER_MEMBER === 0) {
        members.push(gzipSync(text, { level: REFERENCES_GZIP_LEVEL }));
        text = '';
      }
    },
    finish() {
      members.push(gzipSync(`${text}\n]`, { level: REFERENCES_GZIP_LEVEL }));
      text = '';
      return { count, payload: Buffer.concat(members) };
    },
  };
}
