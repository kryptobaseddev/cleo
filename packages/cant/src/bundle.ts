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

import { parseDocument, validateDocument } from './document.js';
import type { CantDocumentResult, CantValidationResult } from './document.js';
import type { NativeDiagnostic } from './native-loader.js';

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

/** A normalized diagnostic combining parse errors and validation diagnostics. */
export interface BundleDiagnostic {
  /** The rule ID (e.g., `"S01"`, `"parse"`). */
  ruleId: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** Severity: `"error"`, `"warning"`, `"info"`, or `"hint"`. */
  severity: string;
  /** Source file path. */
  sourcePath: string;
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
  /** Agents found across all documents. */
  agents: AgentEntry[];
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
    const teamData = wrapper['Team'] as { name: { value: string }; properties: RawAstProperty[] } | undefined;
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
    const toolData = wrapper['Tool'] as { name: { value: string }; properties: RawAstProperty[] } | undefined;
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
      const role = typeof agent.properties['role'] === 'string' ? agent.properties['role'] : 'unspecified';
      const tier = typeof agent.properties['tier'] === 'string' ? agent.properties['tier'] : 'unspecified';
      const prompt = typeof agent.properties['prompt'] === 'string' ? agent.properties['prompt'] : '';
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
      const orchestrator = typeof team.properties['orchestrator'] === 'string'
        ? team.properties['orchestrator']
        : 'unspecified';
      const description = typeof team.properties['description'] === 'string'
        ? team.properties['description']
        : '';
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
      const description = typeof tool.properties['description'] === 'string'
        ? tool.properties['description']
        : '';
      lines.push(`- **${tool.name}**`);
      if (description.length > 0) {
        lines.push(`  ${description.trim()}`);
      }
    }
    lines.push('');
  }

  if (!bundle.valid && bundle.diagnostics.length > 0) {
    const errorCount = bundle.diagnostics.filter(d => d.severity === 'error').length;
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
  const allAgents: AgentEntry[] = [];
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

    // Convert parse errors to bundle diagnostics
    if (!parseResult.success) {
      for (const err of parseResult.errors) {
        fileDiagnostics.push({
          ruleId: 'parse',
          message: err.message,
          severity: err.severity,
          sourcePath: filePath,
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

      // Convert validation diagnostics
      for (const diag of validationResult.diagnostics) {
        fileDiagnostics.push({
          ruleId: diag.ruleId,
          message: diag.message,
          severity: diag.severity,
          sourcePath: filePath,
        });
      }

      if (!validationResult.valid) {
        allValid = false;
      }

      // Extract entities from successfully parsed documents
      const agents = extractAgents(parseResult.document, filePath);
      const teams = extractTeams(parseResult.document, filePath);
      const tools = extractTools(parseResult.document, filePath);

      allAgents.push(...agents);
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
