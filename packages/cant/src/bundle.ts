/**
 * Compiled bundle API for `.cant` files.
 *
 * @remarks
 * Provides {@link compileBundle} which takes a list of `.cant` file paths,
 * parses and validates each one via the existing cant-napi bridge, then
 * collects the results into a single {@link CompiledBundle}. The bundle
 * exposes extracted agents, teams, tools, and diagnostics, plus a
 * {@link CompiledBundle.renderSystemPrompt | renderSystemPrompt()} method
 * that produces a markdown-formatted system prompt addendum suitable for
 * appending to a Pi system prompt.
 *
 * @example
 * ```typescript
 * import { compileBundle } from '@cleocode/cant';
 *
 * const bundle = await compileBundle(['.cleo/cant/my-agent.cant']);
 * if (bundle.valid) {
 *   const prompt = bundle.renderSystemPrompt();
 *   console.log(prompt);
 * }
 * ```
 */

import type { CantDocumentResult, CantValidationResult } from './document.js';
import { parseDocument, validateDocument } from './document.js';
import type {
  CantAgentV3,
  CantContextSourceDef,
  CantContractBlock,
  CantContractClause,
  CantMentalModelRef,
  CantOverflowStrategy,
  CantTier,
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single parsed `.cant` document with its source path and diagnostics.
 *
 * @remarks
 * The `document` field holds the raw AST as returned by
 * {@link parseDocument}. Callers that need typed access should narrow the
 * shape per the cant-core grammar (sections keyed by `Agent`, `Workflow`,
 * `Pipeline`, etc.).
 */
export interface ParsedCantDocument {
  /** Absolute path to the source `.cant` file. */
  sourcePath: string;
  /** The document kind from frontmatter (`"Agent"`, `"Workflow"`, etc.), or `null`. */
  kind: string | null;
  /** The raw AST from `parseDocument`. `null` when parsing failed. */
  document: CantDocumentResult['document'];
  /** Validation diagnostics for this document. */
  diagnostics: BundleDiagnostic[];
}

/**
 * A normalized diagnostic combining parse errors and validation diagnostics.
 *
 * @remarks
 * Position fields (`line`, `col`) are propagated from the native cant-core
 * binding for both parse errors and validation diagnostics. They are optional
 * because some diagnostics (e.g., file-level read failures) do not have a
 * source position. Line and column are 1-based.
 */
export interface BundleDiagnostic {
  /** The rule ID (e.g., `"S01"`, `"parse"`). */
  ruleId: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** Severity: `"error"`, `"warning"`, `"info"`, or `"hint"`. */
  severity: string;
  /** Source file path. */
  sourcePath: string;
  /** Line number (1-based) where the diagnostic occurred, or `undefined` if unavailable. */
  line?: number;
  /** Column number (1-based) where the diagnostic occurred, or `undefined` if unavailable. */
  col?: number;
}

/**
 * An agent declaration extracted from a compiled `.cant` file.
 *
 * @remarks
 * Properties are stored as a flat `Record` with string keys. Values are
 * simplified from the raw AST value wrapper (e.g., `{ Identifier: "worker" }`
 * becomes `"worker"`).
 */
export interface AgentEntry {
  /** The agent name as declared in the `.cant` file. */
  name: string;
  /** Absolute path to the source `.cant` file. */
  sourcePath: string;
  /** Simplified agent properties (role, tier, prompt, skills, etc.). */
  properties: Record<string, unknown>;
}

/**
 * Agent entry extended with a fully-typed {@link CantAgentV3} projection.
 *
 * @remarks
 * T889 Wave 1 (W1-2) surface. `typed` is `null` when the entry could not be
 * mapped to the v3 shape (for example, the AST kind is not `agent` or required
 * fields are missing). When `typed` is present, the entry satisfies the
 * {@link isCantAgentV3} structural guard and carries v1/v2-backward-compatible
 * defaults (`tier: 'mid'`, `contextSources: []`, etc.) merged on top of any
 * values discovered in the `.cant` source.
 */
export interface TypedAgentEntry extends AgentEntry {
  /** Typed v3 projection of this agent entry, or `null` when mapping failed. */
  typed: CantAgentV3 | null;
}

/**
 * A team declaration extracted from a compiled `.cant` file.
 *
 * @remarks
 * The current cant-core parser does not support `team` as a top-level
 * section. This interface exists for forward-compatibility; the bundle
 * will populate it once the grammar is extended.
 */
export interface TeamEntry {
  /** The team name as declared in the `.cant` file. */
  name: string;
  /** Absolute path to the source `.cant` file. */
  sourcePath: string;
  /** Simplified team properties. */
  properties: Record<string, unknown>;
}

/**
 * A tool declaration extracted from a compiled `.cant` file.
 *
 * @remarks
 * The current cant-core parser does not support `tool` as a top-level
 * section. This interface exists for forward-compatibility; the bundle
 * will populate it once the grammar is extended.
 */
export interface ToolEntry {
  /** The tool name as declared in the `.cant` file. */
  name: string;
  /** Absolute path to the source `.cant` file. */
  sourcePath: string;
  /** Simplified tool properties. */
  properties: Record<string, unknown>;
}

/**
 * The result of compiling one or more `.cant` files into a unified bundle.
 *
 * @remarks
 * Contains all successfully parsed documents, extracted entity entries
 * (agents, teams, tools), cross-file diagnostics, and a
 * {@link renderSystemPrompt} helper for Pi system prompt injection.
 */
export interface CompiledBundle {
  /** All successfully parsed documents, keyed by source path. */
  documents: Map<string, ParsedCantDocument>;
  /**
   * Agents found across all documents.
   *
   * @remarks
   * Each entry includes a `typed: CantAgentV3 | null` field that carries
   * the fully-typed v3 projection (populated via {@link toCantAgentV3}).
   * Older consumers that only read `name`, `sourcePath`, and `properties`
   * remain source-compatible because {@link TypedAgentEntry} extends
   * {@link AgentEntry}.
   */
  agents: TypedAgentEntry[];
  /** Teams found across all documents. */
  teams: TeamEntry[];
  /** Tools found across all documents. */
  tools: ToolEntry[];
  /** Validation diagnostics across all documents. */
  diagnostics: BundleDiagnostic[];
  /** Whether all documents parsed and validated without errors. */
  valid: boolean;
  /** Render the compiled bundle as a system prompt addendum. */
  renderSystemPrompt(): string;
}

// ---------------------------------------------------------------------------
// Internal AST helpers
// ---------------------------------------------------------------------------

/**
 * The raw AST property shape from cant-core. Each property has a `key`
 * with `{ value: string }` and a typed `value` wrapper.
 */
interface RawAstProperty {
  key: { value: string };
  value: Record<string, unknown>;
}

/** Agent section shape inside the cant-core AST. */
interface RawAgentSection {
  name: { value: string };
  properties: RawAstProperty[];
  permissions?: Array<{ domain: string; access: string[] }>;
  hooks?: unknown[];
}

/**
 * Simplify a cant-core AST value wrapper to a plain JS value.
 *
 * @remarks
 * The AST wraps values like `{ Identifier: "worker" }`,
 * `{ String: { raw: "..." } }`, `{ Number: 2 }`, `{ Boolean: true }`,
 * `{ Array: [...] }`, `{ ProseBlock: { lines: [...] } }`. This function
 * extracts the inner payload for human-readable property maps.
 */
function simplifyValue(wrapper: Record<string, unknown>): unknown {
  if ('Identifier' in wrapper) return wrapper['Identifier'];
  if ('String' in wrapper) {
    const inner = wrapper['String'];
    if (typeof inner === 'object' && inner !== null && 'raw' in inner) {
      return (inner as { raw: string }).raw;
    }
    return inner;
  }
  if ('Number' in wrapper) return wrapper['Number'];
  if ('Boolean' in wrapper) return wrapper['Boolean'];
  if ('ProseBlock' in wrapper) {
    const block = wrapper['ProseBlock'];
    if (typeof block === 'object' && block !== null && 'lines' in block) {
      return (block as { lines: string[] }).lines.join('\n');
    }
    return block;
  }
  if ('Array' in wrapper) {
    const arr = wrapper['Array'];
    if (Array.isArray(arr)) {
      return arr.map((item: Record<string, unknown>) => simplifyValue(item));
    }
    return arr;
  }
  // Fallback: return the wrapper as-is for unknown shapes
  return wrapper;
}

/**
 * Extract a flat properties map from raw AST properties.
 *
 * @param rawProps - The raw AST property array from a section.
 * @returns A simplified `Record<string, unknown>` map.
 */
function extractProperties(rawProps: RawAstProperty[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of rawProps) {
    const key = prop.key?.value;
    if (typeof key !== 'string') continue;
    result[key] = simplifyValue(prop.value);
  }
  return result;
}

/**
 * Extract agents from a parsed document AST.
 *
 * @param doc - The raw AST document object from `parseDocument`.
 * @param sourcePath - The source file path for attribution.
 * @returns An array of {@link AgentEntry} extracted from `Agent` sections.
 */
function extractAgents(doc: unknown, sourcePath: string): AgentEntry[] {
  if (typeof doc !== 'object' || doc === null) return [];
  const docObj = doc as Record<string, unknown>;
  const sections = docObj['sections'];
  if (!Array.isArray(sections)) return [];

  const agents: AgentEntry[] = [];
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue;
    const wrapper = section as Record<string, unknown>;
    const agentData = wrapper['Agent'] as RawAgentSection | undefined;
    if (!agentData) continue;

    const nameValue = agentData.name?.value;
    if (typeof nameValue !== 'string') continue;

    const properties = extractProperties(agentData.properties ?? []);

    // Include permissions as a property for visibility
    if (Array.isArray(agentData.permissions) && agentData.permissions.length > 0) {
      const permMap: Record<string, string[]> = {};
      for (const perm of agentData.permissions) {
        if (typeof perm.domain === 'string' && Array.isArray(perm.access)) {
          permMap[perm.domain] = perm.access;
        }
      }
      properties['permissions'] = permMap;
    }

    agents.push({ name: nameValue, sourcePath, properties });
  }
  return agents;
}

