/**
 * Parse cache — per-file extraction memo that makes incremental indexing exact.
 *
 * Cross-file resolution (imports, barrels, heritage, calls, accesses) needs the
 * COMPLETE extraction of every file, and most of what it consumes — raw call
 * sites, unresolved access sites, re-export records — is never stored in the
 * published graph rows. Reconstructing those facts from `nexus_nodes` /
 * `nexus_relations` would be an approximation, so the extraction itself is
 * persisted instead.
 *
 * Extraction is a pure function of `(path, bytes, extractor build, publication
 * generation)`. An entry is therefore reusable exactly when the file's content
 * hash and the extractor fingerprint both match; the only generation-dependent
 * token (the publication generation embedded in anonymous scope identities and
 * reference evidence) is rewritten on reuse. Everything downstream of
 * extraction — import resolution, barrel maps, heritage, call and access
 * resolution, communities and flows — reruns over the merged extraction, so an
 * incremental run computes the same function as a full rebuild over the same
 * inputs rather than patching a previous answer.
 *
 * @task T12315
 * @module pipeline/parse-cache
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { GraphParseCacheEntry } from '@cleocode/contracts';
import type { CommonExtractionResult } from './parse-loop.js';

/**
 * One file's complete extraction output, keyed by the file it describes.
 *
 * Kept per file (never merged across files) so a file's facts can be replaced
 * without disturbing any other file's.
 */
export interface FileExtraction {
  /** Path relative to the repository root. */
  path: string;
  /** Declarations, imports, heritage, calls, re-exports and accesses of this file. */
  extraction: Required<CommonExtractionResult>;
}

/**
 * Serialization format version. Bump when the payload encoding (not the
 * extractor) changes; extractor changes are caught by the fingerprint.
 */
const PAYLOAD_FORMAT = 'nexus-parse-cache/v2';

/** Grammar packages whose native behaviour determines extraction output. */
const GRAMMAR_PACKAGES = [
  'tree-sitter',
  'tree-sitter-typescript',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
] as const;

let cachedFingerprint: string | null | undefined;

/** Collect every module file under a directory, in a stable order. */
function collectModuleFiles(directory: string, out: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) collectModuleFiles(full, out);
    else if (
      /\.(?:[cm]?js|ts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.[cm]?[jt]s$/.test(entry.name)
    )
      out.push(full);
  }
}

/**
 * Fingerprint the extractor build: every module under the pipeline and code
 * directories plus the installed grammar package versions.
 *
 * Deliberately over-inclusive — ANY change to pipeline code invalidates every
 * cache entry. A missed invalidation would publish an incremental graph that
 * silently differs from a full rebuild, which is worse than re-parsing.
 *
 * @returns A hex fingerprint, or `null` when the build cannot be fingerprinted
 *   (the caller must then refuse to reuse any entry).
 */
export function computeExtractorFingerprint(): string | null {
  if (cachedFingerprint !== undefined) return cachedFingerprint;
  try {
    const hash = createHash('sha256').update(PAYLOAD_FORMAT);
    const pipelineDir = fileURLToPath(new URL('.', import.meta.url));
    const codeDir = fileURLToPath(new URL('../code/', import.meta.url));
    const files: string[] = [];
    collectModuleFiles(pipelineDir, files);
    collectModuleFiles(codeDir, files);
    if (files.length === 0) throw new Error('no extractor modules found');
    const packageSourceRoot = join(pipelineDir, '..');
    for (const file of files) {
      hash.update(relative(packageSourceRoot, file));
      hash.update('\0');
      hash.update(readFileSync(file));
    }
    const requireFromHere = createRequire(import.meta.url);
    for (const pkg of GRAMMAR_PACKAGES) {
      let version = 'absent';
      try {
        const manifest = JSON.parse(
          readFileSync(requireFromHere.resolve(`${pkg}/package.json`), 'utf8'),
        ) as { version?: string };
        version = manifest.version ?? 'unversioned';
      } catch {
        // An uninstalled grammar is part of the build identity too.
      }
      hash.update(`${pkg}@${version}\0`);
    }
    hash.update(`node-abi:${process.versions.modules}`);
    cachedFingerprint = hash.digest('hex');
  } catch {
    cachedFingerprint = null;
  }
  return cachedFingerprint;
}

