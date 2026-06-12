/**
 * Static op-coordinate → source-file map for the self-improvement fix-gen stage.
 *
 * Given a regression's `opCoord` (the `domain.operation` string produced by
 * {@link "../selfimprove/envelope-diff.js".DiffEntry.opCoord}, e.g. `tasks.show`),
 * this module resolves the **repo-relative** paths of the CLI handler and the
 * core module(s) most likely to contain the regression. The file list is fed into
 * the fix-gen prompt builder ({@link "./fix-gen-context.js"}) so the LLM receives
 * bounded, targeted code context rather than zero context or an unbounded repo
 * dump.
 *
 * ## Design: static map, not a registry query
 *
 * The ops catalog (the `OPERATIONS` array in `@cleocode/contracts`) encodes
 * `{ gateway, domain, operation }` but does NOT track source-file provenance.
 * Runtime nexus queries (`cleo nexus query`) would work but introduce an
 * in-process dependency on the nexus subsystem (an expensive side-effectful
 * import in the fix-gen hot path). A **static map keyed by `domain.operation`**
 * is the cost-free alternative: it is derived once (by reading the repo's known
 * handler layout), is small enough to inline, and carries zero import-time cost.
 *
 * The map covers the common `tasks` domain operations exercised by the canonical
 * scenarios. The entry for an unregistered `opCoord` returns an empty file list
 * (`{ handlerFiles: [], coreFiles: [] }`) — the fix-gen stage degrades gracefully
 * to "no context" (the model still receives the regression diff and may emit
 * `NO_PATCH`, which is the honest outcome when context is absent).
 *
 * ## File path convention
 *
 * Every path is **repo-relative** (no leading `/`). The file content loader
 * ({@link "./fix-gen-context.js"}) resolves them against `repoContext.projectRoot`
 * before reading.
 *
 * Import-time side-effect-free: no IO, no dynamic imports.
 *
 * @module @cleocode/core/selfimprove/op-source-map
 * @epic T11889
 * @task T11988
 */

/**
 * Resolved source files for one op-coordinate.
 *
 * - `handlerFiles`: the CLI dispatch handler(s) in `packages/cleo/src/dispatch/domains/`
 * - `coreFiles`: the core-logic module(s) in `packages/core/src/` (the file most
 *   likely to contain the regression for this operation)
 *
 * Both lists are repo-relative. Either may be empty when not applicable.
 */
export interface OpSourceEntry {
  /** CLI dispatch handler files (repo-relative). */
  readonly handlerFiles: readonly string[];
  /** Core module files that implement the operation logic (repo-relative). */
  readonly coreFiles: readonly string[];
}

/**
 * The static `opCoord → source files` map.
 *
 * Keys are `domain.operation` strings (lowercase, e.g. `'tasks.show'`). Values
 * are {@link OpSourceEntry} objects with repo-relative paths.
 *
 * Coverage: the `tasks` domain operations exercised by the built-in scenarios
 * (T11988: `seeded-code-regression`) plus the pre-existing `dhq-replay-find`
 * scenario (`tasks.find`, `tasks.show`).
 *
 * @internal
 */
const OP_SOURCE_MAP: Readonly<Record<string, OpSourceEntry>> = {
  'tasks.show': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/show.ts'],
  },
  'tasks.find': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/find.ts'],
  },
  'tasks.list': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/list.ts'],
  },
  'tasks.add': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/add.ts'],
  },
  'tasks.update': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/update.ts'],
  },
  'tasks.complete': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/complete.ts'],
  },
  'tasks.delete': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/delete.ts'],
  },
  'tasks.next': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/next.ts'],
  },
  'tasks.current': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/current.ts'],
  },
  'tasks.tree': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/generic-tree.ts'],
  },
  'tasks.analyze': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts'],
    coreFiles: ['packages/core/src/tasks/analyze.ts'],
  },
  'memory.find': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/memory.ts'],
    coreFiles: [],
  },
  'memory.fetch': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/memory.ts'],
    coreFiles: [],
  },
  'selfimprove.run': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/selfimprove.ts'],
    coreFiles: ['packages/core/src/selfimprove/run-loop.ts'],
  },
  /**
   * `selfimprove.probe` — the seeded-code-regression scenario target (T11988).
   * The probe-helper is intentionally broken (`probeVersion()` returns `2`
   * instead of `1`); the fix is a single-line change in this file.
   */
  'selfimprove.probe': {
    handlerFiles: ['packages/cleo/src/dispatch/domains/selfimprove.ts'],
    coreFiles: ['packages/core/src/selfimprove/probe-helper.ts'],
  },
} as const;

/**
 * An empty source entry returned for unknown or unmapped op-coordinates.
 *
 * The fix-gen stage treats an empty file list as "no context available" and
 * degrades the prompt to the regression-only view. The model may still produce
 * a patch (or `NO_PATCH`) without file context.
 */
const EMPTY_ENTRY: OpSourceEntry = { handlerFiles: [], coreFiles: [] } as const;

/**
 * Resolve the handler + core source files for a given op-coordinate.
 *
 * Returns the {@link OpSourceEntry} from the static map when the `opCoord` is
 * registered, or {@link EMPTY_ENTRY} when it is not. NEVER throws. The returned
 * lists contain repo-relative paths; callers resolve them against the project root
 * before reading.
 *
 * @param opCoord - The op coordinate to resolve (e.g. `'tasks.show'`).
 * @returns The resolved {@link OpSourceEntry} (may be empty for unknown ops).
 *
 * @example
 * ```ts
 * const { handlerFiles, coreFiles } = resolveOpSourceFiles('tasks.show');
 * // handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts']
 * // coreFiles:    ['packages/core/src/tasks/show.ts']
 * ```
 */
export function resolveOpSourceFiles(opCoord: string): OpSourceEntry {
  return OP_SOURCE_MAP[opCoord] ?? EMPTY_ENTRY;
}

/**
 * Collect the unique set of source files for a list of op-coordinates.
 *
 * Deduplicates across entries so a scenario with two ops from the same handler
 * does not include the handler twice. Returns the merged `{ handlerFiles, coreFiles }`
 * with order preserved (first-seen wins for dedup).
 *
 * @param opCoords - The op-coordinate strings to collect files for.
 * @returns The merged, deduplicated {@link OpSourceEntry}.
 *
 * @example
 * ```ts
 * const entry = collectOpSourceFiles(['tasks.find', 'tasks.show']);
 * // entry.handlerFiles: ['packages/cleo/src/dispatch/domains/tasks.ts']
 * // entry.coreFiles:    ['packages/core/src/tasks/find.ts', 'packages/core/src/tasks/show.ts']
 * ```
 */
export function collectOpSourceFiles(opCoords: readonly string[]): OpSourceEntry {
  const seenHandler = new Set<string>();
  const seenCore = new Set<string>();
  const handlerFiles: string[] = [];
  const coreFiles: string[] = [];

  for (const coord of opCoords) {
    const entry = resolveOpSourceFiles(coord);
    for (const f of entry.handlerFiles) {
      if (!seenHandler.has(f)) {
        seenHandler.add(f);
        handlerFiles.push(f);
      }
    }
    for (const f of entry.coreFiles) {
      if (!seenCore.has(f)) {
        seenCore.add(f);
        coreFiles.push(f);
      }
    }
  }

  return { handlerFiles, coreFiles };
}