/** Valid {@link CantTier} string values. */
const VALID_TIERS: readonly CantTier[] = ['low', 'mid', 'high'];

/** Valid {@link CantOverflowStrategy} string values. */
const VALID_OVERFLOW: readonly CantOverflowStrategy[] = ['escalate_tier', 'fail'];

/**
 * Coerce a simplified AST value to a plain string, or `undefined` if the value
 * cannot be safely represented as one. Accepts raw strings, numbers, and the
 * stringified form of booleans; other shapes (objects, arrays) return
 * `undefined`.
 */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Coerce a simplified AST value to an array of strings. Returns an empty array
 * for non-array inputs. Array members are coerced via {@link coerceString} and
 * dropped if they cannot be represented as strings.
 */
function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = coerceString(item);
    if (typeof s === 'string') out.push(s);
  }
  return out;
}

/**
 * Map the raw `permissions` property (either a domain-access record or the
 * tool-permissions scalar map) to the flat `Record<string, string>` required
 * by {@link CantAgentV3}. Array access lists are joined with `, ` so downstream
 * consumers keep the v1/v2 "tasks: read, write" wire format.
 */
function extractV3Permissions(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return result;
  const rec = value as Record<string, unknown>;
  for (const [domain, access] of Object.entries(rec)) {
    if (Array.isArray(access)) {
      const parts = coerceStringArray(access);
      if (parts.length > 0) result[domain] = parts.join(', ');
    } else {
      const s = coerceString(access);
      if (typeof s === 'string') result[domain] = s;
    }
  }
  return result;
}

