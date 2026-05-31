/**
 * `@cleocode/utils` — shared, pure, zero-dependency utility leaf.
 *
 * Home for small stateless helpers that were previously copy-pasted inline
 * across packages. Everything here MUST be: pure (no I/O, no global state),
 * dependency-free (no other `@cleocode/*` imports — this is a graph leaf), and
 * individually unit-tested. Consumers import the named helper; the package is
 * bundled into `@cleocode/cleo` at build time and is never published on its own
 * (owner decision: a single published `@cleocode/cleo` artifact).
 *
 * @module @cleocode/utils
 */

export { formatBytes } from './format-bytes.js';
