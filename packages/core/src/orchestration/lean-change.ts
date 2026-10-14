/**
 * Lean-change rules for spawn prompts and the `cleo lean` verbs (T13422, T13663).
 *
 * The core rules of the `ct-lean` skill (adapted from Ponytail 5.1.0,
 * DietrichGebert, MIT), emitted at every spawn tier so workers that never load
 * the skill still get them. The skill holds the full text; this block is the
 * part a worker needs on every task.
 *
 * The rules run at a level (`off`, `lite`, `full`, `ultra`). The level
 * resolves from `CLEO_LEAN_LEVEL`, then the session-scoped level written by
 * `cleo lean level <l> --session`, then the `lean.level` config key, then
 * `full`.
 *
 * @task T13422
 * @task T13663
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeanLevel, LeanLevelSource } from '@cleocode/contracts';
import { atomicWriteJson } from '../store/atomic.js';

/** Every lean level, in increasing strictness. */
export const LEAN_LEVELS: readonly LeanLevel[] = Object.freeze(['off', 'lite', 'full', 'ultra']);

/** The never-cut clause every non-`off` level carries. */
const NEVER_CUT =
  'Never cut validation, data-loss error handling, security, privacy, evidence gates, type safety or the package boundary.';

/** One-paragraph lean-change rule (level `full`); the full rules are in the `ct-lean` skill. */
export const LEAN_CHANGE_LINE = `Make the smallest complete change: skip anything nobody asked for (name it in one line); reuse a helper, contract or chokepoint already in the repo before writing new code; add no abstraction, option or dependency for later; fix a bug once at its root after grepping every caller; finish every caller, test and fixture the change breaks; leave one small test for new non-trivial logic. ${NEVER_CUT} End with one line on what you skipped or did not check. Full rules: the \`ct-lean\` skill.`;

/** Per-level rule paragraph (`off` has none). */
const LEVEL_LINES: Readonly<Record<Exclude<LeanLevel, 'off'>, string>> = {
  lite: `Lean (lite): build what was asked. When a smaller option fully works, name it in one line and let the owner pick; do not switch to it on your own. ${NEVER_CUT} End with one line on what you skipped or did not check. Full rules: the \`ct-lean\` skill.`,
  full: LEAN_CHANGE_LINE,
  ultra: `${LEAN_CHANGE_LINE} Ultra: before building, question the request. Push back on any part the need does not justify, then build the smallest version of what remains.`,
};

/**
 * Whether `value` (trimmed, any case) names a lean level.
 *
 * @param value - e.g. `process.env.CLEO_LEAN_LEVEL`.
 */
export function isLeanLevel(value: string | undefined | null): boolean {
  return normalise(value) !== undefined;
}

function normalise(value: string | undefined | null): LeanLevel | undefined {
  const wanted = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  return LEAN_LEVELS.find((l) => l === wanted);
}

/**
 * The lean rule paragraph for a level, or `null` for `off`.
 *
 * @param level - the resolved level.
 */
export function leanChangeLine(level: LeanLevel = 'full'): string | null {
  return level === 'off' ? null : LEVEL_LINES[level];
}

/**
 * Build the `## Lean Change (ct-lean)` spawn-prompt block, or `null` at level `off`.
 *
 * @param level - the resolved level (default `full`).
 */
export function buildLeanChangeBlock(level: LeanLevel = 'full'): string | null {
  const line = leanChangeLine(level);
  if (line === null) return null;
  const heading =
    level === 'full' ? '## Lean Change (ct-lean)' : `## Lean Change (ct-lean, ${level})`;
  return [heading, '', line].join('\n');
}

/** A resolved lean level and where it came from. */
export interface ResolvedLeanLevel {
  /** The effective level. */
  readonly level: LeanLevel;
  /** Which layer set it. */
  readonly source: LeanLevelSource;
}

/**
 * Resolve the effective level from its layers: env, then session, then
 * config, then `full`. Unknown values are ignored.
 *
 * @param layers - the raw value of each layer.
 * @returns the level and its source.
 */
