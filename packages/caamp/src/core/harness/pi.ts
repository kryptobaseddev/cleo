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
import { type Dirent, existsSync } from 'node:fs';
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { parseDocument, validateDocument } from '@cleocode/cant';
import type { Provider } from '../../types.js';
import type { HarnessTier } from './scope.js';
import { resolveAllTiers, resolveTierDir } from './scope.js';
import type {
  CantProfileCounts,
  CantProfileEntry,
  CantValidationDiagnostic,
  ExtensionEntry,
  Harness,
  HarnessInstallOptions,
  HarnessScope,
  ModelListEntry,
  PiModelProvider,
  PiModelsConfig,
  PromptEntry,
  SessionDocument,
  SessionSummary,
  SubagentHandle,
  SubagentResult,
  SubagentTask,
  ThemeEntry,
  ValidateCantProfileResult,
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

  // ── Wave-1 three-tier helpers ───────────────────────────────────────

  /**
   * Resolve the `models.json` path for a given legacy two-tier scope.
   *
   * @remarks
   * Lives next to `settings.json`. Global scope uses the Pi state root,
   * project scope uses the project's `.pi/` directory, matching the
   * dual-file authority model documented in ADR-035 §D3.
   */
  private modelsConfigPath(scope: HarnessScope): string {
    return scope.kind === 'global'
      ? join(getPiAgentDir(), 'models.json')
      : join(scope.projectDir, '.pi', 'models.json');
  }

  /**
   * Resolve the sessions directory — always user-tier because Pi owns
   * session storage and the three-tier model folds session listings to
   * the single authoritative location per ADR-035 §D2.
   */
  private sessionsDir(): string {
    return join(getPiAgentDir(), 'sessions');
  }

  // ── Extensions (Wave-1, T263) ───────────────────────────────────────

  /** {@inheritDoc Harness.installExtension} */
  async installExtension(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourcePath)) {
      throw new Error(`installExtension: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`installExtension: source path is not a regular file: ${sourcePath}`);
    }

    const ext = extname(sourcePath);
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.mts') {
      throw new Error(
        `installExtension: expected a TypeScript source file (.ts/.tsx/.mts), got: ${ext || '(no extension)'}`,
      );
    }

    const contents = await readFile(sourcePath, 'utf8');
    if (!/\bexport\s+default\b/.test(contents)) {
      throw new Error(
        `installExtension: source file is missing an 'export default' — Pi extensions must export a default function`,
      );
    }

    const dir = resolveTierDir({ tier, kind: 'extensions', projectDir });
    const targetPath = join(dir, `${name}.ts`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installExtension: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    await mkdir(dir, { recursive: true });
    await writeFile(targetPath, contents, 'utf8');
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.removeExtension} */
  async removeExtension(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'extensions', projectDir });
    const targetPath = join(dir, `${name}.ts`);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { force: true });
    return true;
  }

  /** {@inheritDoc Harness.listExtensions} */
  async listExtensions(projectDir?: string): Promise<ExtensionEntry[]> {
    const tiers = resolveAllTiers('extensions', projectDir);
    const out: ExtensionEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        if (!fileName.endsWith('.ts')) continue;
        const name = fileName.slice(0, -'.ts'.length);
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, fileName),
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  // ── Sessions (Wave-1, T264) ─────────────────────────────────────────

  /** {@inheritDoc Harness.listSessions} */
  async listSessions(opts?: { includeSubagents?: boolean }): Promise<SessionSummary[]> {
    const rootDir = this.sessionsDir();
    if (!existsSync(rootDir)) return [];

    const files: string[] = [];

    // Top-level `*.jsonl` files.
    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(rootDir, entry.name));
      }
    }

    // Subagents subdir (per ADR-035 §D6 session attribution convention).
    if (opts?.includeSubagents !== false) {
      const subDir = join(rootDir, 'subagents');
      if (existsSync(subDir)) {
        try {
          const subEntries = await readdir(subDir, { withFileTypes: true });
          for (const entry of subEntries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              files.push(join(subDir, entry.name));
            }
          }
        } catch {
          // Ignore — treat as empty.
        }
      }
    }

    const summaries: SessionSummary[] = [];
    for (const filePath of files) {
      const summary = await readSessionHeader(filePath);
      if (summary !== null) {
        summaries.push(summary);
      }
    }

    summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return summaries;
  }

  /** {@inheritDoc Harness.showSession} */
  async showSession(id: string): Promise<SessionDocument> {
    const summaries = await this.listSessions({ includeSubagents: true });
    const match = summaries.find((s) => s.id === id);
    if (match === undefined) {
      throw new Error(`showSession: no session found with id ${id}`);
    }

    const raw = await readFile(match.filePath, 'utf8');
    const allLines = raw.split('\n');
    // Strip trailing empty lines (JSONL files often end with a newline).
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    // First line is the header (already in `match`); drop it from entries.
    const entries = allLines.slice(1);
    return { summary: match, entries };
  }

  // ── Models (Wave-1, T265) ───────────────────────────────────────────

  /** {@inheritDoc Harness.readModelsConfig} */
  async readModelsConfig(scope: HarnessScope): Promise<PiModelsConfig> {
    const filePath = this.modelsConfigPath(scope);
    if (!existsSync(filePath)) return { providers: {} };
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return { providers: {} };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) return { providers: {} };
      const providersField = parsed['providers'];
      if (!isPlainObject(providersField)) return { providers: {} };
      const providers: Record<string, PiModelProvider> = {};
      for (const [id, block] of Object.entries(providersField)) {
        if (isPlainObject(block)) {
          providers[id] = block as PiModelProvider;
        }
      }
      return { providers };
    } catch {
      return { providers: {} };
    }
  }

  /** {@inheritDoc Harness.writeModelsConfig} */
  async writeModelsConfig(config: PiModelsConfig, scope: HarnessScope): Promise<void> {
    const filePath = this.modelsConfigPath(scope);
    await atomicWriteJson(filePath, config);
  }

  /** {@inheritDoc Harness.listModels} */
  async listModels(scope: HarnessScope): Promise<ModelListEntry[]> {
    const models = await this.readModelsConfig(scope);
    const settings = await this.readSettings(scope);
    const settingsObj = isPlainObject(settings) ? settings : {};
    const enabledRaw = settingsObj['enabledModels'];
    const enabled = Array.isArray(enabledRaw)
      ? enabledRaw.filter((v): v is string => typeof v === 'string')
      : [];
    const defaultModel =
      typeof settingsObj['defaultModel'] === 'string' ? settingsObj['defaultModel'] : null;
    const defaultProvider =
      typeof settingsObj['defaultProvider'] === 'string' ? settingsObj['defaultProvider'] : null;

    const out: ModelListEntry[] = [];
    const seen = new Set<string>();

    // 1. Emit every custom model defined in models.json.
    for (const [providerId, providerBlock] of Object.entries(models.providers)) {
      const modelDefs = providerBlock.models ?? [];
      for (const def of modelDefs) {
        const key = `${providerId}:${def.id}`;
        seen.add(key);
        const isEnabled = enabled.includes(key) || enabled.includes(`${providerId}/*`);
        const isDefault = defaultProvider === providerId && defaultModel === def.id;
        out.push({
          provider: providerId,
          id: def.id,
          name: def.name ?? null,
          enabled: isEnabled,
          isDefault,
          custom: true,
        });
      }
    }

    // 2. Emit any enabled selection that was NOT already represented by a
    //    custom definition. These resolve against Pi's built-in registry.
    for (const selection of enabled) {
      // Skip glob-only patterns (no concrete model id).
      if (!selection.includes(':') && !selection.includes('/')) continue;
      // Parse "provider:model-id" or "provider/model-id".
      const match = selection.match(/^([^:/]+)[:/]([^:/].*)$/);
      if (match === null) continue;
      const provider = match[1];
      const id = match[2];
      if (provider === undefined || id === undefined) continue;
      if (id.endsWith('*')) continue; // glob, not a concrete id
      const key = `${provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isDefault = defaultProvider === provider && defaultModel === id;
      out.push({
        provider,
        id,
        name: null,
        enabled: true,
        isDefault,
        custom: false,
      });
    }

    // 3. Surface a bare default selection even if it is not in the
    //    enabled list (Pi treats `defaultModel` as authoritative).
    if (
      defaultProvider !== null &&
      defaultModel !== null &&
      !seen.has(`${defaultProvider}:${defaultModel}`)
    ) {
      out.push({
        provider: defaultProvider,
        id: defaultModel,
        name: null,
        enabled: false,
        isDefault: true,
        custom: false,
      });
    }

    return out;
  }

  // ── Prompts (Wave-1, T266) ──────────────────────────────────────────

  /** {@inheritDoc Harness.installPrompt} */
  async installPrompt(
    sourceDir: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourceDir)) {
      throw new Error(`installPrompt: source directory does not exist: ${sourceDir}`);
    }
    const stats = await stat(sourceDir);
    if (!stats.isDirectory()) {
      throw new Error(`installPrompt: source path is not a directory: ${sourceDir}`);
    }
    if (!existsSync(join(sourceDir, 'prompt.md'))) {
      throw new Error(`installPrompt: source directory is missing a prompt.md file: ${sourceDir}`);
    }

    const baseDir = resolveTierDir({ tier, kind: 'prompts', projectDir });
    const targetPath = join(baseDir, name);

    if (existsSync(targetPath)) {
      if (opts?.force !== true) {
        throw new Error(
          `installPrompt: target already exists at ${targetPath} (pass --force to overwrite)`,
        );
      }
      await rm(targetPath, { recursive: true, force: true });
    }

    await mkdir(baseDir, { recursive: true });
    await cp(sourceDir, targetPath, { recursive: true });
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.listPrompts} */
  async listPrompts(projectDir?: string): Promise<PromptEntry[]> {
    const tiers = resolveAllTiers('prompts', projectDir);
    const out: PromptEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        // Token-efficient list: NEVER read prompt bodies — only the
        // directory name is surfaced per ADR-035 spec hook T266.
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, name),
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  /** {@inheritDoc Harness.removePrompt} */
  async removePrompt(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'prompts', projectDir });
    const targetPath = join(dir, name);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { recursive: true, force: true });
    return true;
  }

  // ── Themes (Wave-1, T267) ───────────────────────────────────────────

  /** {@inheritDoc Harness.installTheme} */
  async installTheme(
    sourceFile: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier }> {
    if (!existsSync(sourceFile)) {
      throw new Error(`installTheme: source file does not exist: ${sourceFile}`);
    }
    const stats = await stat(sourceFile);
    if (!stats.isFile()) {
      throw new Error(`installTheme: source path is not a regular file: ${sourceFile}`);
    }
    const ext = extname(sourceFile);
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.mts' && ext !== '.json') {
      throw new Error(
        `installTheme: expected a theme file (.ts/.tsx/.mts/.json), got: ${ext || '(no extension)'}`,
      );
    }

    const dir = resolveTierDir({ tier, kind: 'themes', projectDir });
    const targetPath = join(dir, `${name}${ext}`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installTheme: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    // Also block installing a .ts theme when a .json with the same stem
    // exists (and vice versa) unless force is set.
    const otherExts = ['.ts', '.tsx', '.mts', '.json'].filter((e) => e !== ext);
    for (const otherExt of otherExts) {
      const otherPath = join(dir, `${name}${otherExt}`);
      if (existsSync(otherPath) && opts?.force !== true) {
        throw new Error(
          `installTheme: conflicting theme exists at ${otherPath} (pass --force to overwrite both)`,
        );
      }
      if (existsSync(otherPath) && opts?.force === true) {
        await rm(otherPath, { force: true });
      }
    }

    await mkdir(dir, { recursive: true });
    const contents = await readFile(sourceFile);
    await writeFile(targetPath, contents);
    return { targetPath, tier };
  }

  /** {@inheritDoc Harness.listThemes} */
  async listThemes(projectDir?: string): Promise<ThemeEntry[]> {
    const tiers = resolveAllTiers('themes', projectDir);
    const out: ThemeEntry[] = [];
    const seenNames = new Set<string>();
    const validExts = new Set(['.ts', '.tsx', '.mts', '.json']);

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileExt = extname(entry.name);
        if (!validExts.has(fileExt)) continue;
        const name = entry.name.slice(0, -fileExt.length);
        const shadowed = seenNames.has(name);
        out.push({
          name,
          tier,
          path: join(dir, entry.name),
          fileExt,
          shadowed,
        });
        seenNames.add(name);
      }
    }

    return out;
  }

  /** {@inheritDoc Harness.removeTheme} */
  async removeTheme(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'themes', projectDir });
    let removed = false;
    for (const ext of ['.ts', '.tsx', '.mts', '.json']) {
      const targetPath = join(dir, `${name}${ext}`);
      if (existsSync(targetPath)) {
        await rm(targetPath, { force: true });
        removed = true;
      }
    }
    return removed;
  }

  // ── CANT profiles (Wave-1, T276) ────────────────────────────────────

  /**
   * {@inheritDoc Harness.installCantProfile}
   *
   * @remarks
   * Validates the source via {@link validateCantProfile} before copying so
   * we never persist a `.cant` file the runtime bridge cannot load. The
   * target layout is `<tier-root>/cant/<name>.cant`, resolved through
   * {@link resolveTierDir} so the project/user/global hierarchy stays
   * consistent with the other Wave-1 verbs.
   */
  async installCantProfile(
    sourcePath: string,
    name: string,
    tier: HarnessTier,
    projectDir?: string,
    opts?: HarnessInstallOptions,
  ): Promise<{ targetPath: string; tier: HarnessTier; counts: CantProfileCounts }> {
    if (!existsSync(sourcePath)) {
      throw new Error(`installCantProfile: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`installCantProfile: source path is not a regular file: ${sourcePath}`);
    }

    const ext = extname(sourcePath);
    if (ext !== '.cant') {
      throw new Error(
        `installCantProfile: expected a CANT source file (.cant), got: ${ext || '(no extension)'}`,
      );
    }

    // Hard validation gate: refuse to install a profile cant-core rejects.
    const validation = await this.validateCantProfile(sourcePath);
    if (!validation.valid) {
      const firstError =
        validation.errors.find((e) => e.severity === 'error') ?? validation.errors[0];
      const detail =
        firstError !== undefined
          ? ` (${firstError.ruleId} at ${firstError.line}:${firstError.col}: ${firstError.message})`
          : '';
      throw new Error(`installCantProfile: source file failed cant-core validation${detail}`);
    }

    const dir = resolveTierDir({ tier, kind: 'cant', projectDir });
    const targetPath = join(dir, `${name}.cant`);

    if (existsSync(targetPath) && opts?.force !== true) {
      throw new Error(
        `installCantProfile: target already exists at ${targetPath} (pass --force to overwrite)`,
      );
    }

    const contents = await readFile(sourcePath);
    await mkdir(dir, { recursive: true });
    await writeFile(targetPath, contents);
    return { targetPath, tier, counts: validation.counts };
  }

  /** {@inheritDoc Harness.removeCantProfile} */
  async removeCantProfile(name: string, tier: HarnessTier, projectDir?: string): Promise<boolean> {
    const dir = resolveTierDir({ tier, kind: 'cant', projectDir });
    const targetPath = join(dir, `${name}.cant`);
    if (!existsSync(targetPath)) return false;
    await rm(targetPath, { force: true });
    return true;
  }

  /**
   * {@inheritDoc Harness.listCantProfiles}
   *
   * @remarks
   * Walks every tier in {@link TIER_PRECEDENCE} order, parsing each
   * discovered `.cant` file via cant-core to extract a
   * {@link CantProfileCounts} bag. Higher-precedence tiers shadow
   * lower-precedence entries with the same name; shadowed entries
   * still appear in the result but carry the
   * `shadowedByHigherTier` flag so callers can render the precedence
   * story without losing visibility of the duplicate.
   */
  async listCantProfiles(projectDir?: string): Promise<CantProfileEntry[]> {
    const tiers = resolveAllTiers('cant', projectDir);
    const out: CantProfileEntry[] = [];
    const seenNames = new Set<string>();

    for (const { tier, dir } of tiers) {
      if (!existsSync(dir)) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fileName = entry.name;
        if (!fileName.endsWith('.cant')) continue;
        const name = fileName.slice(0, -'.cant'.length);
        const sourcePath = join(dir, fileName);
        const counts = await extractCantCounts(sourcePath);
        const shadowed = seenNames.has(name);
        const profile: CantProfileEntry = {
          name,
          tier,
          sourcePath,
          counts,
        };
        if (shadowed) {
          profile.shadowedByHigherTier = true;
        }
        out.push(profile);
        seenNames.add(name);
      }
    }

    return out;
  }

  /**
   * {@inheritDoc Harness.validateCantProfile}
   *
   * @remarks
   * Pure validator. Reads the file, runs `parseDocument` to derive
   * counts (when parsing succeeds) and `validateDocument` to collect
   * the 42-rule diagnostic feed. The two calls are kept independent so
   * we can still report counts for files that pass parsing but fail a
   * lint rule.
   */
  async validateCantProfile(sourcePath: string): Promise<ValidateCantProfileResult> {
    if (!existsSync(sourcePath)) {
      throw new Error(`validateCantProfile: source file does not exist: ${sourcePath}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      throw new Error(`validateCantProfile: source path is not a regular file: ${sourcePath}`);
    }

    const counts = await extractCantCounts(sourcePath);
    const validation = await validateDocument(sourcePath);
    const errors: CantValidationDiagnostic[] = validation.diagnostics.map((d) => ({
      ruleId: d.ruleId,
      message: d.message,
      line: d.line,
      col: d.col,
      severity: normaliseSeverity(d.severity),
    }));

    return {
      valid: validation.valid,
      errors,
      counts,
    };
  }
}

