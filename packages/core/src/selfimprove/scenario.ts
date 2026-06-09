/**
 * Self-improvement scenario + golden fixture loading and validation (T11889-B).
 *
 * A *scenario* is a deterministic, ordered sequence of READ-ONLY dispatch ops
 * (the GRADE-playbook shape — see `docs/specs/GRADE-SCENARIO-PLAYBOOK.md`) paired
 * with a *golden* envelope set: the known-good, already-normalized response for
 * each op. The self-improvement loop replays the ops (see {@link "./replay.js"})
 * and diffs the captured envelopes against the golden (see
 * {@link "./envelope-diff.js"}); any deviation is a regression.
 *
 * This module is PURE — no DB, no native handle, no `cleo` mutation. Scenario and
 * golden fixtures are stored under
 * `packages/core/src/selfimprove/scenarios/<name>/{scenario,golden}.json` and loaded
 * by {@link loadScenario}, which Zod-validates both files before returning.
 *
 * Import-time side-effect-free: the logger is resolved lazily on first use.
 *
 * @module @cleocode/core/selfimprove/scenario
 * @epic T11889
 * @task T11912
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Gateway } from '@cleocode/contracts';
import type { Logger } from 'pino';
import { z } from 'zod';

/**
 * The set of dispatch gateways a scenario op may target.
 *
 * Mirrors the contracts {@link Gateway} union (`'query' | 'mutate'`). Declared as
 * a tuple constant so the Zod enum and the static type stay in lockstep with
 * `@cleocode/contracts`.
 */
const SCENARIO_GATEWAYS = ['query', 'mutate'] as const satisfies readonly Gateway[];

/**
 * Lazily-resolved module logger.
 *
 * Resolved on first use rather than at import time so that importing this module
 * never triggers logger initialization (a side effect). The cached instance is
 * reused across calls.
 */
let cachedLogger: Logger | undefined;

/**
 * Resolve the module logger, initializing it lazily on first call.
 *
 * @returns The `selfimprove-scenario` subsystem logger.
 */
async function getModuleLogger(): Promise<Logger> {
  if (cachedLogger === undefined) {
    const { getLogger } = await import('../logger.js');
    cachedLogger = getLogger('selfimprove-scenario');
  }
  return cachedLogger;
}

/**
 * Zod schema for a single scenario op.
 *
 * An op is a dispatch coordinate: the CQRS `gateway`, the REGISTERED handler
 * `domain` key (e.g. `'tasks'`, plural — NOT the singular CLI noun), the
 * `operation` name, and optional `params`. The skeleton's canned scenario is
 * `query`-only, so replaying it performs zero mutations.
 */
