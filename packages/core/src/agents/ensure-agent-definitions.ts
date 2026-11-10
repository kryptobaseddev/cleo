/**
 * Install the canonical CLEO lead and worker agent definitions into every
 * detected provider that loads project agent files (T14378).
 *
 * Replaces the dead `initAgentDefinition`, which looked for an
 * `agents/cleo-subagent/` directory no package ships and so skipped on every
 * run. Provider facts (agent directory, file format) and rendering live in
 * CAAMP; the canonical `.cant` definitions live in `@cleocode/agents`
 * (`definitions/`); this module only orchestrates the writes for init and
 * upgrade.
 *
 * Idempotent: a file that already holds the rendered content is left alone,
 * and a file without CAAMP's generated marker belongs to the user and is
 * never overwritten.
 *
 * @module agents/ensure-agent-definitions
 * @task T14378
 * @epic T14351
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition, Provider } from '@cleocode/caamp';
import {
  LEAD_DENIED_TOOLS,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL,
} from '@cleocode/contracts/operations/orchestrate.js';
import { type UpgradeFileJournal, writeIfChanged } from '../scaffold/upgrade-file-journal.js';
import { resolveAgentDefinitionsDir } from './resolveAgentTemplates.js';

/** What happened to one provider's agent file, or to a provider as a whole. */
export interface AgentDefinitionOutcome {
  /** Provider id. */
  readonly provider: string;
  /**
   * - `created` / `updated` / `unchanged`: the rendered file at `path`.
   * - `user-owned`: `path` exists without CAAMP's marker and was left alone.
   * - `unsupported`: the provider has no verified project agent-file support,
   *   or (with `agent` and `reason`) its format cannot express that agent's
   *   tool policy, so the file is not written (T14374).
   * - `failed`: rendering or writing failed (`reason`).
   */
  readonly status: 'created' | 'updated' | 'unchanged' | 'user-owned' | 'unsupported' | 'failed';
  /** Agent name, for per-file outcomes. */
  readonly agent?: string;
  /** Absolute file path, for per-file outcomes. */
  readonly path?: string;
  /** Why, for `failed` and a per-agent `unsupported`. */
  readonly reason?: string;
}

/** Result of {@link ensureAgentDefinitions}. */
export interface AgentDefinitionsReport {
  /** Set when nothing was attempted, with the reason. */
  readonly skipped?: string;
  /** One outcome per provider file, plus one per unsupported provider. */
  readonly outcomes: readonly AgentDefinitionOutcome[];
}

/** Options for {@link ensureAgentDefinitions}. */
export interface EnsureAgentDefinitionsOptions {
  /** Providers to deliver to. @defaultValue CAAMP's installed (detected) providers */
  readonly providers?: readonly Provider[];
  /** Upgrade journal: changed files are backed up before they are replaced. */
  readonly journal?: UpgradeFileJournal;
  /** Directory of canonical `.cant` definitions. @defaultValue `@cleocode/agents/definitions` */
  readonly definitionsDir?: string;
}

/** A tool name compared by its base: `Agent(cleo-worker)` → `agent`. */
function toolBase(tool: string): string {
  return tool
    .replace(/\(.*\)$/s, '')
    .trim()
    .toLowerCase();
}

/**
 * Apply the lead tool policy to a lead definition: deny every
 * {@link LEAD_DENIED_TOOLS} entry, allow the command runner tool, and declare
 * the runner's MCP server (`cleo orchestrate lead-runner`). Worker definitions
 * are returned unchanged.
 *
 * A denied tool is removed from `tools` whatever its case and any `Name(...)`
 * pattern (`bash(git *)` goes too).
 *
 * @param def - A parsed canonical definition.
 * @returns The definition as delivered.
 * @throws When the lead has no `tools:` list or a `*` entry (it would inherit
 *   every tool), or a bare `Agent` entry (it could spawn any agent type; use
 *   `Agent(cleo-worker)`).
 *
 * @example
 * ```typescript
 * applyLeadToolPolicy(lead).deniedTools; // includes 'Bash', 'Edit', 'Write'
 * ```
 *
 * @task T14374
 */
