/**
 * Contract-backed canonical filesystem imports for the clean CAAMP build.
 *
 * CAAMP cannot reference the full CORE project before its own build because CORE
 * consumes CAAMP. These declarations use shared callable ports from contracts,
 * without copying primitive signatures or producing CORE's output as an input.
 * Both package spellings resolve to the same canonical runtime module; CORE's
 * exact ./tools/fs.js export preserves existing extension-bearing consumers.
 *
 * @task T13344
 */
declare module '@cleocode/core/tools/fs' {
  /** The canonical atomic writer; no CAAMP implementation is declared. */
  export const writeFileAtomic: import('@cleocode/contracts/tools/atomic').WriteFileAtomic;
  /** The canonical bounded text reader; no CAAMP implementation is declared. */
  export const readFileText: import('@cleocode/contracts/tools/atomic').ReadFileText;
}

declare module '@cleocode/core/tools/fs.js' {
  export { readFileText, writeFileAtomic } from '@cleocode/core/tools/fs';
}
