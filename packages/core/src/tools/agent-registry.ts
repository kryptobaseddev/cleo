/**
 * Agent-facing tool registry (T1739 · epic T11456 · SG-TOOLS).
 *
 * EXTENDS the CORE-SDK tool layer (`core/src/tools/*`) with an AGENT-FACING
 * registry alongside the existing skill-tools engine — the cleocode analogue of
 * Hermes' `tools/registry.py`. Where {@link ./fs.js}/{@link ./shell.js} are the
 * raw side-effecting primitives and {@link ./guard.js} is the deny-first
 * chokepoint, THIS module is what an agent loop (the Pi adapter / ModelRunner)
 * consults to learn "which tools exist, what is each tool's OpenAI-format schema,
 * which toolset does it belong to, is it available right now, and how do I run
 * it". It owns NO side-effects of its own: every registered tool's executable is
 * bound over an injected {@link GuardedToolSurface}, so all fs/shell work still
 * funnels through {@link createToolGuard} — there is no raw-primitive bypass.
 *
 * ## Responsibilities (the 8 acceptance criteria)
 *
 * - **AC1** — the {@link AgentToolRegistry} class lives here.
 * - **AC2** — {@link AgentToolRegistry.discover} performs a BOUNDED directory
 *   scan for agent-tool modules (a lightweight source scan for the registration
 *   marker, then a dynamic import of only the matching modules) — NOT a heavy
 *   whole-tree AST parse, and NEVER at module import.
 * - **AC3** — {@link AgentToolRegistry.toOpenAITools} emits the OpenAI-format
 *   {@link TransportTool}[] the Pi adapter / transport wire layer consume, via
 *   the single shared {@link zodSchemaToOpenAITool} generator (DRY).
 * - **AC4** — every tool declares a {@link Toolset} group (`terminal | file |
 *   web | agent | media`); {@link AgentToolRegistry.byToolset} buckets them.
 * - **AC5** — every tool declares an {@link AvailabilityCheck} predicate, so a
 *   tool can be hidden when its preconditions (e.g. network egress, a binary on
 *   PATH) are not met for the current {@link ToolAvailabilityContext}.
 * - **AC6** — the registry is effectively IMMUTABLE after {@link
 *   AgentToolRegistry.init}: registration is rejected once initialised and
 *   `init()` is single-flight (concurrent callers await one shared promise), so
 *   there is no shared-mutable-state race.
 * - **AC7** — auto-discovery is exposed as an EXPLICIT {@link
 *   AgentToolRegistry.init} called at startup. Module import registers nothing
 *   and runs no heavy work (lazy {@link getLogger}; no scan at import).
 *
 * @task T1739
 * @epic T11456
 * @see ./guard.js — the deny-first chokepoint every tool executable routes through
 * @see ./schema-gen.js — the single OpenAI-format schema generator (AC3)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransportTool } from '@cleocode/contracts/llm/normalized-response.js';
import type { ToolClass, ToolPrimitiveDescriptor, Toolset } from '@cleocode/contracts/tools/atomic';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import type { z } from 'zod';
import { getLogger } from '../logger.js';
import { registerBuiltinAgentTools } from './builtin-agent-tools.js';
import { zodSchemaToOpenAITool } from './schema-gen.js';

// Lazy subsystem logger — `getLogger` is safe pre-init and triggers NO heavy
// work at module import (AC7).
const log = getLogger('agent-tool-registry');

/**
 * The marker an agent-tool module must export for the bounded directory scan
 * (AC2) to dynamically import it: a function `registerAgentTools(registry)` that
 * self-registers the module's tools. The scan greps for this identifier in the
 * source before importing, so non-tool modules are never loaded.
 */
export const AGENT_TOOL_REGISTER_FN = 'registerAgentTools';

/**
 * Context handed to an {@link AvailabilityCheck}. Carries the ambient signals a
 * tool needs to decide whether it can run right now, without coupling the
 * registry to any one consumer's environment shape.
 */
