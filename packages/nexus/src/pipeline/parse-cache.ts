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
const PAYLOAD_FORMAT = 'nexus-parse-cache/v1';

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
    payload: gzipSync(JSON.stringify(file.extraction), { level: 1 }),
  };
}

/**
 * Decode a stored extraction and rebind it to the current publication generation.
 *
 * @param entry - Stored cache entry.
 * @param generation - The publication generation of the run reusing it.
 * @returns The extraction exactly as re-parsing the same bytes under `generation` would produce.
 * @throws When the payload is not a decodable extraction; callers treat that file as changed.
 */
export function decodeParseCacheEntry(
  entry: GraphParseCacheEntry,
  generation: string,
): FileExtraction {
  if (!entry.generation) throw new Error('Parse cache entry lacks its generation');
  let text = gunzipSync(entry.payload).toString('utf8');
  if (entry.generation !== generation) text = text.split(entry.generation).join(generation);
  const parsed = JSON.parse(text) as Required<CommonExtractionResult>;
  for (const key of [
    'definitions',
    'imports',
    'heritage',
    'calls',
    'reExports',
    'accesses',
  ] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`Parse cache entry lacks ${key}`);
  }
  return { path: entry.path, extraction: parsed };
}