// ── Private session-header helper ──────────────────────────────────────

/**
 * Read only the first line of a Pi session JSONL file and extract the
 * header summary.
 *
 * @remarks
 * Implements the ADR-035 §D2 rule that session listings MUST NOT read
 * past line 1. Uses a buffered file handle so we never pull more than
 * the first chunk off disk. Returns `null` when the file is empty,
 * unreadable, or its header is malformed — callers skip null entries.
 */
async function readSessionHeader(filePath: string): Promise<SessionSummary | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    const capacity = Math.min(stats.size, 64 * 1024);
    if (capacity === 0) return null;
    const buffer = Buffer.alloc(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIdx = text.indexOf('\n');
    const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
    if (firstLine.trim().length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : null;
    if (id === null) {
      // Fall back to file stem if the header has no id — preserves the
      // file in the listing rather than dropping it silently.
      const stem = basename(filePath, '.jsonl');
      return {
        id: stem,
        version: typeof parsed['version'] === 'number' ? parsed['version'] : 0,
        timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : null,
        cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : null,
        parentSession: typeof parsed['parentSession'] === 'string' ? parsed['parentSession'] : null,
        filePath,
        mtimeMs: stats.mtimeMs,
      };
    }

    return {
      id,
      version: typeof parsed['version'] === 'number' ? parsed['version'] : 0,
      timestamp: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : null,
      cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : null,
      parentSession: typeof parsed['parentSession'] === 'string' ? parsed['parentSession'] : null,
      filePath,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => {
        // Ignore close errors — we're already returning.
      });
    }
  }
}