/**
 * Replace every string reachable from `value` with one canonical instance.
 *
 * A result that crosses a process boundary arrives as JSON, and `JSON.parse`
 * materialises each occurrence of a string separately: the 64-character
 * generation hash, file path, source id and lexical reason repeated on every
 * call and access record. Measured over 5 098 files of a real repository, the
 * received extractions retained 806 MiB against 498 MiB for the same objects
 * built in-process; sharing the strings brought them to 397 MiB (T13325).
 *
 * @param value - Freshly received JSON data, mutated in place.
 * @param pool - Canonical strings for the current parse.
 */
export function internStrings(value: object, pool: Map<string, string>): void {
  const canonical = (text: string): string => {
    const known = pool.get(text);
    if (known !== undefined) return known;
    pool.set(text, text);
    return text;
  };
  const pending: object[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const key of Object.keys(node)) {
      const child: unknown = Reflect.get(node, key);
      if (typeof child === 'string') Reflect.set(node, key, canonical(child));
      else if (typeof child === 'object' && child !== null) pending.push(child);
    }
  }
}

/**
 * Encode a freshly parsed extraction for storage.
 *
 * Must be called before any downstream phase mutates the extracted nodes
 * (community detection writes `communityId` onto them).
 *
 * @param file - The per-file extraction to encode.
 * @param contentHash - SHA-256 of the parsed bytes.
 * @param fingerprint - Extractor fingerprint from {@link computeExtractorFingerprint}.
 * @param generation - Publication generation the extraction was produced under.
 * @returns A cache entry ready for atomic publication.
 */
export function encodeParseCacheEntry(
  file: FileExtraction,
  contentHash: string,
  fingerprint: string,
  generation: string,
): GraphParseCacheEntry {
  return {
    path: file.path,
    contentHash,
    fingerprint,
    generation,
    payload: encodeExtraction(file.extraction),
  };
}

/** Extraction fields a resolution phase reads one file at a time (T13656). */
export type ExtractionSites = 'calls' | 'accesses';

/** Everything but the sites: what the parse-loop merge consumes. */
export type ExtractionHead = Omit<Required<CommonExtractionResult>, ExtractionSites>;

/** Payload sections, in order: head, calls, accesses. */
const SECTION_COUNT = 3;

/**
 * Compress one file's extraction into its parse-cache payload form.
 *
 * The payload frames three gzip sections — head, calls, accesses — behind a
 * table of their byte lengths, so each phase decodes only the section it
 * reads. The parse loop holds every file in this form between parsing and
 * resolution (T13656): compressed bytes outside the V8 heap.
 *
 * @param extraction - The complete per-file extraction.
 * @returns The framed payload.
 */
export function encodeExtraction(extraction: Required<CommonExtractionResult>): Uint8Array {
  const { calls, accesses, ...head } = extraction;
  const sections = [head, calls, accesses].map((section) =>
    gzipSync(JSON.stringify(section), { level: 1 }),
  );
  const table = Buffer.alloc(4 * SECTION_COUNT);
  sections.forEach((section, index) => {
    table.writeUInt32LE(section.length, 4 * index);
  });
  return Buffer.concat([table, ...sections]);
}

/** Inflate one section of a framed payload, rebinding its generation. */
function sectionText(payload: Uint8Array, index: number, from?: string, to?: string): string {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (bytes.length < 4 * SECTION_COUNT) throw new Error('Parse cache payload is truncated');
  let offset = 4 * SECTION_COUNT;
  for (let section = 0; section < index; section++) offset += bytes.readUInt32LE(4 * section);
  const end = offset + bytes.readUInt32LE(4 * index);
  if (end > bytes.length) throw new Error('Parse cache payload is truncated');
  const text = gunzipSync(bytes.subarray(offset, end)).toString('utf8');
  return from && to && from !== to ? text.split(from).join(to) : text;
}