/**
 * Map the raw `contracts` property to a {@link CantContractBlock}.
 *
 * @remarks
 * The Wave 0 grammar does not yet recognize `contracts:` blocks, so today
 * this helper returns `null` unless the property is already shaped as
 * `{ requires: string[], ensures: string[] }`. When the grammar adds the
 * block, this helper will round-trip the richer shape without breaking
 * existing callers.
 */
function extractContracts(value: unknown): CantContractBlock {
  const empty: CantContractBlock = { requires: [], ensures: [] };
  if (typeof value !== 'object' || value === null) return empty;
  const rec = value as Record<string, unknown>;
  const toClauses = (raw: unknown): CantContractClause[] => {
    if (!Array.isArray(raw)) return [];
    const out: CantContractClause[] = [];
    for (const item of raw) {
      const text = coerceString(item);
      if (typeof text === 'string' && text.length > 0) out.push({ text });
    }
    return out;
  };
  return {
    requires: toClauses(rec['requires']),
    ensures: toClauses(rec['ensures']),
  };
}

/**
 * Map the raw `context_sources` property value to an array of
 * {@link CantContextSourceDef}. Supports the list form
 * `[{source, query, max_entries}]` today; dict form (`patterns: {...}`) is
 * flattened by the Wave 0 parser into sibling properties and therefore
 * requires a follow-up grammar pass to reconstruct. Returns an empty array
 * when the value is absent, malformed, or dict-flattened.
 */