export interface ToolAvailabilityContext {
  /** Whether outbound network egress is permitted in this run. */
  readonly networkEgressAllowed?: boolean;
  /** Executable basenames known to be resolvable on `PATH` (e.g. `['git']`). */
  readonly availableBinaries?: readonly string[];
  /** Free-form capability flags a tool may gate on (forward-compatible). */
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

/**
 * Availability predicate (AC5). Returns `true` when the tool can be offered to
 * the model for the given {@link ToolAvailabilityContext}. MUST be a pure, fast,
 * synchronous function of its input — it is evaluated every time the available
 * toolset is enumerated.
 */
export type AvailabilityCheck = (ctx: ToolAvailabilityContext) => boolean;

/** An {@link AvailabilityCheck} that always reports available. */
export const ALWAYS_AVAILABLE: AvailabilityCheck = () => true;

/**
 * The bound, ready-to-invoke executable for a registered tool. Receives the
 * model-supplied arguments (already JSON-parsed) and the injected
 * {@link GuardedToolSurface} it must perform all side effects through, and
 * returns an opaque result the caller serialises back to the model.
 */
export type AgentToolExecutable = (
  args: Readonly<Record<string, unknown>>,
  tools: GuardedToolSurface,
) => Promise<unknown>;

/**
 * A single agent-facing tool registration. Composes the atomic-tool taxonomy
 * descriptor ({@link ToolPrimitiveDescriptor}) with the agent-facing fields the
 * loop needs: a Zod parameter schema (→ OpenAI schema, AC3), a {@link Toolset}
 * group (AC4), an {@link AvailabilityCheck} (AC5), and the bound
 * {@link AgentToolExecutable}.
 */
export interface AgentToolDescriptor {
  /** Stable, model-visible tool name (unique within a registry). */
  readonly name: string;
  /** The side-effect class this tool's underlying primitive belongs to. */
  readonly class: ToolClass;
  /** Human-readable description shown to the model. */
  readonly description: string;
  /** Agent-facing toolset group (AC4). */
  readonly toolset: Toolset;
  /** Zod schema for the tool's input parameters (→ OpenAI schema via AC3). */
  readonly parameters: z.ZodType;
  /** Whether the underlying primitive is a pure function of its input. */
  readonly stateless: boolean;
  /** Availability predicate (AC5). Defaults to {@link ALWAYS_AVAILABLE}. */
  readonly available?: AvailabilityCheck;
  /** Bound executable — performs work through the guarded surface only. */
  readonly execute: AgentToolExecutable;
}

/**
 * Options for {@link AgentToolRegistry.discover} / {@link AgentToolRegistry.init}.
 */
export interface AgentToolDiscoveryOptions {
  /**
   * Absolute directories to scan for agent-tool modules (AC2). Each `*.ts`/`*.js`
   * file exporting {@link AGENT_TOOL_REGISTER_FN} is dynamically imported and its
   * `registerAgentTools(registry)` invoked. Omit to register ONLY the built-in
   * atomic primitives.
   */
  readonly scanDirs?: readonly string[];
  /**
   * Skip registering the built-in atomic primitives (fs/shell). Defaults to
   * `false` — the built-ins are registered so the registry is never empty and
   * the Pi adapter can consume them immediately.
   */
  readonly skipBuiltins?: boolean;
}

/** Convert a registry entry into its taxonomy descriptor (lossless subset). */
function toPrimitiveDescriptor(t: AgentToolDescriptor): ToolPrimitiveDescriptor {
  return {
    name: t.name,
    class: t.class,
    responsibility: t.description,
    stateless: t.stateless,
  };
}

/**
 * The agent-facing tool registry (AC1).
 *
 * Lifecycle: construct → {@link register} built-ins/custom tools (or let
 * {@link init} do it) → {@link init} (idempotent, single-flight) → read-only
 * queries ({@link list}, {@link byToolset}, {@link available},
 * {@link toOpenAITools}, {@link getExecutable}). After `init()` the tool set is
 * frozen; a late {@link register} throws (AC6).
 *
 * @example
 * ```ts
 * const registry = new AgentToolRegistry();
 * await registry.init(); // registers built-in atomic primitives (AC7)
 * const openai = registry.toOpenAITools();          // AC3
 * const fileTools = registry.byToolset('file');     // AC4
 * const usable = registry.available({ networkEgressAllowed: false }); // AC5
 * ```
 */
export class AgentToolRegistry {
  /** name → descriptor. Mutated only before {@link #initialised} flips true. */
  readonly #tools = new Map<string, AgentToolDescriptor>();

