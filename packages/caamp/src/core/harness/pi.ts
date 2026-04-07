/**
 * Pi coding agent harness.
 *
 * @remarks
 * Concrete {@link Harness} implementation for the Pi coding agent
 * (https://github.com/badlogic/pi-mono). Pi is CAAMP's first first-class
 * primary harness: it owns skills, instructions, extensions, and subagent
 * spawning through native filesystem conventions rather than a generic
 * MCP config file.
 *
 * Filesystem layout honoured by this harness:
 * - Global state root: `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent/`.
 * - Global skills: `<root>/skills/<name>/`
 * - Global extensions: `<root>/extensions/*.ts`
 * - Global settings: `<root>/settings.json`
 * - Global instructions: `<root>/AGENTS.md`
 * - Project skills: `<projectDir>/.pi/skills/<name>/`
 * - Project extensions: `<projectDir>/.pi/extensions/*.ts`
 * - Project settings: `<projectDir>/.pi/settings.json`
 * - Project instructions: `<projectDir>/AGENTS.md` (at project root, NOT under `.pi/`)
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Provider } from '../../types.js';
import type {
  Harness,
  HarnessScope,
  McpServerSpec,
  SubagentHandle,
  SubagentResult,
  SubagentTask,
} from './types.js';

// ── Marker constants ──────────────────────────────────────────────────

/** Start marker for CAAMP-managed AGENTS.md injection blocks. */
const MARKER_START = '<!-- CAAMP:START -->';
/** End marker for CAAMP-managed AGENTS.md injection blocks. */
const MARKER_END = '<!-- CAAMP:END -->';
/** Matches an entire CAAMP-managed block including its markers. */
const MARKER_PATTERN = /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/;

// ── Private helpers ───────────────────────────────────────────────────

/**
 * Resolve the Pi global state root directory.
 *
 * @remarks
 * Honours the `PI_CODING_AGENT_DIR` environment variable when set (with
 * `~` expansion), else falls back to `~/.pi/agent`. Kept private to this
 * module so tests can redirect it via the env var.
 */
function getPiAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  if (env !== undefined && env.length > 0) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  return join(homedir(), '.pi', 'agent');
}

/**
 * Narrow a value to a plain object suitable for deep merge.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `patch` into `target`, returning a new object.
 *
 * @remarks
 * Nested plain objects are merged field-by-field. All other value types
 * (arrays, primitives, `null`) are replaced wholesale by the patch value.
 */
function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Write JSON to disk atomically via a tmp-then-rename sequence.
 *
 * @remarks
 * Ensures partial writes cannot leave a corrupted `settings.json` behind
 * if the process dies mid-write. The tmp filename is namespaced by pid
 * to stay unique under parallel runs.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

// ── PiHarness ─────────────────────────────────────────────────────────

/**
 * Pi coding agent harness — CAAMP's first-class primary harness.
 *
 * @remarks
 * Implements the full {@link Harness} contract using Pi's filesystem
 * conventions. All mutating operations are idempotent: re-installing a
 * skill overwrites it cleanly, injecting instructions twice replaces the
 * marker block rather than appending, and removing absent assets is a
 * no-op.
 *
 * @see {@link https://github.com/badlogic/pi-mono | pi-mono}
 *
 * @public
 */
export class PiHarness implements Harness {
  /** Provider id, always `"pi"`. */
  readonly id = 'pi';

  /**
   * Construct a harness bound to a resolved Pi provider.
   *
   * @param provider - The resolved provider entry for `"pi"`.
   */
  constructor(readonly provider: Provider) {}

  // ── Path helpers ────────────────────────────────────────────────────