function extractContextSources(value: unknown): CantContextSourceDef[] {
  if (!Array.isArray(value)) return [];
  const out: CantContextSourceDef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const source = coerceString(rec['source']);
    const query = coerceString(rec['query']);
    const maxRaw = rec['maxEntries'] ?? rec['max_entries'] ?? rec['max'];
    const maxEntries =
      typeof maxRaw === 'number'
        ? maxRaw
        : typeof maxRaw === 'string'
          ? Number.parseInt(maxRaw, 10)
          : Number.NaN;
    if (
      typeof source === 'string' &&
      typeof query === 'string' &&
      Number.isFinite(maxEntries) &&
      maxEntries > 0
    ) {
      out.push({ source, query, maxEntries });
    }
  }
  return out;
}

/**
 * Project an {@link AgentEntry} into the fully-typed {@link CantAgentV3}
 * surface, filling v1/v2-backward-compatible defaults for fields the source
 * `.cant` file omits.
 *
 * @remarks
 * Defaults applied when the source file does not declare them:
 *
 * - `tier`: `'mid'`
 * - `contextSources`: `[]`
 * - `onOverflow`: `'escalate_tier'`
 * - `mentalModelRef`: `null`
 * - `contracts`: `{ requires: [], ensures: [] }`
 *
 * Returns `null` when `entry.name` is empty (the AST kind wasn't `agent` or
 * the name field was missing), so callers can distinguish "mapped" from
 * "not an agent".
 *
 * @param entry - The {@link AgentEntry} extracted by {@link compileBundle}.
 * @param sourcePath - Absolute path to the source `.cant` file (used to
 *   populate {@link CantAgentV3.sourcePath}).
 * @returns A {@link CantAgentV3} projection, or `null` when mapping fails.
 */
export function toCantAgentV3(entry: AgentEntry, sourcePath: string): CantAgentV3 | null {
  if (typeof entry.name !== 'string' || entry.name.length === 0) return null;
  const props = entry.properties;

  const tierRaw = coerceString(props['tier']);
  const tier: CantTier =
    tierRaw !== undefined && (VALID_TIERS as readonly string[]).includes(tierRaw)
      ? (tierRaw as CantTier)
      : 'mid';

  const overflowRaw = coerceString(props['on_overflow'] ?? props['onOverflow']);
  const onOverflow: CantOverflowStrategy =
    overflowRaw !== undefined && (VALID_OVERFLOW as readonly string[]).includes(overflowRaw)
      ? (overflowRaw as CantOverflowStrategy)
      : 'escalate_tier';

  const mentalModelRef: CantMentalModelRef | null = null;

  const version = coerceString(props['version']) ?? '1';
  const role = coerceString(props['role']) ?? '';
  const description = coerceString(props['description']) ?? '';
  const prompt = coerceString(props['prompt']) ?? '';
  const skills = coerceStringArray(props['skills']);
  const permissions = extractV3Permissions(props['permissions']);
  const contextSources = extractContextSources(props['context_sources'] ?? props['contextSources']);
  const contracts = extractContracts(props['contracts']);

  const model = coerceString(props['model']);
  const persistRaw = props['persist'];
  const persist: boolean | string | undefined =
    typeof persistRaw === 'boolean'
      ? persistRaw
      : typeof persistRaw === 'string'
        ? persistRaw
        : undefined;
  const parent = coerceString(props['parent']);
  const consultWhen = coerceString(props['consult-when'] ?? props['consultWhen']);
  const workers = coerceStringArray(props['workers']);
  const stages = coerceStringArray(props['stages']);
  const deprecatedRaw = props['deprecated'];
  const deprecated = typeof deprecatedRaw === 'boolean' ? deprecatedRaw : undefined;
  const supersededBy = coerceString(props['superseded_by'] ?? props['supersededBy']);

  const typed: CantAgentV3 = {
    name: entry.name,
    sourcePath,
    version,
    role,
    description,
    prompt,
    skills,
    permissions,
    tier,
    contextSources,
    onOverflow,
    mentalModelRef,
    contracts,
  };

  if (model !== undefined) typed.model = model;
  if (persist !== undefined) typed.persist = persist;
  if (parent !== undefined) typed.parent = parent;
  if (consultWhen !== undefined) typed.consultWhen = consultWhen;
  if (workers.length > 0) typed.workers = workers;
  if (stages.length > 0) typed.stages = stages;
  if (deprecated !== undefined) typed.deprecated = deprecated;
  if (supersededBy !== undefined) typed.supersededBy = supersededBy;

  return typed;
}