/**
 * Decode the head of a payload written by {@link encodeExtraction}.
 *
 * @param payload - Framed extraction.
 * @param strings - Canonical strings for this decode (see {@link internStrings}).
 * @param from - Generation embedded in the payload, rewritten to `to` when they differ.
 * @param to - Publication generation of the run decoding it.
 * @returns Declarations, imports, heritage, re-exports and parse limitations.
 * @throws When the payload is not a decodable extraction.
 */
export function decodeExtractionHead(
  payload: Uint8Array,
  strings: Map<string, string> = new Map(),
  from?: string,
  to?: string,
): ExtractionHead {
  const parsed = JSON.parse(sectionText(payload, 0, from, to)) as Partial<ExtractionHead>;
  for (const key of ['definitions', 'imports', 'heritage', 'reExports'] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`Parse cache entry lacks ${key}`);
  }
  internStrings(parsed, strings);
  return {
    definitions: parsed.definitions ?? [],
    imports: parsed.imports ?? [],
    heritage: parsed.heritage ?? [],
    reExports: parsed.reExports ?? [],
    parseLimitations: parsed.parseLimitations ?? [],
  };
}

/**
 * Decode one site section of a payload written by {@link encodeExtraction}.
 *
 * Not interned: resolution reads each record once and keeps nothing of it but
 * strings the graph already holds (relation endpoints resolve to node ids).
 *
 * @param payload - Framed extraction.
 * @param sites - Which section to decode.
 * @param from - Generation embedded in the payload, rewritten to `to` when they differ.
 * @param to - Publication generation of the run decoding it.
 * @returns The section's records.
 * @throws When the section is not a decodable record array.
 */
export function decodeExtractionSites<K extends ExtractionSites>(
  payload: Uint8Array,
  sites: K,
  from?: string,
  to?: string,
): Required<CommonExtractionResult>[K] {
  const parsed: unknown = JSON.parse(sectionText(payload, sites === 'calls' ? 1 : 2, from, to));
  if (!Array.isArray(parsed)) throw new Error(`Parse cache entry lacks ${sites}`);
  return parsed as Required<CommonExtractionResult>[K];
}

/**
 * Decode a whole payload written by {@link encodeExtraction}.
 *
 * @param payload - Framed extraction.
 * @param strings - Canonical strings for the head (see {@link internStrings}).
 * @param from - Generation embedded in the payload, rewritten to `to` when they differ.
 * @param to - Publication generation of the run decoding it.
 * @returns The extraction with every per-file array present.
 * @throws When the payload is not a decodable extraction.
 */
export function decodeExtraction(
  payload: Uint8Array,
  strings: Map<string, string> = new Map(),
  from?: string,
  to?: string,
): Required<CommonExtractionResult> {
  return {
    ...decodeExtractionHead(payload, strings, from, to),
    calls: decodeExtractionSites(payload, 'calls', from, to),
    accesses: decodeExtractionSites(payload, 'accesses', from, to),
  };
}

/**
 * Decode a stored extraction and rebind it to the current publication generation.
 *
 * Strings are interned into `strings`: a bare `JSON.parse` materialises each
 * repeated path, scope id and generation separately, twice the heap of the
 * same objects built in-process (T13325).
 *
 * @param entry - Stored cache entry.
 * @param generation - The publication generation of the run reusing it.
 * @param strings - Canonical strings for this decode.
 * @returns The extraction exactly as re-parsing the same bytes under `generation` would produce.
 * @throws When the payload is not a decodable extraction; callers treat that file as changed.
 */
export function decodeParseCacheEntry(
  entry: GraphParseCacheEntry,
  generation: string,
  strings: Map<string, string> = new Map(),
): FileExtraction {
  if (!entry.generation) throw new Error('Parse cache entry lacks its generation');
  return {
    path: entry.path,
    extraction: decodeExtraction(entry.payload, strings, entry.generation, generation),
  };
}