  /** Frozen-after-init guard (AC6). */
  #initialised = false;

  /** Single-flight init promise so concurrent {@link init} calls coalesce (AC6). */
  #initPromise: Promise<void> | null = null;

  /** Whether {@link init} has completed (the tool set is frozen). */
  get initialised(): boolean {
    return this.#initialised;
  }

  /** Number of registered tools. */
  get size(): number {
    return this.#tools.size;
  }

  /**
   * Register a single agent tool. Rejects duplicate names and any registration
   * after {@link init} has completed (AC6 — the registry is immutable post-init).
   *
   * @param tool - The tool to register.
   * @throws Error when the registry is already initialised, or the name is taken.
   */
  register(tool: AgentToolDescriptor): void {
    if (this.#initialised) {
      throw new Error(
        `agent-tool-registry: cannot register "${tool.name}" after init() — the registry is frozen`,
      );
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`agent-tool-registry: duplicate tool name "${tool.name}"`);
    }
    this.#tools.set(tool.name, tool);
  }

  /**
   * Initialise the registry (AC7): register the built-in atomic primitives
   * (unless `skipBuiltins`), run bounded module discovery over `scanDirs`
   * (AC2), then FREEZE the tool set. Idempotent and single-flight — concurrent
   * callers await one shared promise and a second call after completion is a
   * no-op (AC6).
   *
   * @param options - Discovery options ({@link AgentToolDiscoveryOptions}).
   */
  async init(options: AgentToolDiscoveryOptions = {}): Promise<void> {
    if (this.#initialised) return;
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = this.#runInit(options);
    try {
      await this.#initPromise;
    } finally {
      this.#initPromise = null;
    }
  }

  /** Inner init body — guarded by the single-flight latch in {@link init}. */
  async #runInit(options: AgentToolDiscoveryOptions): Promise<void> {
    if (options.skipBuiltins !== true) {
      registerBuiltinAgentTools(this);
    }
    if (options.scanDirs && options.scanDirs.length > 0) {
      await this.discover(options.scanDirs);
    }
    this.#initialised = true;
    log.debug({ count: this.#tools.size }, 'agent-tool-registry initialised');
  }

  /**
   * Bounded discovery (AC2): for each directory, read its entries (NON-recursive,
   * bounded), grep each `*.agent-tool.{ts,js}` candidate's SOURCE for the
   * {@link AGENT_TOOL_REGISTER_FN} export marker, and dynamically import ONLY the
   * matching modules — then invoke each module's `registerAgentTools(this)`.
   *
   * This is a lightweight source scan rather than a whole-tree AST parse: it does
   * the minimum work to locate self-registering tool modules without loading the
   * whole package. It is invoked from {@link init} (explicit startup) and never at
   * module import (AC7). May also be called directly before `init()` for tests.
   *
   * @param scanDirs - Absolute directories to scan.
   * @throws Error when called after the registry is frozen (AC6).
   */
  async discover(scanDirs: readonly string[]): Promise<void> {
    if (this.#initialised) {
      throw new Error(
        'agent-tool-registry: cannot discover() after init() — the registry is frozen',
      );
    }
    for (const dir of scanDirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        log.warn({ dir, err }, 'agent-tool-registry: scan dir unreadable — skipped');
        continue;
      }
      for (const entry of entries) {
        if (!/\.agent-tool\.(ts|js)$/.test(entry)) continue;
        const full = join(dir, entry);
        // Source-marker scan: only import a module that actually exports the
        // registration fn. Cheaper + safer than importing every file.
        let src: string;
        try {
          src = await readFile(full, 'utf8');
        } catch (err) {
          log.warn({ full, err }, 'agent-tool-registry: candidate unreadable — skipped');
          continue;
        }
        if (!src.includes(AGENT_TOOL_REGISTER_FN)) continue;
        const mod: unknown = await import(full);
        const register = (mod as Record<string, unknown>)[AGENT_TOOL_REGISTER_FN];
        if (typeof register !== 'function') {
          log.warn(
            { full },
            'agent-tool-registry: module has no callable registerAgentTools — skipped',
          );
          continue;
        }
        (register as (r: AgentToolRegistry) => void)(this);
      }
    }
  }

  /**
   * Look up a registered tool by name.
   *
   * @param name - The tool name.
   * @returns The descriptor, or `undefined` when unknown.
   */
  get(name: string): AgentToolDescriptor | undefined {
    return this.#tools.get(name);
  }

  /**
   * All registered tools in deterministic (insertion) order. The returned array
   * is a fresh copy — mutating it never affects the registry (AC6).
   */
  list(): readonly AgentToolDescriptor[] {
    return [...this.#tools.values()];
  }

  /**
   * Tools grouped by {@link Toolset} (AC4). Every {@link Toolset} key is present
   * (empty array when no tool occupies it), so consumers can render a stable
   * grouping without missing-key checks.
   */
  byToolset(): Record<Toolset, readonly AgentToolDescriptor[]>;
  /**
   * Tools belonging to a single {@link Toolset} (AC4).
   *
   * @param toolset - The toolset to filter by.
   */
  byToolset(toolset: Toolset): readonly AgentToolDescriptor[];
  byToolset(
    toolset?: Toolset,
  ): Record<Toolset, readonly AgentToolDescriptor[]> | readonly AgentToolDescriptor[] {
    if (toolset !== undefined) {
      return this.list().filter((t) => t.toolset === toolset);
    }
    const grouped: Record<Toolset, AgentToolDescriptor[]> = {
      terminal: [],
      file: [],
      web: [],
      agent: [],
      media: [],
    };
    for (const t of this.#tools.values()) {
      grouped[t.toolset].push(t);
    }
    return grouped;
  }

  /**
   * The subset of tools available for the given context (AC5). A tool without an
   * explicit {@link AgentToolDescriptor.available} predicate is treated as
   * {@link ALWAYS_AVAILABLE}.
   *
   * @param ctx - The availability context.
   * @returns Tools whose predicate returns `true`, in registration order.
   */
  available(ctx: ToolAvailabilityContext = {}): readonly AgentToolDescriptor[] {
    return this.list().filter((t) => (t.available ?? ALWAYS_AVAILABLE)(ctx));
  }

  /**
   * Emit the OpenAI-format {@link TransportTool}[] for the model (AC3) — the
   * shape the Pi adapter / ModelRunner transport layer consume. Generated via the
   * single shared {@link zodSchemaToOpenAITool} generator so the registry and the
   * Pi streamFn never drift.
   *
   * @param ctx - When provided, only AVAILABLE tools (AC5) are emitted; otherwise
   *   every registered tool is emitted.
   * @returns OpenAI-format tool definitions in deterministic order.
   */
  toOpenAITools(ctx?: ToolAvailabilityContext): readonly TransportTool[] {
    const tools = ctx ? this.available(ctx) : this.list();
    return tools.map((t) =>
      zodSchemaToOpenAITool({ name: t.name, description: t.description, parameters: t.parameters }),
    );
  }

  /**
   * The bound executable for a tool (the name→handler dispatch map, AC1).
   *
   * @param name - The tool name.
   * @returns The {@link AgentToolExecutable}, or `undefined` when unknown.
   */
  getExecutable(name: string): AgentToolExecutable | undefined {
    return this.#tools.get(name)?.execute;
  }

  /**
   * The taxonomy descriptors ({@link ToolPrimitiveDescriptor}) for every
   * registered tool — the lossless subset compatible with the canonical
   * `ATOMIC_TOOL_PRIMITIVES` registry, for callers that want the class taxonomy
   * without the agent-facing schema/executable.
   */
  primitiveDescriptors(): readonly ToolPrimitiveDescriptor[] {
    return this.list().map(toPrimitiveDescriptor);
  }
}

/**
 * Build and initialise an {@link AgentToolRegistry} in one call (AC7 convenience).
 * Equivalent to `new AgentToolRegistry()` + `await registry.init(options)`.
 *
 * @param options - Discovery options.
 * @returns A frozen, ready-to-query registry.
 */
export async function createAgentToolRegistry(
  options: AgentToolDiscoveryOptions = {},
): Promise<AgentToolRegistry> {
  const registry = new AgentToolRegistry();
  await registry.init(options);
  return registry;
}