  /**
   * Resolve the skills directory for a given scope.
   */
  private skillsDir(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'skills')
      : join(scope.projectDir, '.pi', 'skills');
  }

  /**
   * Resolve the extensions directory for a given scope.
   */
  private extensionsDir(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'extensions')
      : join(scope.projectDir, '.pi', 'extensions');
  }

  /**
   * Resolve the settings.json path for a given scope.
   */
  private settingsPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'settings.json')
      : join(scope.projectDir, '.pi', 'settings.json');
  }

  /**
   * Resolve the AGENTS.md instruction file path for a given scope.
   *
   * @remarks
   * Global scope lives under the Pi state root; project scope lives at
   * the project root (NOT under `.pi/`), matching Pi's convention of
   * auto-discovering `AGENTS.md` from the working directory upwards.
   */
  private agentsMdPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'AGENTS.md')
      : join(scope.projectDir, 'AGENTS.md');
  }

  // ── Skills ──────────────────────────────────────────────────────────

  /** {@inheritDoc Harness.installSkill} */
  async installSkill(sourcePath: string, skillName: string, scope: HarnessScope): Promise<void> {
    const targetDir = join(this.skillsDir(scope), skillName);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(dirname(targetDir), { recursive: true });
    await cp(sourcePath, targetDir, { recursive: true });
  }

  /** {@inheritDoc Harness.removeSkill} */
  async removeSkill(skillName: string, scope: HarnessScope): Promise<void> {
    const targetDir = join(this.skillsDir(scope), skillName);
    await rm(targetDir, { recursive: true, force: true });
  }

  /** {@inheritDoc Harness.listSkills} */
  async listSkills(scope: HarnessScope): Promise<string[]> {
    const dir = this.skillsDir(scope);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // ── Instructions ────────────────────────────────────────────────────

  /** {@inheritDoc Harness.injectInstructions} */
  async injectInstructions(content: string, scope: HarnessScope): Promise<void> {
    const filePath = this.agentsMdPath(scope);
    await mkdir(dirname(filePath), { recursive: true });

    const block = `${MARKER_START}\n${content.trim()}\n${MARKER_END}`;

    let existing = '';
    if (existsSync(filePath)) {
      existing = await readFile(filePath, 'utf8');
    }

    let updated: string;
    if (MARKER_PATTERN.test(existing)) {
      updated = existing.replace(MARKER_PATTERN, block);
    } else if (existing.length === 0) {
      updated = `${block}\n`;
    } else {
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      updated = `${existing}${separator}${block}\n`;
    }
    await writeFile(filePath, updated, 'utf8');
  }

  /** {@inheritDoc Harness.removeInstructions} */
  async removeInstructions(scope: HarnessScope): Promise<void> {
    const filePath = this.agentsMdPath(scope);
    if (!existsSync(filePath)) return;
    const existing = await readFile(filePath, 'utf8');
    if (!MARKER_PATTERN.test(existing)) return;
    const stripped = existing
      .replace(MARKER_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    await writeFile(filePath, stripped.length === 0 ? '' : `${stripped}\n`, 'utf8');
  }

  // ── MCP-as-extension scaffold ───────────────────────────────────────

  /**
   * {@inheritDoc Harness.installMcpAsExtension}
   *
   * @remarks
   * Emits a SCAFFOLD Pi extension file under `extensions/mcp-<name>.ts`.
   * The scaffold registers a Pi tool whose `execute` function currently
   * returns an "isError" payload explaining that the MCP bridge runtime
   * is not yet implemented. This preserves the public lifecycle surface
   * (install/list/remove) so orchestration code can treat the bridge as
   * a first-class asset while the concrete JSON-RPC runtime is built out
   * in a later wave.
   */
  async installMcpAsExtension(server: McpServerSpec, scope: HarnessScope): Promise<void> {
    const dir = this.extensionsDir(scope);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `mcp-${server.name}.ts`);

    const launchConfig = JSON.stringify(
      {
        command: server.command,
        args: server.args ?? [],
        url: server.url,
        env: server.env ?? {},
        headers: server.headers ?? {},
      },
      null,
      2,
    );

    const src = `// AUTO-GENERATED by @cleocode/caamp — do not edit.
// MCP-as-Pi-extension bridge scaffold for "${server.name}".
// TODO: implement the MCP JSON-RPC bridge. Current behavior is a stub
// that logs every tool invocation. The scaffold exists so that CAAMP
// can manage the extension lifecycle (install/remove/list) without
// blocking on a full MCP runtime bridge.

const CONFIG = ${launchConfig};

export default (pi: unknown) => {
  const api = pi as {
    registerTool: (def: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (...args: unknown[]) => Promise<{ type: 'text'; text: string; isError?: boolean }>;
    }) => void;
  };

  api.registerTool({
    name: ${JSON.stringify(`mcp_${server.name}`)},
    label: ${JSON.stringify(`MCP: ${server.name}`)},
    description: ${JSON.stringify(
      `MCP server "${server.name}" — bridge scaffold, not yet implemented.`,
    )},
    parameters: { type: 'object', properties: {} },
    execute: async () => ({
      type: 'text',
      text: \`MCP bridge for "${server.name}" is a scaffold. Config: \${JSON.stringify(CONFIG)}\`,
      isError: true,
    }),
  });
};
`;
    await writeFile(filePath, src, 'utf8');
  }

  // ── Subagent spawn ──────────────────────────────────────────────────

  /**
   * {@inheritDoc Harness.spawnSubagent}
   *
   * @remarks
   * Invokes Pi's configured `spawnCommand` (e.g.
   * `["pi", "--mode", "json", "-p", "--no-session"]`) with the task prompt
   * appended as the trailing positional argument. The {@link SubagentTask.targetProviderId}
   * is a routing hint carried in the prompt stream; Pi's own extension
   * layer dispatches to the correct inner agent.
   *
   * Throws immediately when the provider entry is missing a `spawnCommand`
   * so callers see configuration errors early rather than at child-exit time.
   */
  async spawnSubagent(task: SubagentTask): Promise<SubagentHandle> {
    const cmd = this.provider.capabilities.spawn.spawnCommand;
    if (cmd === null || cmd.length === 0) {
      throw new Error(
        'PiHarness.spawnSubagent: provider has no spawn.spawnCommand in capabilities',
      );
    }

    const program = cmd[0];
    if (typeof program !== 'string' || program.length === 0) {
      throw new Error('PiHarness.spawnSubagent: invalid spawnCommand (missing program)');
    }
    const baseArgs = cmd.slice(1);
    const args = [...baseArgs, task.prompt];

    const child = spawn(program, args, {
      cwd: task.cwd,
      env: { ...process.env, ...task.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const result: Promise<SubagentResult> = new Promise((resolve) => {
      child.on('close', (exitCode) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // Non-JSON stdout is fine — leave `parsed` undefined.
        }
        resolve({ exitCode, stdout, stderr, parsed });
      });
    });

    if (task.signal !== undefined) {
      task.signal.addEventListener('abort', () => {
        child.kill();
      });
    }

    return {
      pid: child.pid ?? null,
      result,
      abort: () => {
        child.kill();
      },
    };
  }

  // ── Settings ────────────────────────────────────────────────────────

  /** {@inheritDoc Harness.readSettings} */
  async readSettings(scope: HarnessScope): Promise<unknown> {
    const filePath = this.settingsPath(scope);
    if (!existsSync(filePath)) return {};
    const raw = await readFile(filePath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** {@inheritDoc Harness.writeSettings} */
  async writeSettings(patch: Record<string, unknown>, scope: HarnessScope): Promise<void> {
    const filePath = this.settingsPath(scope);
    const current = await this.readSettings(scope);
    const currentObj = isPlainObject(current) ? current : {};
    const merged = deepMerge(currentObj, patch);
    await atomicWriteJson(filePath, merged);
  }

  /** {@inheritDoc Harness.configureModels} */
  async configureModels(modelPatterns: string[], scope: HarnessScope): Promise<void> {
    await this.writeSettings({ enabledModels: modelPatterns }, scope);
  }
}