// ── Private CANT helpers (T276) ────────────────────────────────────────

/** Empty count bag returned when parsing fails. */
const EMPTY_CANT_COUNTS: CantProfileCounts = {
  agentCount: 0,
  workflowCount: 0,
  pipelineCount: 0,
  hookCount: 0,
  skillCount: 0,
};

/**
 * Narrow a value to a record so we can safely walk the cant-core AST.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Extract a string value from a cant-core spanned-name node.
 *
 * @remarks
 * Cant-core wraps identifiers/property keys in a `{ span, value }`
 * envelope. This helper unwraps the envelope or accepts a raw string,
 * returning `null` for anything else.
 */
function unwrapSpanned(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['value'] === 'string') {
    return value['value'];
  }
  return null;
}

/**
 * Drill into a cant-core property `value` union and pull out the
 * declared skill names from a `skills:` array.
 *
 * @remarks
 * The cant-core AST encodes property values as discriminated objects
 * like `{ Array: [{ String: { raw: "ct-cleo" } }, ...] }` or
 * `{ Identifier: "name" }`. This helper walks just the shape used by
 * `skills: ["ct-cleo", "ct-task-executor"]` and pushes every string
 * literal into `out`. It is intentionally tolerant: anything that does
 * not match the expected shape is ignored rather than thrown.
 */