export function applyLeadToolPolicy(def: AgentDefinition): AgentDefinition {
  if (def.role !== 'lead') return def;
  if (!def.tools || def.tools.some((t) => t.trim() === '*')) {
    // @sync-invariant none:input-shape a lead .cant file without an explicit tool allow-list is refused before any agent file is written
    throw new Error(
      `lead "${def.name}": tools must be an explicit allow-list (a missing tools: or "*" inherits every tool)`,
    );
  }
  if (def.tools.some((t) => t.trim().toLowerCase() === 'agent')) {
    // @sync-invariant none:input-shape a lead .cant file allowing a bare Agent is refused before any agent file is written
    throw new Error(
      `lead "${def.name}": bare Agent can spawn any agent type; allow Agent(cleo-worker) instead`,
    );
  }
  const denied = [...new Set([...(def.deniedTools ?? []), ...LEAD_DENIED_TOOLS])];
  const deniedBases = new Set(denied.map(toolBase));
  const tools = [...new Set([...def.tools, LEAD_RUNNER_TOOL])].filter(
    (t) => !deniedBases.has(toolBase(t)),
  );
  return {
    ...def,
    tools,
    deniedTools: denied,
    mcpServers: {
      ...def.mcpServers,
      [LEAD_RUNNER_MCP_SERVER]: { command: 'cleo', args: ['orchestrate', 'lead-runner'] },
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write the canonical lead and worker definitions for every provider.
 *
 * @param projectRoot - Absolute project root.
 * @param options - Providers, upgrade journal and definitions directory (tests).
 * @returns Per-provider outcomes, or `skipped` with the reason.
 *
 * @example
 * ```typescript
 * const { outcomes } = await ensureAgentDefinitions('/repo');
 * ```
 */
export async function ensureAgentDefinitions(
  projectRoot: string,
  options: EnsureAgentDefinitionsOptions = {},
): Promise<AgentDefinitionsReport> {
  let caamp: typeof import('@cleocode/caamp');
  try {
    caamp = await import('@cleocode/caamp');
  } catch {
    return { skipped: '@cleocode/caamp not installed', outcomes: [] };
  }
  // A home-directory project's agent dirs are the user-global ones (~/.claude/agents).
  if (caamp.isHomeProject(projectRoot)) {
    return {
      skipped: 'the project is your home directory; agent files there would apply to every project',
      outcomes: [],
    };
  }
  const dir = options.definitionsDir ?? resolveAgentDefinitionsDir();
  if (!dir || !existsSync(dir)) {
    return { skipped: '@cleocode/agents definitions/ not found', outcomes: [] };
  }

  const definitions: AgentDefinition[] = [];
  const outcomes: AgentDefinitionOutcome[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.cant'))
    .sort()) {
    try {
      const def = caamp.parseAgentDefinition(readFileSync(join(dir, file), 'utf-8'));
      definitions.push(applyLeadToolPolicy(def));
    } catch (err) {
      outcomes.push({
        provider: '*',
        status: 'failed',
        path: join(dir, file),
        reason: message(err),
      });
    }
  }

  for (const provider of options.providers ?? caamp.getInstalledProviders()) {
    const target = provider.agentDefinitions;
    if (!target) {
      outcomes.push({ provider: provider.id, status: 'unsupported' });
      continue;
    }
    for (const def of definitions) {
      let path: string | undefined;
      const unsupported = caamp.agentDefinitionUnsupportedReason(def, target.format);
      if (unsupported) {
        // T14374: never write a lead the format cannot restrict; a lead spawn
        // there is refused with E_LEAD_TOOLS_UNSTRIPPED by its spawn provider.
        outcomes.push({
          provider: provider.id,
          status: 'unsupported',
          agent: def.name,
          reason: unsupported,
        });
        continue;
      }
      try {
        const rendered = caamp.renderAgentDefinition(def, target.format);
        path = join(projectRoot, target.pathProject, rendered.fileName);
        const existed = existsSync(path);
        if (existed && !caamp.isGeneratedAgentDefinition(readFileSync(path, 'utf-8'))) {
          outcomes.push({ provider: provider.id, status: 'user-owned', agent: def.name, path });
          continue;
        }
        const wrote = await writeIfChanged(path, rendered.content, options.journal);
        const status = !wrote ? 'unchanged' : existed ? 'updated' : 'created';
        outcomes.push({ provider: provider.id, status, agent: def.name, path });
      } catch (err) {
        outcomes.push({
          provider: provider.id,
          status: 'failed',
          agent: def.name,
          ...(path ? { path } : {}),
          reason: message(err),
        });
      }
    }
  }
  return { outcomes };
}

/**
 * Report lines for init/upgrade: every write as `applied`; unsupported
 * providers (one line), agents a format cannot express, user-owned files and
 * failures as `warnings`.
 * Unchanged files add nothing.
 *
 * @param report - The delivery report.
 * @returns Lines to list as created/applied and as warnings.
 */
export function agentDefinitionReportLines(report: AgentDefinitionsReport): {
  readonly applied: readonly string[];
  readonly warnings: readonly string[];
} {
  const applied: string[] = [];
  const warnings: string[] = [];
  if (report.skipped) warnings.push(`agent definitions skipped: ${report.skipped}`);
  const unsupported: string[] = [];
  for (const o of report.outcomes) {
    if (o.status === 'created' || o.status === 'updated') {
      applied.push(`agent definition (${o.provider}): ${o.status} ${o.path}`);
    } else if (o.status === 'unsupported' && o.agent) {
      warnings.push(`agent definition (${o.provider}) ${o.agent}: not installed; ${o.reason}`);
    } else if (o.status === 'unsupported') {
      unsupported.push(o.provider);
    } else if (o.status === 'user-owned') {
      warnings.push(`agent definition (${o.provider}): ${o.path} has no CLEO marker; left as is`);
    } else if (o.status === 'failed') {
      warnings.push(`agent definition (${o.provider}) ${o.agent ?? o.path ?? ''}: ${o.reason}`);
    }
  }
  if (unsupported.length > 0) {
    warnings.push(
      `agent definitions unsupported (no project agent-file support): ${unsupported.join(', ')}`,
    );
  }
  return { applied, warnings };
}
