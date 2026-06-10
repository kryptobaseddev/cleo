/**
 * `run_skill` agent tool — bridge the EXISTING SKILL.md loader to the agent loop
 * (T11949 · M7 · epic T11456 · SG-TOOLS; replaces the cancelled T11869).
 *
 * T11869 ("adopt Pi's SKILL.md loader") is CANCELLED: CLEO ALREADY owns a native
 * skill loader + dispatch path ({@link import('../skills/discovery.js')}'s
 * `parseFrontmatter` / `discoverSkill` / `findSkill`, plus
 * {@link import('../skills/dispatch.js')}'s `dispatchExplicit`). This tool does
 * NOT rebuild any of that. It surfaces the SUBSET of skills the model may invoke —
 * those whose frontmatter marks `invocable: true` — to the loop as a single
 * `run_skill` tool. `run_skill`:
 *
 *   - resolves a skill BY NAME via the EXISTING {@link findSkill} (the same
 *     filesystem scan + name-mapping the CLI uses);
 *   - REJECTS a skill whose frontmatter is not `invocable: true` (a typed, non-
 *     throwing failure result) — only explicitly-invocable skills are runnable;
 *   - dispatches the resolved skill through the EXISTING
 *     {@link dispatchExplicit} path and returns the skill's instructions
 *     (`SKILL.md` body) + dispatch metadata for the loop to act on.
 *
 * No new loader, no new parser, no new dispatch mechanism — pure consumption of
 * the skills subsystem (Gate-11: DEFINED here under `packages/core/src/tools`,
 * CONSUMES the skills path). The tier-0 skill-drift gate + skill-coverage map are
 * untouched — this is a consumer of the loader, not a change to it.
 *
 * ## Availability (always-true, daemon-OFF)
 *
 * Skill discovery is a LOCAL filesystem scan — no credential, no network, no
 * daemon. `run_skill` is therefore {@link ALWAYS_AVAILABLE}.
 *
 * ## Gate-13
 *
 * No model/transport/provider client is constructed here — resolving + reading a
 * SKILL.md is local I/O. There is no chokepoint concern.
 *
 * @epic T11456
 * @task T11949
 * @see ../skills/discovery.js — `findSkill` (the existing loader this tool reuses)
 * @see ../skills/dispatch.js — `dispatchExplicit` (the existing dispatch path)
 */

import { z } from 'zod';
import { resolveOrCwd } from '../paths.js';
import type { Skill } from '../skills/types.js';
import { type AgentToolRegistry, ALWAYS_AVAILABLE } from './agent-registry.js';

/**
 * The skills-subsystem seam {@link registerSkillAgentTool} resolves + dispatches a
 * skill through. Each member has the SAME signature as the corresponding existing
 * function. Injectable so the unit test can supply a fake skill surface (no real
 * SKILL.md on disk); defaults to the real `discovery` / `dispatch` functions.
 */
export interface SkillResolver {
  /** Resolve a skill by name (→ `findSkill`). Returns `null` when unknown. */
  readonly findSkill: (name: string, cwd?: string) => Skill | null;
  /**
   * Dispatch an explicit skill (→ `dispatchExplicit`). Returns the dispatch
   * metadata, or `null` when the skill does not resolve.
   */
  readonly dispatchExplicit: (
    skillName: string,
    cwd?: string,
  ) => { skill: string; strategy: string; confidence: number; protocol?: string } | null;
}

/** The shape `run_skill` returns to the loop — resolution outcome + payload. */
export interface RunSkillResult {
  /** Whether an invocable skill resolved and dispatched. */
  readonly ok: boolean;
  /** The resolved skill's canonical directory name (present on success). */
  readonly skill?: string;
  /** The dispatched protocol, when the skill declares one. */
  readonly protocol?: string;
  /** The `SKILL.md` body the loop acts on (present on success). */
  readonly instructions?: string;
  /** A stable code + message for why resolution failed (present on failure). */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Options for {@link registerSkillAgentTool} — all injectable for testing. */
export interface SkillAgentToolOptions {
  /** The skills-subsystem seam. Defaults to the real discovery + dispatch functions. */
  readonly resolver?: SkillResolver;
  /**
   * The cwd skill discovery scans from (defaults to the resolved project root via
   * {@link resolveOrCwd} — never a bare `process.cwd()` in core, T9584).
   */
  readonly cwd?: string;
}

/**
 * Build the real skills-subsystem seam by lazily importing the existing
 * `discovery` + `dispatch` modules. Lazy so this tool module is import-time
 * side-effect-free (the skills modules run filesystem-touching telemetry on
 * load); the import happens only when the real resolver is first needed.
 *
 * @returns The production {@link SkillResolver}.
 */
async function realResolver(): Promise<SkillResolver> {
  const { findSkill } = await import('../skills/discovery.js');
  const { dispatchExplicit } = await import('../skills/dispatch.js');
  return {
    findSkill,
    dispatchExplicit: (skillName, cwd) => {
      const result = dispatchExplicit(skillName, cwd);
      if (result === null) return null;
      return {
        skill: result.skill,
        strategy: result.strategy,
        confidence: result.confidence,
        ...(result.protocol !== undefined ? { protocol: result.protocol } : {}),
      };
    },
  };
}

/**
 * Register the `run_skill` tool into `registry`. Pure registration — no skill is
 * resolved, no SKILL.md is read here; all of that happens later inside the tool's
 * `execute` through the injected (or lazily-resolved real) seam. Import-time
 * side-effect-free.
 *
 * @param registry - The registry to populate.
 * @param options - Injectable resolver / cwd (for testing).
 */
export function registerSkillAgentTool(
  registry: AgentToolRegistry,
  options: SkillAgentToolOptions = {},
): void {
  const cwd = resolveOrCwd(options.cwd);

  registry.register({
    name: 'run_skill',
    // 'shell' — invoking a skill is a procedure run (its strongest side-effect surface).
    class: 'shell',
    description:
      'Resolve and run an invocable CLEO skill by name. Returns the skill instructions ' +
      '(SKILL.md body) and dispatch metadata for the loop to act on. Only skills whose ' +
      'frontmatter marks them invocable can be run.',
    toolset: 'agent',
    stateless: false,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      name: z.string().describe('The skill name to resolve and run (e.g. "ct-research-agent").'),
    }),
    execute: async (rawArgs): Promise<RunSkillResult> => {
      const name = String(rawArgs.name);
      const resolver = options.resolver ?? (await realResolver());

      const skill = resolver.findSkill(name, cwd);
      if (skill === null) {
        return {
          ok: false,
          error: { code: 'E_SKILL_NOT_FOUND', message: `no skill named "${name}"` },
        };
      }
      if (skill.frontmatter.invocable !== true) {
        return {
          ok: false,
          error: {
            code: 'E_SKILL_NOT_INVOCABLE',
            message: `skill "${skill.dirName}" is not invocable (frontmatter.invocable !== true)`,
          },
        };
      }

      // Dispatch through the EXISTING explicit-dispatch path (no new mechanism).
      const dispatch = resolver.dispatchExplicit(name, cwd);
      return {
        ok: true,
        skill: skill.dirName,
        ...(dispatch?.protocol !== undefined ? { protocol: dispatch.protocol } : {}),
        ...(skill.content !== undefined ? { instructions: skill.content } : {}),
      };
    },
  });
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. Aliases
 * {@link registerSkillAgentTool} so a future scan-dir discovery (or the built-in
 * aggregator) can call it uniformly with the other agent-tool modules.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerSkillAgentTool(registry);
}