/**
 * Detect placeholder `TODO` stubs in an agent's behavioral fields.
 *
 * @remarks
 * T889 Wave 1 (W1-4) linter. Emits one {@link BundleDiagnostic} per offending
 * field at severity `'error'` with `ruleId: 'S-TODO-001'`. An agent cannot be
 * spawned while any of its `prompt`, `tone`, or `enforcement` values contain
 * the literal substring `TODO` because the composer would forward placeholder
 * content to the live model. The enclosing `valid` flag on
 * {@link CompiledBundle} flips to `false` when any such diagnostic is raised.
 *
 * @param entry - The {@link AgentEntry} whose raw properties are inspected
 *   (not the {@link CantAgentV3} projection, because `tone` and `enforcement`
 *   are not part of the typed v3 surface).
 * @param sourcePath - Absolute path to the source `.cant` file for attribution.
 * @returns Zero or more S-TODO-001 diagnostics.
 */
function detectTodoStubs(entry: AgentEntry, sourcePath: string): BundleDiagnostic[] {
  const stubs: BundleDiagnostic[] = [];
  const fields: readonly string[] = ['prompt', 'tone', 'enforcement'];
  for (const field of fields) {
    const raw = entry.properties[field];
    const value = coerceString(raw);
    if (value?.includes('TODO')) {
      stubs.push({
        ruleId: 'S-TODO-001',
        message: `Field '${field}' on agent '${entry.name}' contains TODO stub; agent cannot be spawned with placeholder content`,
        severity: 'error',
        sourcePath,
      });
    }
  }
  return stubs;
}

/**
 * Extract teams from a parsed document AST.
 *
 * @remarks
 * The current cant-core parser does not support `team` sections. This
 * function is a forward-compatible stub that will extract teams once the
 * grammar adds `team` as a recognized top-level construct.
 *
 * @param doc - The raw AST document object from `parseDocument`.
 * @param sourcePath - The source file path for attribution.
 * @returns An array of {@link TeamEntry} (currently always empty).
 */
function extractTeams(doc: unknown, sourcePath: string): TeamEntry[] {
  if (typeof doc !== 'object' || doc === null) return [];
  const docObj = doc as Record<string, unknown>;
  const sections = docObj['sections'];
  if (!Array.isArray(sections)) return [];

  const teams: TeamEntry[] = [];
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue;
    const wrapper = section as Record<string, unknown>;
    const teamData = wrapper['Team'] as
      | { name: { value: string }; properties: RawAstProperty[] }
      | undefined;
    if (!teamData) continue;

    const nameValue = teamData.name?.value;
    if (typeof nameValue !== 'string') continue;

    teams.push({
      name: nameValue,
      sourcePath,
      properties: extractProperties(teamData.properties ?? []),
    });
  }
  return teams;
}

/**
 * Extract tools from a parsed document AST.
 *
 * @remarks
 * The current cant-core parser does not support `tool` sections. This
 * function is a forward-compatible stub that will extract tools once the
 * grammar adds `tool` as a recognized top-level construct.
 *
 * @param doc - The raw AST document object from `parseDocument`.
 * @param sourcePath - The source file path for attribution.
 * @returns An array of {@link ToolEntry} (currently always empty).
 */