function collectSkillNames(value: unknown, out: Set<string>): void {
  if (!isRecord(value)) return;
  const arr = value['Array'];
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const stringWrapper = item['String'];
    if (isRecord(stringWrapper) && typeof stringWrapper['raw'] === 'string') {
      out.add(stringWrapper['raw']);
      continue;
    }
    const identWrapper = item['Identifier'];
    if (typeof identWrapper === 'string') {
      out.add(identWrapper);
    }
  }
}

/**
 * Parse a `.cant` file and return its top-level section counts.
 *
 * @remarks
 * Used by both {@link PiHarness.listCantProfiles} and
 * {@link PiHarness.validateCantProfile}. Walks
 * `document.sections` (a tagged-union array where each element is a
 * single-key object such as `{ Agent: ... }`, `{ Workflow: ... }`,
 * `{ Pipeline: ... }`, `{ Hook: ... }`, `{ Comment: ... }`) and tallies
 * each section type. Hook bodies nested inside an Agent section's
 * `hooks` array are added to {@link CantProfileCounts.hookCount}, and
 * skill names referenced via the agent's `skills:` property are
 * de-duplicated into {@link CantProfileCounts.skillCount}.
 *
 * Returns the empty count bag when parsing fails — callers can still
 * surface the file in a list, just without per-section detail.
 */
