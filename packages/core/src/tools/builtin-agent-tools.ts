/**
 * Built-in agent tools (T1739 · epic T11456 · SG-TOOLS).
 *
 * Wires the existing CORE-SDK atomic primitives ({@link ./fs.js} +
 * {@link ./shell.js}) into the agent-facing {@link ./agent-registry.js |
 * AgentToolRegistry} as its FIRST registered tools, so the registry is never
 * empty and the Pi adapter / ModelRunner can consume them immediately. Every
 * built-in tool:
 *
 *   - declares a Zod parameter schema (→ OpenAI-format schema via AC3);
 *   - declares its agent-facing {@link Toolset} group (AC4) and side-effect
 *     {@link ToolClass};
 *   - declares an {@link AvailabilityCheck} (AC5) — e.g. `run_git` is only
 *     available when a `git` binary is known to be on PATH;
 *   - performs ALL side effects through the injected {@link GuardedToolSurface}
 *     (NEVER raw `fs`/`shell`), so the deny-first guard chokepoint
 *     ({@link ./guard.js}) policy still applies — there is no bypass.
 *
 * The model-visible names are snake_case (OpenAI-function convention); the
 * underlying primitive names live in `@cleocode/contracts/tools/atomic`.
 *
 * @task T1739
 * @epic T11456
 */

import { z } from 'zod';
import type { AgentToolRegistry, AvailabilityCheck } from './agent-registry.js';
import { ALWAYS_AVAILABLE } from './agent-registry.js';
import { registerAgentToolFamilies } from './agent-tool-families.js';
import { registerExecCodeAgentTool } from './exec-code-agent-tool.js';
import { registerMcpAgentTools } from './mcp-agent-tool.js';
import { registerMediaAgentTools } from './media-agent-tools.js';
import { registerMemoryAgentTools } from './memory-agent-tools.js';
import { registerScheduleAgentTools } from './schedule-agent-tools.js';
import { registerSkillAgentTool } from './skill-agent-tool.js';
import { registerWebAgentTools } from './web-agent-tools.js';

/** Available only when the named binary is known on PATH (AC5 example). */
function binaryAvailable(name: string): AvailabilityCheck {
  return (ctx) => ctx.availableBinaries === undefined || ctx.availableBinaries.includes(name);
}

/**
 * Register the built-in atomic-primitive tools into `registry`.
 *
 * Invoked by {@link AgentToolRegistry.init} (unless `skipBuiltins`). Pure
 * registration — no I/O, no scan; the tools' side effects happen later through
 * the {@link GuardedToolSurface} their executables receive.
 *
 * @param registry - The registry to populate.
 */