function extractTools(doc: unknown, sourcePath: string): ToolEntry[] {
  if (typeof doc !== 'object' || doc === null) return [];
  const docObj = doc as Record<string, unknown>;
  const sections = docObj['sections'];
  if (!Array.isArray(sections)) return [];

  const tools: ToolEntry[] = [];
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue;
    const wrapper = section as Record<string, unknown>;
    const toolData = wrapper['Tool'] as
      | { name: { value: string }; properties: RawAstProperty[] }
      | undefined;
    if (!toolData) continue;

    const nameValue = toolData.name?.value;
    if (typeof nameValue !== 'string') continue;

    tools.push({
      name: nameValue,
      sourcePath,
      properties: extractProperties(toolData.properties ?? []),
    });
  }
  return tools;
}

/**
 * Render a system prompt addendum from the compiled bundle contents.
 *
 * @remarks
 * Produces markdown suitable for appending to a Pi system prompt. Lists
 * all declared agents with their roles, tiers, and descriptions; all
 * teams with orchestrators and members; and all tools with descriptions.
 *
 * @param bundle - The compiled bundle to render.
 * @returns A markdown-formatted string, or an empty string if the bundle is empty.
 */
function renderBundleSystemPrompt(bundle: CompiledBundle): string {
  const lines: string[] = [];

  if (bundle.agents.length === 0 && bundle.teams.length === 0 && bundle.tools.length === 0) {
    return '';
  }

  lines.push('## CANT Bundle — Loaded Declarations');
  lines.push('');

  if (bundle.agents.length > 0) {
    lines.push('### Agents');
    lines.push('');
    for (const agent of bundle.agents) {
      const role =
        typeof agent.properties['role'] === 'string' ? agent.properties['role'] : 'unspecified';
      const tier =
        typeof agent.properties['tier'] === 'string' ? agent.properties['tier'] : 'unspecified';
      const prompt =
        typeof agent.properties['prompt'] === 'string' ? agent.properties['prompt'] : '';
      const description = prompt.length > 0 ? prompt.split('\n')[0] : '';

      lines.push(`- **${agent.name}** (role: ${role}, tier: ${tier})`);
      if (description.length > 0) {
        lines.push(`  ${description.trim()}`);
      }
    }
    lines.push('');
  }

  if (bundle.teams.length > 0) {
    lines.push('### Teams');
    lines.push('');
    for (const team of bundle.teams) {
      const orchestrator =
        typeof team.properties['orchestrator'] === 'string'
          ? team.properties['orchestrator']
          : 'unspecified';
      const description =
        typeof team.properties['description'] === 'string' ? team.properties['description'] : '';
      lines.push(`- **${team.name}** (orchestrator: ${orchestrator})`);
      if (description.length > 0) {
        lines.push(`  ${description.trim()}`);
      }
    }
    lines.push('');
  }

  if (bundle.tools.length > 0) {
    lines.push('### Tools');
    lines.push('');
    for (const tool of bundle.tools) {
      const description =
        typeof tool.properties['description'] === 'string' ? tool.properties['description'] : '';
      lines.push(`- **${tool.name}**`);
      if (description.length > 0) {
        lines.push(`  ${description.trim()}`);
      }
    }
    lines.push('');
  }

  if (!bundle.valid && bundle.diagnostics.length > 0) {
    const errorCount = bundle.diagnostics.filter((d) => d.severity === 'error').length;
    if (errorCount > 0) {
      lines.push(`> **Warning**: ${errorCount} validation error(s) found across .cant files.`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a list of `.cant` files into a unified {@link CompiledBundle}.
 *
 * @remarks
 * For each file path, reads the file, parses it via {@link parseDocument},
 * validates it via {@link validateDocument}, then extracts agents, teams,
 * and tools from the AST. Diagnostics from both parse errors and validation
 * are collected into the bundle's {@link CompiledBundle.diagnostics} array.
 *
 * Files that fail to parse are still included in the bundle (with their
 * diagnostics) but do not contribute entities. The bundle's `valid` flag
 * is `true` only when every file parsed successfully and validated with
 * zero error-severity diagnostics.
 *
 * @param filePaths - Absolute paths to `.cant` files to compile.
 * @returns A {@link CompiledBundle} with all extracted entities and diagnostics.
 *
 * @example
 * ```typescript
 * import { compileBundle } from '@cleocode/cant';
 *
 * const bundle = await compileBundle([
 *   '/project/.cleo/cant/backend-dev.cant',
 *   '/project/.cleo/cant/frontend-dev.cant',
 * ]);
 *
 * console.log(`Found ${bundle.agents.length} agents`);
 * console.log(`Valid: ${bundle.valid}`);
 * console.log(bundle.renderSystemPrompt());
 * ```
 */
export async function compileBundle(filePaths: string[]): Promise<CompiledBundle> {
  const documents = new Map<string, ParsedCantDocument>();
  const allAgents: TypedAgentEntry[] = [];
  const allTeams: TeamEntry[] = [];
  const allTools: ToolEntry[] = [];
  const allDiagnostics: BundleDiagnostic[] = [];
  let allValid = true;

  for (const filePath of filePaths) {
    const fileDiagnostics: BundleDiagnostic[] = [];

    // Parse the document
    let parseResult: CantDocumentResult;
    try {
      parseResult = await parseDocument(filePath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fileDiagnostics.push({
        ruleId: 'parse',
        message: `Failed to read or parse file: ${message}`,
        severity: 'error',
        sourcePath: filePath,
      });
      allDiagnostics.push(...fileDiagnostics);
      documents.set(filePath, {
        sourcePath: filePath,
        kind: null,
        document: null,
        diagnostics: fileDiagnostics,
      });
      allValid = false;
      continue;
    }

    // Convert parse errors to bundle diagnostics (preserving line/col from the native binding)
    if (!parseResult.success) {
      for (const err of parseResult.errors) {
        fileDiagnostics.push({
          ruleId: 'parse',
          message: err.message,
          severity: err.severity,
          sourcePath: filePath,
          line: err.line,
          col: err.col,
        });
      }
      allValid = false;
    }

    // Extract document kind from AST
    let kind: string | null = null;
    if (parseResult.document !== null && typeof parseResult.document === 'object') {
      const docObj = parseResult.document as Record<string, unknown>;
      if (typeof docObj['kind'] === 'string') {
        kind = docObj['kind'];
      }
    }

    // Validate if parsing succeeded
    if (parseResult.success) {
      let validationResult: CantValidationResult;
      try {
        validationResult = await validateDocument(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        fileDiagnostics.push({
          ruleId: 'validate',
          message: `Validation failed: ${message}`,
          severity: 'error',
          sourcePath: filePath,
        });
        allDiagnostics.push(...fileDiagnostics);
        documents.set(filePath, {
          sourcePath: filePath,
          kind,
          document: parseResult.document,
          diagnostics: fileDiagnostics,
        });
        allValid = false;
        continue;
      }

      // Convert validation diagnostics (preserving line/col from the native binding)
      for (const diag of validationResult.diagnostics) {
        fileDiagnostics.push({
          ruleId: diag.ruleId,
          message: diag.message,
          severity: diag.severity,
          sourcePath: filePath,
          line: diag.line,
          col: diag.col,
        });
      }

      if (!validationResult.valid) {
        allValid = false;
      }

      // Extract entities from successfully parsed documents
      const agents = extractAgents(parseResult.document, filePath);
      const teams = extractTeams(parseResult.document, filePath);
      const tools = extractTools(parseResult.document, filePath);

      for (const agent of agents) {
        const typed = toCantAgentV3(agent, filePath);
        const typedEntry: TypedAgentEntry = { ...agent, typed };

        const todoStubs = detectTodoStubs(agent, filePath);
        if (todoStubs.length > 0) {
          for (const stub of todoStubs) {
            fileDiagnostics.push(stub);
          }
          allValid = false;
        }

        allAgents.push(typedEntry);
      }
      allTeams.push(...teams);
      allTools.push(...tools);
    }

    allDiagnostics.push(...fileDiagnostics);
    documents.set(filePath, {
      sourcePath: filePath,
      kind,
      document: parseResult.document,
      diagnostics: fileDiagnostics,
    });
  }

  const bundle: CompiledBundle = {
    documents,
    agents: allAgents,
    teams: allTeams,
    tools: allTools,
    diagnostics: allDiagnostics,
    valid: allValid,
    renderSystemPrompt(): string {
      return renderBundleSystemPrompt(this);
    },
  };

  return bundle;
}