async function extractCantCounts(sourcePath: string): Promise<CantProfileCounts> {
  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    parsed = await parseDocument(sourcePath);
  } catch {
    return { ...EMPTY_CANT_COUNTS };
  }
  if (!parsed.success || !isRecord(parsed.document)) {
    return { ...EMPTY_CANT_COUNTS };
  }
  const sections = parsed.document['sections'];
  if (!Array.isArray(sections)) {
    return { ...EMPTY_CANT_COUNTS };
  }

  let agentCount = 0;
  let workflowCount = 0;
  let pipelineCount = 0;
  let hookCount = 0;
  const skillNames = new Set<string>();

  for (const section of sections) {
    if (!isRecord(section)) continue;
    if (isRecord(section['Agent'])) {
      agentCount += 1;
      const agent = section['Agent'];
      const hooks = agent['hooks'];
      if (Array.isArray(hooks)) {
        hookCount += hooks.length;
      }
      const properties = agent['properties'];
      if (Array.isArray(properties)) {
        for (const prop of properties) {
          if (!isRecord(prop)) continue;
          const key = unwrapSpanned(prop['key']);
          if (key === 'skills') {
            collectSkillNames(prop['value'], skillNames);
          }
        }
      }
      continue;
    }
    if (isRecord(section['Workflow'])) {
      workflowCount += 1;
      continue;
    }
    if (isRecord(section['Pipeline'])) {
      pipelineCount += 1;
      continue;
    }
    if (isRecord(section['Hook'])) {
      hookCount += 1;
    }
  }

  return {
    agentCount,
    workflowCount,
    pipelineCount,
    hookCount,
    skillCount: skillNames.size,
  };
}

/**
 * Normalise a cant-core severity string into the harness layer's typed
 * union.
 *
 * @remarks
 * Cant-core's native binding returns severity as a free-form string;
 * the harness contract types it as a closed union so downstream
 * envelope builders can safely render it. Unknown severities collapse
 * to `'error'` to fail closed.
 */
function normaliseSeverity(raw: string): 'error' | 'warning' | 'info' | 'hint' {
  if (raw === 'warning' || raw === 'info' || raw === 'hint') return raw;
  return 'error';
}