export function registerBuiltinAgentTools(registry: AgentToolRegistry): void {
  // --- file toolset (fs class) ---------------------------------------------
  registry.register({
    name: 'read_file',
    class: 'fs',
    description: 'Read a file as UTF-8 text.',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path to the file to read.'),
    }),
    execute: async (args, tools) => {
      const path = String(args.path);
      return tools.readFileText({ path });
    },
  });

  registry.register({
    name: 'write_file',
    class: 'fs',
    description: 'Atomically write a file (tmp-then-rename), creating parent dirs.',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path to write.'),
      content: z.string().describe('File content to write.'),
    }),
    execute: async (args, tools) => {
      const path = String(args.path);
      const content = String(args.content);
      return tools.writeFileAtomic({ path, content });
    },
  });

  registry.register({
    name: 'path_exists',
    class: 'fs',
    description: 'Test whether a path exists and what kind of entry it is.',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path to test.'),
    }),
    execute: async (args, tools) => {
      const path = String(args.path);
      return tools.pathExists({ path });
    },
  });

  // --- terminal toolset (shell class) --------------------------------------
  registry.register({
    name: 'run_command',
    class: 'shell',
    description: 'Run a single executable (argv form, no shell) with cwd/timeout.',
    toolset: 'terminal',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      command: z.string().describe('Executable to run (NOT a shell string).'),
      args: z.array(z.string()).optional().describe('Arguments for the command.'),
      cwd: z.string().optional().describe('Working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (args, tools) => {
      const command = String(args.command);
      const argv = Array.isArray(args.args) ? args.args.map(String) : undefined;
      const cwd = args.cwd === undefined ? undefined : String(args.cwd);
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
      return tools.executeShell({ command, args: argv, cwd, timeoutMs });
    },
  });

  registry.register({
    name: 'run_git',
    class: 'shell',
    description: 'Run a git subcommand and capture stdout/stderr/exit-code.',
    toolset: 'terminal',
    stateless: true,
    available: binaryAvailable('git'),
    parameters: z.object({
      args: z.array(z.string()).describe("Git arguments, e.g. ['status', '--porcelain']."),
      cwd: z.string().optional().describe('Repository working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (args, tools) => {
      const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const cwd = args.cwd === undefined ? undefined : String(args.cwd);
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
      return tools.runGit({ args: gitArgs, cwd, timeoutMs });
    },
  });

  // Note: the `media` (notebook) primitives are NOT yet implemented in
  // `core/src/tools/*` (only their contracts exist in atomic.ts). That toolset is
  // intentionally empty until a later stage ships its primitives; the registry
  // already supports it (AC4) so registration is a one-liner then.

  // The richer agent-facing tool families (T1741): terminal `run_shell` (PTY +
  // spawn), paginated `read_file_paged`, atomic `write_file_atomic`, fuzzy
  // `apply_patch`, ripgrep `search_files`, and the git family
  // (status/diff/log/commit). All route through the same guarded surface.
  registerAgentToolFamilies(registry);

  // The web + browser family (T1742): `web` toolset — `web_search` (pluggable,
  // keyless backends), `web_extract` (HTML→markdown), and the Playwright-driven
  // `browser_*` tools. Playwright is an OPTIONAL, lazily-loaded dependency: the
  // browser tools register but their availability predicate hides them (with an
  // install hint) until a context advertises the playwright capability, so core
  // builds + runs with playwright NOT installed. The web tools' network egress +
  // the `browser_vision` AI call (via resolveLLMForSystem) use no raw bypass.
  registerWebAgentTools(registry);

  // The `execute_code` tool (T11946 · M7 first catalog increment): the `agent`
  // toolset's guarded code-execution capability. It routes EVERY run through the
  // existing `resolveExecutionEnv` selector (Gondolin micro-VM when present, the
  // in-process guarded `ExecutionEnv` otherwise — gondolin is an OPTIONAL dep, so
  // core builds + runs with it ABSENT). The tool is ALWAYS registered but its
  // availability predicate hides it unless the run advertises
  // `capabilities.codeExec === true` (mirrors the playwright-gated browser tools),
  // so a loop that never enables code execution cannot run arbitrary code.
  registerExecCodeAgentTool(registry);

  // The memory (BRAIN) family (T11947 · M7): `memory_search` / `memory_observe` /
  // `memory_fetch` / `memory_timeline`. Each DELEGATES to the existing BRAIN
  // memory ops (`memory/engine-compat.ts`) — no new store, no new SQL. Always
  // available daemon-OFF (a local SQLite op through the store chokepoint).
  registerMemoryAgentTools(registry);

  // The `run_skill` tool (T11949 · M7): bridges the EXISTING SKILL.md loader
  // (`skills/discovery.ts#findSkill`) + dispatch path to the loop. Surfaces only
  // invocable skills; rejects non-invocable ones. No new loader/parser. Always
  // available daemon-OFF (a local fs scan).
  registerSkillAgentTool(registry);

  // The cron/todo family (T11950 · M7): `todo_add` / `todo_list` DELEGATE to the
  // existing task store ops (`tasks/ops.ts`); `cron_schedule` is registered but
  // gated unavailable until a schedule store ships (follow-up T11962 under
  // T11679) — no schema invented here.
  registerScheduleAgentTools(registry);

  // The vision/media family (T11951 · M7): `vision_analyze` / `image_generate` /
  // `text_to_speech` — the FIRST occupants of the `media` toolset. EVERY model
  // call routes through the E9 chokepoint (resolveLLMForSystem / ModelRunner) like
  // `browser_vision` — no raw provider client (Gate-13). Hidden unless egress is
  // allowed AND the host advertises a multimodal model.
  registerMediaAgentTools(registry);

  // The native MCP client fan-IN (T11948 · M7): with NO MCP connections supplied
  // this is a no-op (core runs MCP-OFF). A host connects external MCP servers via
  // `connectMcpServer` BEFORE the registry is frozen, then fans each server's
  // remote tools in as live-only proxy tools.
  registerMcpAgentTools(registry);
}