export function resolveLeanLevel(layers: {
  readonly env?: string | null;
  readonly session?: string | null;
  readonly config?: string | null;
}): ResolvedLeanLevel {
  const order: readonly [LeanLevelSource, string | null | undefined][] = [
    ['env', layers.env],
    ['session', layers.session],
    ['config', layers.config],
  ];
  for (const [source, raw] of order) {
    const level = normalise(raw);
    if (level !== undefined) return { level, source };
  }
  return { level: 'full', source: 'default' };
}

/** The session-scoped level file (gitignored by `.cleo/.gitignore`, deny-by-default). */
export function leanSessionFile(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'lean-session.json');
}

/**
 * The session-scoped level, when it was set for `sessionId`. A level set in
 * another session is ignored, so it ends with the session that set it.
 *
 * @param projectRoot - the project root.
 * @param sessionId - the current CLEO session id, if known.
 */
export function readSessionLeanLevel(
  projectRoot: string,
  sessionId: string | null | undefined,
): LeanLevel | undefined {
  if (!sessionId) return undefined;
  const file = leanSessionFile(projectRoot);
  if (!existsSync(file)) return undefined;
  try {
    const data: { sessionId?: string; level?: string } = JSON.parse(readFileSync(file, 'utf-8'));
    return data.sessionId === sessionId ? normalise(data.level) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Set the level for one session only.
 *
 * @param projectRoot - the project root.
 * @param sessionId - the session the level belongs to.
 * @param level - the level.
 */
export async function writeSessionLeanLevel(
  projectRoot: string,
  sessionId: string,
  level: LeanLevel,
): Promise<void> {
  await atomicWriteJson(leanSessionFile(projectRoot), { sessionId, level });
}

/**
 * `lean.level` from the merged global + project config, or `undefined` when
 * unset, invalid or unreadable.
 *
 * @param projectRoot - the project root.
 */
export async function configuredLeanLevel(projectRoot: string): Promise<LeanLevel | undefined> {
  try {
    const { getConfigValue } = await import('../config/registry.js');
    return normalise(await getConfigValue<string>('lean.level', { projectRoot }));
  } catch {
    return undefined;
  }
}

/**
 * The effective level for a project and session: `CLEO_LEAN_LEVEL`, then the
 * session level, then `lean.level`, then `full`.
 *
 * @param opts - project root, session id and environment.
 */
export async function effectiveLeanLevel(opts: {
  readonly projectRoot: string;
  readonly sessionId?: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<ResolvedLeanLevel> {
  const env = opts.env ?? process.env;
  return resolveLeanLevel({
    env: env.CLEO_LEAN_LEVEL,
    session: readSessionLeanLevel(opts.projectRoot, opts.sessionId),
    config: await configuredLeanLevel(opts.projectRoot),
  });
}

/** Where `cleo lean level <l>` writes the level. */
export type LeanLevelScope = 'session' | 'project' | 'global';

/**
 * Persist a level: for one session (`session`, needs `sessionId`), or as the
 * `lean.level` key of the project or global config.
 *
 * @param opts - project root, level, scope and (for `session`) the session id.
 * @returns the level and scope written.
 * @throws Error when `scope` is `session` and no session id is given.
 */
export async function setLeanLevel(opts: {
  readonly projectRoot: string;
  readonly level: LeanLevel;
  readonly scope: LeanLevelScope;
  readonly sessionId?: string | null;
}): Promise<{ readonly level: LeanLevel; readonly scope: LeanLevelScope }> {
  if (opts.scope === 'session') {
    if (!opts.sessionId) {
      // @sync-invariant none:local-only the session lean level is a gitignored per-machine file; refused before any write
      throw new Error('no bound CLEO session: start or resume one, or drop --session');
    }
    await writeSessionLeanLevel(opts.projectRoot, opts.sessionId, opts.level);
  } else {
    const { setConfigValue } = await import('../config.js');
    await setConfigValue('lean.level', opts.level, opts.projectRoot, {
      global: opts.scope === 'global',
    });
  }
  return { level: opts.level, scope: opts.scope };
}