export const ScenarioOpSchema = z
  .object({
    /** CQRS gateway the op targets (`'query'` for read-only replay). */
    gateway: z.enum(SCENARIO_GATEWAYS),
    /** Registered domain handler key (plural, e.g. `'tasks'`). */
    domain: z.string().min(1),
    /** Operation name within the domain (e.g. `'find'`, `'show'`). */
    operation: z.string().min(1),
    /** Optional operation parameters. */
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** A single ordered, replayable scenario op. */
export type ScenarioOp = z.infer<typeof ScenarioOpSchema>;

/**
 * Zod schema for a scenario file (`scenario.json`).
 *
 * A scenario is a named, described, ordered op sequence. `ops` must be non-empty
 * so a scenario always replays at least one op.
 */
export const ScenarioSchema = z
  .object({
    /** Scenario name — MUST match the containing directory name. */
    name: z.string().min(1),
    /** Human-readable description of what the scenario exercises. */
    description: z.string().min(1),
    /** Ordered ops replayed left-to-right. */
    ops: z.array(ScenarioOpSchema).min(1),
  })
  .strict();

/** A validated scenario: a named, ordered, read-only op sequence. */
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * Zod schema for one entry in a golden file.
 *
 * A golden entry is the already-normalized expected envelope for the op at the
 * same index in the scenario's `ops`. Stored as a structural shape (volatile
 * `meta` fields already stripped); validated loosely here because the structural
 * comparison happens in {@link "./envelope-diff.js"}, not at load time.
 */
export const GoldenEntrySchema = z
  .object({
    /** Expected `success` discriminant of the normalized envelope. */
    success: z.boolean(),
    /** Expected normalized envelope data payload (volatile `meta` already stripped). */
    data: z.unknown().optional(),
    /** Expected normalized error payload, when the golden op is an error. */
    error: z.unknown().optional(),
    /**
     * Expected stable `meta` remnant after volatile-field stripping
     * (e.g. `gateway`, `domain`, `operation`, `source`). Optional because a
     * golden may assert only the body.
     */
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** A validated golden entry — the expected normalized envelope for one op. */
export type GoldenEntry = z.infer<typeof GoldenEntrySchema>;

/**
 * Zod schema for a golden file (`golden.json`).
 *
 * The golden is the ordered set of expected normalized envelopes, ONE per
 * scenario op. {@link loadScenario} enforces that `golden.length === scenario.ops.length`.
 */
export const GoldenSchema = z
  .object({
    /** Scenario name the golden belongs to — MUST match `scenario.name`. */
    name: z.string().min(1),
    /** Expected normalized envelopes, positionally aligned with `scenario.ops`. */
    envelopes: z.array(GoldenEntrySchema),
  })
  .strict();

/** A validated golden envelope set. */
export type Golden = z.infer<typeof GoldenSchema>;

/**
 * A loaded scenario together with its golden envelope set.
 *
 * Returned by {@link loadScenario}. Guarantees: both files Zod-valid, the golden
 * name matches the scenario name, and the golden envelope count equals the
 * scenario op count.
 */
export interface LoadedScenario {
  /** The validated scenario (ordered ops). */
  scenario: Scenario;
  /** The validated golden envelope set (positionally aligned with `scenario.ops`). */
  golden: Golden;
}

/** Thrown when a scenario name is malformed or a fixture is missing / invalid. */
export class ScenarioLoadError extends Error {
  /** Stable machine-readable error code. */
  public readonly code = 'E_SELFIMPROVE_SCENARIO_INVALID' as const;

  /**
   * @param message - Human-readable failure description.
   * @param options - Optional `cause` for error chaining.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScenarioLoadError';
  }
}

/**
 * Pattern a scenario name must match: kebab/alphanumeric, no path separators.
 *
 * Defends `loadScenario` against path traversal: a name like `../../etc` is
 * rejected before it is ever joined to the scenarios directory.
 */
const SCENARIO_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve the candidate scenario directories for a given name.
 *
 * Mirrors the established core asset-resolution convention (see
 * `agent-resolver.ts`): walk up from `import.meta.url` and cover both the
 * workspace `src/` layout (where vitest runs) and the compiled `dist/` layout.
 *
 * @param name - Validated scenario name.
 * @returns Ordered candidate absolute directory paths.
 */
function scenarioDirCandidates(name: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // `here` is `.../selfimprove` (src/selfimprove or dist/selfimprove); the
  // scenarios live directly beneath it.
  return [resolve(here, 'scenarios', name)];
}

/**
 * Read and parse a JSON fixture file, surfacing a typed error on any failure.
 *
 * @param filePath - Absolute path to the JSON file.
 * @param label - Human label for error messages (e.g. `'scenario'`).
 * @returns The parsed JSON value.
 * @throws {@link ScenarioLoadError} When the file is missing or not valid JSON.
 */
async function readJsonFixture(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (cause) {
    throw new ScenarioLoadError(`Cannot read ${label} fixture at ${filePath}`, { cause });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ScenarioLoadError(`${label} fixture at ${filePath} is not valid JSON`, { cause });
  }
}

/**
 * Load and validate a scenario and its golden fixture by name.
 *
 * Reads `scenarios/<name>/scenario.json` and `scenarios/<name>/golden.json`,
 * Zod-validates both, and cross-checks the invariants:
 *   - the scenario name matches the requested `name`;
 *   - the golden name matches the scenario name;
 *   - the golden envelope count equals the scenario op count.
 *
 * PURE — no DB, no mutation. Read-only filesystem access to the bundled fixtures.
 *
 * @param name - Scenario name (also the fixture directory name). Must match
 *   {@link SCENARIO_NAME_PATTERN}.
 * @returns The validated {@link LoadedScenario}.
 * @throws {@link ScenarioLoadError} When the name is malformed, a fixture is
 *   missing/invalid, or an invariant is violated.
 *
 * @example
 * ```ts
 * const { scenario, golden } = await loadScenario('dhq-replay-find');
 * // scenario.ops.length === golden.envelopes.length
 * ```
 */
export async function loadScenario(name: string): Promise<LoadedScenario> {
  if (!SCENARIO_NAME_PATTERN.test(name)) {
    throw new ScenarioLoadError(
      `Invalid scenario name '${name}': must match ${SCENARIO_NAME_PATTERN.source}`,
    );
  }

  const dir = scenarioDirCandidates(name)[0];
  if (dir === undefined) {
    throw new ScenarioLoadError(`Cannot resolve scenario directory for '${name}'`);
  }

  const scenarioRaw = await readJsonFixture(resolve(dir, 'scenario.json'), 'scenario');
  const goldenRaw = await readJsonFixture(resolve(dir, 'golden.json'), 'golden');

  const scenarioParsed = ScenarioSchema.safeParse(scenarioRaw);
  if (!scenarioParsed.success) {
    throw new ScenarioLoadError(
      `scenario.json for '${name}' failed validation: ${scenarioParsed.error.message}`,
      { cause: scenarioParsed.error },
    );
  }
  const goldenParsed = GoldenSchema.safeParse(goldenRaw);
  if (!goldenParsed.success) {
    throw new ScenarioLoadError(
      `golden.json for '${name}' failed validation: ${goldenParsed.error.message}`,
      { cause: goldenParsed.error },
    );
  }

  const scenario = scenarioParsed.data;
  const golden = goldenParsed.data;

  if (scenario.name !== name) {
    throw new ScenarioLoadError(
      `scenario.json name '${scenario.name}' does not match directory '${name}'`,
    );
  }
  if (golden.name !== scenario.name) {
    throw new ScenarioLoadError(
      `golden.json name '${golden.name}' does not match scenario name '${scenario.name}'`,
    );
  }
  if (golden.envelopes.length !== scenario.ops.length) {
    throw new ScenarioLoadError(
      `golden envelope count (${golden.envelopes.length}) does not match scenario op count (${scenario.ops.length}) for '${name}'`,
    );
  }

  const logger = await getModuleLogger();
  logger.debug(
    { scenario: name, ops: scenario.ops.length },
    'loaded self-improvement scenario + golden',
  );

  return { scenario, golden };
}
