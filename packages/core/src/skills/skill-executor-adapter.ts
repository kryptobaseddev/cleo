/**
 * `SkillExecutorAdapter` — concrete in-process implementation of the
 * Dependency-Inversion seam declared in
 * `@cleocode/contracts/tools/skill-executor` ({@link SkillExecutor}).
 *
 * ## What it does (T11477 acceptance)
 *
 * - **AC1** — resolves a `ct-*` skill by id (via {@link findSkill}, the existing
 *   in-process discovery mechanism) and runs it over the injected
 *   {@link GuardedToolSurface}, returning a `{ status, output, error }` envelope.
 * - **AC4** — the skill→tool joint is **in-process**: the adapter loads the skill
 *   definition and exercises the guarded primitives directly. There is NO
 *   process boundary between resolving the skill and touching the tools — the
 *   subprocess-spawn path (`orchestrateSpawnExecute`) is reserved for isolation
 *   nodes and is wired separately (see {@link createSkillNodeExecutor}).
 *
 * ## Why a DIP adapter (not a direct import)
 *
 * The skill dispatcher (`CoreAgentDispatcher`, a high-level orchestration
 * concern) depends on the abstract {@link SkillExecutor} interface, NOT on this
 * concrete class. This adapter is INJECTED as
 * `CoreAgentDispatcherOptions.executor` so the dispatch policy and the execution
 * mechanism both depend on the contract, not on each other — the classic
 * Dependency-Inversion move (T11476 charter).
 *
 * ## Execution model + extension point
 *
 * `SkillExecutorAdapter.execute()` resolves the skill, validates it exists, and
 * runs the supplied {@link SkillRunner} over the guarded tool surface. The
 * default runner ({@link defaultSkillRunner}) loads the skill content
 * in-process and records resolution metadata — a deterministic, side-effect-free
 * baseline that wires the seam end-to-end without booting an LLM/GenKit flow.
 * The actual model-driven execution (GenKit phase, P1) plugs in here by passing
 * a richer {@link SkillRunner} — the seam, routing, and tool injection are all
 * already in place.
 *
 * @epic T11391
 * @task T11477
 * @saga T11387
 * @see ./skill-executor-adapter.ts — this file
 * @see @cleocode/contracts/tools/skill-executor — the DIP abstraction
 */

import type {
  GuardedToolSurface,
  SkillExecuteInput,
  SkillExecuteResult,
  SkillExecutor,
} from '@cleocode/contracts/tools/skill-executor';
import { getLogger } from '../logger.js';
import { findSkill } from './discovery.js';
import type { Skill } from './types.js';

const log = getLogger('skill-executor-adapter');

/**
 * Pluggable strategy that performs the actual in-process work for a resolved
 * skill over the guarded tool surface.
 *
 * The {@link SkillExecutorAdapter} owns resolution + the success/failure
 * envelope; the runner owns "what running this skill means". This keeps the
 * adapter open for extension (a future GenKit/LLM runner) and closed for
 * modification (the DIP seam, routing, and tool injection never change) —
 * Open/Closed Principle.
 *
 * @param skill - The resolved skill definition (frontmatter + content).
 * @param input - The original execution envelope (skill id, context, tools).
 * @returns The terminal {@link SkillExecuteResult} for this execution.
 */
export type SkillRunner = (skill: Skill, input: SkillExecuteInput) => Promise<SkillExecuteResult>;

/**
 * Default in-process skill runner.
 *
 * Loads the resolved skill in-process and returns a success envelope carrying
 * resolution metadata (skill id, directory, frontmatter name/protocol). It is
 * deterministic and performs no model inference — the baseline execution path
 * that proves the skill→tool joint is in-process and lets callers (tests,
 * dry-run playbook traversals) assert against a stable shape.
 *
 * It is the documented EXTENSION POINT: a model-driven runner (GenKit phase)
 * sequences the atomic tool primitives via `input.tools` and returns its own
 * `output` — without changing the adapter, the DIP seam, or the dispatcher
 * wiring.
 *
 * @param skill - The resolved skill definition.
 * @param input - The original execution envelope.
 * @returns A success envelope with resolution metadata in `output`.
 */
export const defaultSkillRunner: SkillRunner = async (skill, input) => {
  // The guarded tool surface is in-process and ready; the baseline runner does
  // not perform side effects, but the binding is asserted so the seam is real.
  const _tools: GuardedToolSurface = input.tools;
  void _tools;

  return {
    status: 'success',
    output: {
      skillId: input.skillId,
      resolved: true,
      dirName: skill.dirName,
      skillName: skill.frontmatter.name,
      ...(skill.frontmatter.protocol !== undefined ? { protocol: skill.frontmatter.protocol } : {}),
    },
  };
};

/**
 * Options accepted by {@link SkillExecutorAdapter}.
 *
 * @task T11477
 */
export interface SkillExecutorAdapterOptions {
  /**
   * Working directory used to resolve the skill search paths (project-custom,
   * agent-skills, marketplace). Defaults to the process cwd via {@link findSkill}.
   */
  readonly cwd?: string;
  /**
   * Strategy that performs the actual in-process execution of a resolved skill.
   * Defaults to {@link defaultSkillRunner}. The GenKit-phase model runner is
   * supplied here without touching the adapter or the DIP seam.
   */
  readonly runner?: SkillRunner;
}

/**
 * Concrete in-process implementation of the {@link SkillExecutor} DIP seam.
 *
 * Resolves a `ct-*` skill by id and runs it over the injected
 * {@link GuardedToolSurface} — no subprocess, no process boundary (AC4). The
 * dispatcher depends on the {@link SkillExecutor} abstraction and receives this
 * adapter by injection (AC2).
 *
 * @example
 * ```ts
 * const adapter = new SkillExecutorAdapter({ cwd: projectRoot });
 * const tools = createToolGuard({ allowedRoots: [projectRoot] });
 * const result = await adapter.execute({ skillId: 'ct-validator', context: {}, tools });
 * // result.status === 'success' when the skill resolves in-process
 * ```
 *
 * @task T11477
 */
export class SkillExecutorAdapter implements SkillExecutor {
  private readonly cwd: string | undefined;
  private readonly runner: SkillRunner;

  /**
   * @param opts - Resolution cwd and an optional in-process runner strategy.
   */
  constructor(opts: SkillExecutorAdapterOptions = {}) {
    this.cwd = opts.cwd;
    this.runner = opts.runner ?? defaultSkillRunner;
  }

  /**
   * Resolve `input.skillId` to a `ct-*` skill and run it in-process over the
   * injected guarded tool surface.
   *
   * Returns `status: 'failure'` (never throws) when the skill cannot be
   * resolved or the runner rejects — mirroring the playbook runtime's
   * non-throwing dispatch contract so retry / escalation semantics stay intact.
   *
   * @param input - Skill identity, accumulated context, and the guarded tool
   *   surface the skill is permitted to use.
   * @returns The terminal {@link SkillExecuteResult}.
   */
  public async execute(input: SkillExecuteInput): Promise<SkillExecuteResult> {
    const skill = findSkill(input.skillId, this.cwd);
    if (skill === null) {
      const error = `skill "${input.skillId}" not found in any skill search path`;
      log.warn({ skillId: input.skillId }, error);
      return { status: 'failure', output: {}, error };
    }

    try {
      return await this.runner(skill, input);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ skillId: input.skillId, error }, 'skill runner threw');
      return { status: 'failure', output: {}, error };
    }
  }
}
