#!/usr/bin/env tsx
/**
 * Provider Research Script (v2)
 *
 * Development-only tool for researching, aggregating, and comparing provider
 * capabilities from internet sources against the local registry.json.
 *
 * All documentation URLs are loaded from scripts/provider-sources.json —
 * nothing is hardcoded in this script.
 *
 * Usage: npx tsx scripts/provider-research.ts [options]
 *
 * SAFETY: This script NEVER modifies registry.json — read and report only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistryDetection {
  methods: string[];
  binary?: string;
  appBundle?: string;
  directories?: string[];
}

interface RegistrySkillsCapability {
  precedence: string;
  agentsGlobalPath: string | null;
  agentsProjectPath: string | null;
}

interface RegistryHooksCapability {
  supported: string[];
  hookConfigPath: string | null;
  hookFormat: string | null;
}

interface RegistrySpawnCapability {
  supportsSubagents: boolean;
  supportsProgrammaticSpawn: boolean;
  supportsInterAgentComms: boolean;
  supportsParallelSpawn: boolean;
  spawnMechanism: string | null;
}

interface RegistryCapabilities {
  skills?: RegistrySkillsCapability;
  hooks?: RegistryHooksCapability;
  spawn?: RegistrySpawnCapability;
}

interface RegistryProvider {
  id: string;
  toolName: string;
  vendor: string;
  agentFlag: string;
  aliases: string[];
  pathGlobal: string;
  pathProject: string;
  instructFile: string;
  configKey: string;
  configFormat: string;
  configPathGlobal: string;
  configPathProject: string | null;
  pathSkills: string;
  pathProjectSkills: string;
  detection: RegistryDetection;
  supportedTransports: string[];
  supportsHeaders: boolean;
  priority: string;
  status: string;
  agentSkillsCompatible: boolean;
  capabilities?: RegistryCapabilities;
}

interface Registry {
  version: string;
  lastUpdated: string;
  providers: Record<string, RegistryProvider>;
}

// -- Sources config types --

interface AggregateSource {
  id: string;
  name: string;
  description: string;
  urls: string[];
  provides: string[];
}

interface ProviderSourceEntry {
  sources: string[];
  notes: string;
}

interface SourcesConfig {
  version: string;
  lastUpdated: string;
  aggregateSources: AggregateSource[];
  providers: Record<string, ProviderSourceEntry>;
}

// -- Aggregate parsed data --

interface AggregateAgentData {
  name: string;
  configPath?: string;
  instructionFile?: string;
  skillsPath?: string;
  configKey?: string;
  transports?: string[];
  detectionMethods?: string[];
}

interface AggregateData {
  sourceId: string;
  sourceName: string;
  agents: Record<string, AggregateAgentData>;
  raw: string;
}

// -- Discovery and report types --

interface DiscoveredCapabilities {
  hooks: {
    detected: boolean;
    events: string[];
    contextSnippets: string[];
  };
  spawn: {
    detected: boolean;
    details: string[];
    contextSnippets: string[];
  };
  skills: {
    pathsFound: string[];
  };
  mcp: {
    transportsFound: string[];
  };
  instructionFile: string | null;
  configFormat: string | null;
  configKey: string | null;
  errors: string[];
}

interface AggregateFindings {
  sourceId: string;
  sourceName: string;
  configPath?: string;
  instructionFile?: string;
  skillsPath?: string;
  configKey?: string;
  transports?: string[];
}

interface DiffEntry {
  field: string;
  registry: string;
  discovered: string;
  source: "aggregate" | "readme";
  confidence: "high" | "medium" | "low";
  action: "confirm" | "investigate" | "add" | "update";
}

interface ProviderReport {
  id: string;
  toolName: string;
  vendor: string;
  registrySummary: {
    status: string;
    priority: string;
    configKey: string;
    configFormat: string;
    supportedTransports: string[];
    supportsHeaders: boolean;
    agentSkillsCompatible: boolean;
    instructFile: string;
    capabilities: RegistryCapabilities | undefined;
  };
  aggregateFindings: AggregateFindings[];
  discovered: DiscoveredCapabilities;
  diff: DiffEntry[];
  recommendations: string[];
}

interface FullReport {
  timestamp: string;
  registryVersion: string;
  registryLastUpdated: string;
  totalProviders: number;
  researchedProviders: number;
  providers: ProviderReport[];
  summary: {
    withHooks: string[];
    withSpawn: string[];
    withCapabilities: string[];
    unreachable: string[];
    recommendationCount: number;
  };
}

// ---------------------------------------------------------------------------
// Context-aware pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a pattern only when it appears near context words.
 * This reduces false positives from generic README text.
 */
function contextAwareMatch(
  text: string,
  primaryPatterns: RegExp[],
  contextWords: string[],
  contextRadius: number = 200,
): { matched: boolean; details: string[]; snippets: string[] } {
  const details: string[] = [];
  const snippets: string[] = [];
  const contextPattern = new RegExp(contextWords.join("|"), "gi");

  for (const pattern of primaryPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = Math.max(0, match.index - contextRadius);
      const end = Math.min(text.length, match.index + match[0].length + contextRadius);
      const vicinity = text.slice(start, end);

      if (contextPattern.test(vicinity)) {
        const normalized = match[0].trim().toLowerCase();
        if (!details.includes(normalized)) {
          details.push(normalized);
        }
        const snippet = vicinity
          .replace(/\n/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (snippets.length < 3 && !snippets.some((s) => s === snippet)) {
          snippets.push(snippet);
        }
      }

      if (regex.lastIndex === match.index) {
        regex.lastIndex++;
      }
    }
  }

  return { matched: details.length > 0, details, snippets };
}

// Pattern sets with context requirements
const HOOKS_PATTERNS = [
  /\bhooks?\b/gi,
  /\blifecycle\s+(?:events?|hooks?)\b/gi,
  /\bon(?:Session|Tool|File|Error|Prompt|Response)[A-Z]\w+/g,
  /\bpre[-_]?(?:commit|push|save|edit)\b/gi,
  /\bpost[-_]?(?:commit|push|save|edit)\b/gi,
];
const HOOKS_CONTEXT = [
  "configuration",
  "settings",
  "config",
  "event",
  "callback",
  "trigger",
  "lifecycle",
  "hook",
  "claude",
  "agent",
];

const SPAWN_PATTERNS = [
  /\bsub[-_]?agents?\b/gi,
  /\bspawn\b/gi,
  /\bmulti[-_]?agent\b/gi,
  /\bparallel\s+agents?\b/gi,
  /\borchestrat(?:e|ion|or)\b/gi,
  /\bdelegate\b/gi,
  /\bteam\s+(?:mode|coding)\b/gi,
];
const SPAWN_CONTEXT = [
  "agent",
  "subagent",
  "worker",
  "parallel",
  "orchestrat",
  "team",
  "delegate",
  "spawn",
  "process",
  "child",
];

const TRANSPORT_PATTERNS: Array<{ pattern: RegExp; transport: string }> = [
  { pattern: /\bstdio\b/gi, transport: "stdio" },
  { pattern: /\bsse\b/gi, transport: "sse" },
  { pattern: /\bstreamable[-_]?http\b/gi, transport: "http" },
];

const INSTRUCTION_FILE_PATTERNS: Array<{
  pattern: RegExp;
  file: string;
}> = [
  { pattern: /CLAUDE\.md/g, file: "CLAUDE.md" },
  { pattern: /AGENTS\.md/g, file: "AGENTS.md" },
  { pattern: /GEMINI\.md/g, file: "GEMINI.md" },
  { pattern: /\.cursorrules/g, file: ".cursorrules" },
];

const CONFIG_FORMAT_PATTERNS: Array<{
  pattern: RegExp;
  format: string;
}> = [
  { pattern: /\.toml\b/gi, format: "toml" },
  { pattern: /\.ya?ml\b/gi, format: "yaml" },
  { pattern: /\.jsonc\b/gi, format: "jsonc" },
  { pattern: /\.json\b/gi, format: "json" },
];

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeFetch(url: string, verbose: boolean): Promise<string | null> {
  try {
    if (verbose) {
      console.error(`  [fetch] ${url}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "caamp-provider-research/2.0" },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      if (verbose) {
        console.error(`  [fetch] ${url} -> ${res.status}`);
      }
      return null;
    }
    return await res.text();
  } catch (err) {
    if (verbose) {
      console.error(
        `  [fetch] ${url} -> ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregate source parsers
// ---------------------------------------------------------------------------

/**
 * Parse Vercel Skills agents.ts — structured TypeScript with agent definitions
 * containing fields like { name, configPath, instructionFile, skillsPath }.
 */
function parseVercelSkills(raw: string): Record<string, AggregateAgentData> {
  const agents: Record<string, AggregateAgentData> = {};

  // Match object literal blocks within arrays/records.
  // The file uses patterns like: { name: "Claude Code", configPath: "...", ... }
  const objectPattern = /\{[^{}]*?name\s*:\s*["'`]([^"'`]+)["'`][^{}]*\}/gs;
  let match: RegExpExecArray | null;

  while ((match = objectPattern.exec(raw)) !== null) {
    const block = match[0];
    const name = match[1]!;

    const data: AggregateAgentData = { name };

    const extractField = (field: string): string | undefined => {
      const fieldMatch = new RegExp(
        `${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`,
      ).exec(block);
      return fieldMatch?.[1];
    };

    data.configPath = extractField("configPath") ?? extractField("config_path");
    data.instructionFile =
      extractField("instructionFile") ??
      extractField("instruction_file") ??
      extractField("instructFile");
    data.skillsPath =
      extractField("skillsPath") ??
      extractField("skills_path") ??
      extractField("skillsDir");

    // Derive a registry-style ID from the name
    const id = name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    agents[id] = data;
  }

  // Also try to match array-style definitions like: ["claude-code", { ... }]
  const arrayPattern =
    /["'`]([a-z][\w-]*)["'`]\s*,\s*\{([^{}]*)\}/gs;
  while ((match = arrayPattern.exec(raw)) !== null) {
    const id = match[1]!;
    if (agents[id]) continue;
    const block = match[2]!;
    const data: AggregateAgentData = { name: id };

    const extractField = (field: string): string | undefined => {
      const fieldMatch = new RegExp(
        `${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`,
      ).exec(block);
      return fieldMatch?.[1];
    };

    data.configPath = extractField("configPath");
    data.instructionFile = extractField("instructionFile");
    data.skillsPath = extractField("skillsPath");
    agents[id] = data;
  }

  return agents;
}

/**
 * Parse Neon add-mcp agents.ts — extracts MCP config paths, config keys,
 * transport support, and detection methods from a multi-agent installer.
 */
function parseNeonAddMcp(raw: string): Record<string, AggregateAgentData> {
  const agents: Record<string, AggregateAgentData> = {};

  // Match named agent definitions with their config blocks.
  // Neon's agents.ts typically has patterns like:
  //   "claude-code": { configPath: "...", configKey: "mcpServers", ... }
  // or class/function-based definitions.
  const namedBlockPattern =
    /["'`]([a-z][\w-]*)["'`]\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs;
  let match: RegExpExecArray | null;

  while ((match = namedBlockPattern.exec(raw)) !== null) {
    const id = match[1]!;
    const block = match[2]!;
    const data: AggregateAgentData = { name: id };

    const extractField = (field: string): string | undefined => {
      const fieldMatch = new RegExp(
        `${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`,
      ).exec(block);
      return fieldMatch?.[1];
    };

    data.configPath =
      extractField("configPath") ??
      extractField("config_path") ??
      extractField("mcpConfigPath");
    data.configKey =
      extractField("configKey") ?? extractField("config_key");

    // Look for transport arrays like: transports: ["stdio", "sse"]
    const transportMatch = /transports?\s*:\s*\[([^\]]+)\]/i.exec(block);
    if (transportMatch) {
      data.transports = transportMatch[1]!
        .match(/["'`]([^"'`]+)["'`]/g)
        ?.map((t) => t.replace(/["'`]/g, ""));
    }

    // Look for detection methods
    const detectionMatch = /detection\s*:\s*\[([^\]]+)\]/i.exec(block);
    if (detectionMatch) {
      data.detectionMethods = detectionMatch[1]!
        .match(/["'`]([^"'`]+)["'`]/g)
        ?.map((t) => t.replace(/["'`]/g, ""));
    }

    agents[id] = data;
  }

  // Also try: export const agents = [ { id: "...", ... }, ... ] style
  const objectPattern =
    /\{\s*(?:id|name)\s*:\s*["'`]([^"'`]+)["'`]([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs;
  while ((match = objectPattern.exec(raw)) !== null) {
    const idOrName = match[1]!;
    const id = idOrName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (agents[id]) continue;

    const block = match[2]!;
    const data: AggregateAgentData = { name: idOrName };

    const extractField = (field: string): string | undefined => {
      const fieldMatch = new RegExp(
        `${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`,
      ).exec(block);
      return fieldMatch?.[1];
    };

    data.configPath = extractField("configPath") ?? extractField("mcpConfigPath");
    data.configKey = extractField("configKey");

    agents[id] = data;
  }

  return agents;
}

async function fetchAggregateSources(
  config: SourcesConfig,
  verbose: boolean,
): Promise<AggregateData[]> {
  const results: AggregateData[] = [];

  for (const source of config.aggregateSources) {
    const texts: string[] = [];

    for (const url of source.urls) {
      const text = await safeFetch(url, verbose);
      if (text) {
        texts.push(text);
      }
      await delay(300);
    }

    if (texts.length === 0) {
      if (verbose) {
        console.error(`  [aggregate] ${source.id}: all URLs failed`);
      }
      continue;
    }

    const combined = texts.join("\n\n");
    let agents: Record<string, AggregateAgentData>;

    if (source.id === "vercel-skills") {
      agents = parseVercelSkills(combined);
    } else if (source.id === "neon-add-mcp") {
      agents = parseNeonAddMcp(combined);
    } else {
      // Generic fallback: try both parsers and merge
      agents = { ...parseVercelSkills(combined), ...parseNeonAddMcp(combined) };
    }

    if (verbose) {
      console.error(
        `  [aggregate] ${source.id}: parsed ${Object.keys(agents).length} agent(s)`,
      );
    }

    results.push({
      sourceId: source.id,
      sourceName: source.name,
      agents,
      raw: combined,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prevent cross-matching between similar provider IDs.
 * For example, "claude-code" should not match "claude-desktop".
 */
function isExcludedMatch(providerId: string, candidateId: string): boolean {
  // If both have the same prefix but different suffixes, exclude
  const providerParts = providerId.split("-");
  const candidateParts = candidateId.split("-");

  if (
    providerParts.length > 1 &&
    candidateParts.length > 1 &&
    providerParts[0] === candidateParts[0] &&
    providerId !== candidateId
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Resolve aggregate data to a specific provider
// ---------------------------------------------------------------------------

function matchAggregateToProvider(
  providerId: string,
  aliases: string[],
  aggregateData: AggregateData[],
): AggregateFindings[] {
  const findings: AggregateFindings[] = [];
  const matchKeys = [providerId, ...aliases].map((k) => k.toLowerCase());

  for (const agg of aggregateData) {
    for (const [agentId, agentData] of Object.entries(agg.agents)) {
      const normalizedId = agentId.toLowerCase();
      const normalizedName = agentData.name.toLowerCase();

      // Use exact or word-boundary matching to avoid partial matches
      // e.g., "claude" should NOT match "claude-desktop"
      const isMatch = matchKeys.some(
        (key) =>
          normalizedId === key ||
          normalizedName === key ||
          // Word-boundary: match "claude-code" against key "claude-code"
          // but not "claude-desktop" against key "claude"
          new RegExp(`\\b${escapeRegex(key)}\\b`).test(normalizedId) ||
          new RegExp(`\\b${escapeRegex(key)}\\b`).test(normalizedName),
      ) && !isExcludedMatch(providerId, normalizedId);

      if (isMatch) {
        findings.push({
          sourceId: agg.sourceId,
          sourceName: agg.sourceName,
          configPath: agentData.configPath,
          instructionFile: agentData.instructionFile,
          skillsPath: agentData.skillsPath,
          configKey: agentData.configKey,
          transports: agentData.transports,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Research a single provider from README sources
// ---------------------------------------------------------------------------

async function researchProviderReadme(
  provider: RegistryProvider,
  sources: string[],
  verbose: boolean,
): Promise<DiscoveredCapabilities> {
  const caps: DiscoveredCapabilities = {
    hooks: { detected: false, events: [], contextSnippets: [] },
    spawn: { detected: false, details: [], contextSnippets: [] },
    skills: { pathsFound: [] },
    mcp: { transportsFound: [] },
    instructionFile: null,
    configFormat: null,
    configKey: null,
    errors: [],
  };

  if (sources.length === 0) {
    caps.errors.push("No documentation sources configured");
    return caps;
  }

  const allText: string[] = [];

  for (const url of sources) {
    const text = await safeFetch(url, verbose);
    if (text) {
      allText.push(text);
    } else {
      caps.errors.push(`Failed to fetch: ${url}`);
    }
    await delay(300);
  }

  if (allText.length === 0) {
    caps.errors.push("All source fetches failed");
    return caps;
  }

  const combined = allText.join("\n\n---\n\n");

  // Hooks detection with context awareness
  const hooksResult = contextAwareMatch(
    combined,
    HOOKS_PATTERNS,
    HOOKS_CONTEXT,
  );
  caps.hooks.detected = hooksResult.matched;
  caps.hooks.events = hooksResult.details.slice(0, 10);
  caps.hooks.contextSnippets = hooksResult.snippets;

  // Spawn/subagent detection with context awareness
  const spawnResult = contextAwareMatch(
    combined,
    SPAWN_PATTERNS,
    SPAWN_CONTEXT,
  );
  caps.spawn.detected = spawnResult.matched;
  caps.spawn.details = spawnResult.details.slice(0, 10);
  caps.spawn.contextSnippets = spawnResult.snippets;

  // MCP transport detection
  for (const { pattern, transport } of TRANSPORT_PATTERNS) {
    if (pattern.test(combined)) {
      caps.mcp.transportsFound.push(transport);
    }
  }

  // Instruction file detection
  for (const { pattern, file } of INSTRUCTION_FILE_PATTERNS) {
    if (pattern.test(combined)) {
      caps.instructionFile = file;
      break;
    }
  }

  // Config format detection
  for (const { pattern, format } of CONFIG_FORMAT_PATTERNS) {
    if (pattern.test(combined)) {
      caps.configFormat = format;
      break;
    }
  }

  // Config key detection
  const configKeyMatch =
    /["']?(mcpServers|mcp_servers|extensions|mcp|servers|context_servers)["']?\s*:/i.exec(
      combined,
    );
  if (configKeyMatch) {
    caps.configKey = configKeyMatch[1]!;
  }

  // Skills path detection
  const skillsPathPatterns = [
    /(?:skills?|commands?)[-_]?(?:path|dir|directory)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    /(?:\.[\w-]+\/skills)\b/gi,
    /\$HOME\/\.[\w-]+\/skills\b/gi,
  ];
  for (const pattern of skillsPathPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let skillMatch: RegExpExecArray | null;
    while ((skillMatch = regex.exec(combined)) !== null) {
      const path = (skillMatch[1] ?? skillMatch[0]).trim();
      if (!caps.skills.pathsFound.includes(path)) {
        caps.skills.pathsFound.push(path);
      }
    }
  }

  return caps;
}

// ---------------------------------------------------------------------------
// Build diff between registry and all discovered data
// ---------------------------------------------------------------------------

function buildDiff(
  provider: RegistryProvider,
  aggregateFindings: AggregateFindings[],
  discovered: DiscoveredCapabilities,
): DiffEntry[] {
  const diff: DiffEntry[] = [];

  // --- Aggregate source diffs (high confidence) ---

  for (const finding of aggregateFindings) {
    // Config key comparison
    if (finding.configKey && finding.configKey !== provider.configKey) {
      diff.push({
        field: "configKey",
        registry: provider.configKey,
        discovered: finding.configKey,
        source: "aggregate",
        confidence: "high",
        action: "investigate",
      });
    }

    // Instruction file comparison
    if (
      finding.instructionFile &&
      finding.instructionFile !== provider.instructFile
    ) {
      diff.push({
        field: "instructFile",
        registry: provider.instructFile,
        discovered: finding.instructionFile,
        source: "aggregate",
        confidence: "high",
        action: "investigate",
      });
    }

    // Skills path comparison against capabilities
    if (finding.skillsPath) {
      const regSkillsPath =
        provider.capabilities?.skills?.agentsProjectPath ??
        provider.pathProjectSkills;
      if (regSkillsPath && finding.skillsPath !== regSkillsPath) {
        diff.push({
          field: "capabilities.skills.agentsProjectPath",
          registry: regSkillsPath,
          discovered: finding.skillsPath,
          source: "aggregate",
          confidence: "medium",
          action: "investigate",
        });
      }
    }

    // Transport comparison
    if (finding.transports && finding.transports.length > 0) {
      const regTransports = provider.supportedTransports.slice().sort().join(", ");
      const discTransports = finding.transports.slice().sort().join(", ");
      if (regTransports !== discTransports) {
        diff.push({
          field: "supportedTransports",
          registry: regTransports,
          discovered: discTransports,
          source: "aggregate",
          confidence: "high",
          action: "investigate",
        });
      }
    }
  }

  // --- README-based diffs (lower confidence) ---

  // MCP transports from README
  if (discovered.mcp.transportsFound.length > 0) {
    const regTransports = provider.supportedTransports.slice().sort().join(", ");
    const discTransports = discovered.mcp.transportsFound.slice().sort().join(", ");
    if (
      regTransports !== discTransports &&
      !diff.some((d) => d.field === "supportedTransports")
    ) {
      diff.push({
        field: "supportedTransports",
        registry: regTransports,
        discovered: discTransports,
        source: "readme",
        confidence: "low",
        action: "investigate",
      });
    }
  }

  // Instruction file from README
  if (
    discovered.instructionFile &&
    discovered.instructionFile !== provider.instructFile &&
    !diff.some((d) => d.field === "instructFile")
  ) {
    diff.push({
      field: "instructFile",
      registry: provider.instructFile,
      discovered: discovered.instructionFile,
      source: "readme",
      confidence: "low",
      action: "investigate",
    });
  }

  // Config format from README
  if (
    discovered.configFormat &&
    discovered.configFormat !== provider.configFormat
  ) {
    diff.push({
      field: "configFormat",
      registry: provider.configFormat,
      discovered: discovered.configFormat,
      source: "readme",
      confidence: "low",
      action: "investigate",
    });
  }

  // Config key from README
  if (
    discovered.configKey &&
    discovered.configKey !== provider.configKey &&
    !diff.some((d) => d.field === "configKey")
  ) {
    diff.push({
      field: "configKey",
      registry: provider.configKey,
      discovered: discovered.configKey,
      source: "readme",
      confidence: "low",
      action: "investigate",
    });
  }

  // --- Capabilities diffs ---

  // Hooks: compare registry capabilities.hooks vs discovered
  if (discovered.hooks.detected) {
    const regHooks = provider.capabilities?.hooks;
    if (!regHooks) {
      diff.push({
        field: "capabilities.hooks",
        registry: "not defined",
        discovered: discovered.hooks.events.slice(0, 5).join(", "),
        source: "readme",
        confidence: "medium",
        action: "add",
      });
    } else {
      // Check if discovered events differ from registered ones
      const discoveredEvents = discovered.hooks.events
        .filter((e) => /^on[A-Z]/.test(e))
        .sort();
      const registeredEvents = regHooks.supported.slice().sort();
      if (
        discoveredEvents.length > 0 &&
        JSON.stringify(discoveredEvents) !== JSON.stringify(registeredEvents)
      ) {
        const newEvents = discoveredEvents.filter(
          (e) => !registeredEvents.includes(e),
        );
        if (newEvents.length > 0) {
          diff.push({
            field: "capabilities.hooks.supported",
            registry: registeredEvents.join(", "),
            discovered: `${registeredEvents.join(", ")} + new: ${newEvents.join(", ")}`,
            source: "readme",
            confidence: "medium",
            action: "investigate",
          });
        }
      }
    }
  }

  // Spawn: compare registry capabilities.spawn vs discovered
  if (discovered.spawn.detected) {
    const regSpawn = provider.capabilities?.spawn;
    if (!regSpawn) {
      diff.push({
        field: "capabilities.spawn",
        registry: "not defined",
        discovered: discovered.spawn.details.slice(0, 5).join(", "),
        source: "readme",
        confidence: "medium",
        action: "add",
      });
    }
  }

  // Skills precedence: if aggregate data found skills paths but no capabilities.skills defined
  if (
    aggregateFindings.some((f) => f.skillsPath) &&
    !provider.capabilities?.skills
  ) {
    const skillsPaths = aggregateFindings
      .filter((f) => f.skillsPath)
      .map((f) => f.skillsPath!)
      .join(", ");
    diff.push({
      field: "capabilities.skills",
      registry: "not defined",
      discovered: `skills paths found: ${skillsPaths}`,
      source: "aggregate",
      confidence: "medium",
      action: "add",
    });
  }

  return diff;
}

// ---------------------------------------------------------------------------
// Build recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(
  provider: RegistryProvider,
  aggregateFindings: AggregateFindings[],
  discovered: DiscoveredCapabilities,
  diff: DiffEntry[],
  totalSources: number,
): string[] {
  const recs: string[] = [];

  // High-confidence diffs from aggregate sources
  const aggDiffs = diff.filter(
    (d) => d.source === "aggregate" && d.confidence === "high",
  );
  for (const d of aggDiffs) {
    recs.push(
      `[HIGH] ${d.field}: registry="${d.registry}" vs aggregate="${d.discovered}"`,
    );
  }

  // Capability additions
  if (
    discovered.hooks.detected &&
    !provider.capabilities?.hooks
  ) {
    recs.push(
      `Add capabilities.hooks — hook-related patterns found in documentation`,
    );
  }

  if (
    discovered.spawn.detected &&
    !provider.capabilities?.spawn
  ) {
    recs.push(
      `Add capabilities.spawn — spawn/subagent patterns found in documentation`,
    );
  }

  // Medium-confidence diffs
  const medDiffs = diff.filter((d) => d.confidence === "medium");
  for (const d of medDiffs) {
    if (d.action === "add") {
      recs.push(`[MED] Add ${d.field}: ${d.discovered}`);
    } else {
      recs.push(
        `[MED] Investigate ${d.field}: registry="${d.registry}" vs discovered="${d.discovered}"`,
      );
    }
  }

  // Low-confidence diffs that merit investigation
  const lowDiffs = diff.filter(
    (d) => d.confidence === "low" && d.action === "investigate",
  );
  for (const d of lowDiffs) {
    recs.push(
      `[LOW] Verify ${d.field}: registry="${d.registry}" vs readme="${d.discovered}"`,
    );
  }

  // Unreachable sources
  if (
    discovered.errors.length > 0 &&
    discovered.errors.length === totalSources
  ) {
    recs.push(
      `All documentation sources unreachable — verify URLs in provider-sources.json`,
    );
  }

  // No aggregate data found
  if (aggregateFindings.length === 0) {
    recs.push(
      `No aggregate source data found — consider adding this provider to aggregate source configs`,
    );
  }

  return recs;
}

// ---------------------------------------------------------------------------
// LLM research prompt generation
// ---------------------------------------------------------------------------

function generateLLMPrompt(
  provider: RegistryProvider,
  sourceEntry: ProviderSourceEntry | undefined,
  aggregateFindings: AggregateFindings[],
  discovered: DiscoveredCapabilities,
  diff: DiffEntry[],
): string {
  const lines: string[] = [];

  lines.push("# Provider Research Prompt");
  lines.push("");
  lines.push(
    `Research the **${provider.toolName}** (${provider.id}) AI coding agent by **${provider.vendor}**.`,
  );
  lines.push("");
  lines.push("## Current Registry Data");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(provider, null, 2));
  lines.push("```");
  lines.push("");

  // What we know from aggregate sources
  if (aggregateFindings.length > 0) {
    lines.push("## Aggregate Source Findings");
    lines.push("");
    for (const f of aggregateFindings) {
      lines.push(`### ${f.sourceName}`);
      if (f.configPath) lines.push(`- Config path: ${f.configPath}`);
      if (f.instructionFile)
        lines.push(`- Instruction file: ${f.instructionFile}`);
      if (f.skillsPath) lines.push(`- Skills path: ${f.skillsPath}`);
      if (f.configKey) lines.push(`- Config key: ${f.configKey}`);
      if (f.transports)
        lines.push(`- Transports: ${f.transports.join(", ")}`);
      lines.push("");
    }
  }

  // Diffs found
  if (diff.length > 0) {
    lines.push("## Differences Found");
    lines.push("");
    for (const d of diff) {
      lines.push(
        `- **${d.field}** [${d.confidence}/${d.source}]: registry="${d.registry}" vs discovered="${d.discovered}"`,
      );
    }
    lines.push("");
  }

  // Questions to answer
  lines.push("## Questions to Research");
  lines.push("");

  // Always ask about capabilities
  if (!provider.capabilities?.hooks) {
    lines.push(
      `1. Does ${provider.toolName} support lifecycle hooks? If so, which events are available (onSessionStart, onToolStart, etc.)? What is the hook configuration format?`,
    );
  } else {
    lines.push(
      `1. Are there any NEW lifecycle hook events for ${provider.toolName} beyond: ${provider.capabilities.hooks.supported.join(", ")}?`,
    );
  }

  if (!provider.capabilities?.spawn) {
    lines.push(
      `2. Does ${provider.toolName} support spawning subagents or multi-agent workflows? What mechanism is used (native, MCP, CLI, API)?`,
    );
  } else {
    lines.push(
      `2. Has ${provider.toolName}'s spawn/subagent support changed? Current: mechanism=${provider.capabilities.spawn.spawnMechanism}, parallel=${provider.capabilities.spawn.supportsParallelSpawn}`,
    );
  }

  if (!provider.capabilities?.skills) {
    lines.push(
      `3. Does ${provider.toolName} support an .agents/skills directory convention? What is the skill loading precedence (vendor-only, agents-first, agents-canonical)?`,
    );
  } else {
    lines.push(
      `3. Has ${provider.toolName}'s skills precedence changed? Current: ${provider.capabilities.skills.precedence}, globalPath=${provider.capabilities.skills.agentsGlobalPath}, projectPath=${provider.capabilities.skills.agentsProjectPath}`,
    );
  }

  lines.push(
    `4. What MCP transports does ${provider.toolName} currently support? (stdio, sse, streamable-http)`,
  );
  lines.push(
    `5. What is the correct MCP config path and config key for ${provider.toolName}?`,
  );
  lines.push(
    `6. Does ${provider.toolName} support custom headers in MCP server configurations?`,
  );

  // Specific questions from diffs
  if (diff.length > 0) {
    lines.push("");
    lines.push("## Specific Discrepancies to Resolve");
    lines.push("");
    let q = 7;
    for (const d of diff) {
      lines.push(
        `${q}. ${d.field}: Our registry says "${d.registry}" but ${d.source} data suggests "${d.discovered}". Which is correct?`,
      );
      q++;
    }
  }

  lines.push("");
  lines.push("## Source Notes");
  if (sourceEntry) {
    lines.push(`Notes: ${sourceEntry.notes}`);
    lines.push(`Documentation URLs: ${sourceEntry.sources.join(", ")}`);
  } else {
    lines.push(
      "No documentation sources configured for this provider in provider-sources.json.",
    );
  }

  lines.push("");
  lines.push(
    "Please use Context7 or web search to find the most current documentation. Focus on the official docs and source code rather than blog posts.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Console output formatting
// ---------------------------------------------------------------------------

function printConsoleReport(report: FullReport): void {
  const line = "=".repeat(76);
  const thinLine = "-".repeat(76);

  console.log();
  console.log(line);
  console.log("  CAAMP Provider Research Report (v2)");
  console.log(line);
  console.log(`  Timestamp:          ${report.timestamp}`);
  console.log(`  Registry version:   ${report.registryVersion}`);
  console.log(`  Registry updated:   ${report.registryLastUpdated}`);
  console.log(`  Total providers:    ${report.totalProviders}`);
  console.log(`  Researched:         ${report.researchedProviders}`);
  console.log(line);

  for (const p of report.providers) {
    console.log();
    console.log(thinLine);
    console.log(`  ${p.toolName} (${p.id})`);
    console.log(
      `  Vendor: ${p.vendor} | Status: ${p.registrySummary.status} | Priority: ${p.registrySummary.priority}`,
    );
    console.log(thinLine);

    // Registry summary
    console.log("  Registry:");
    console.log(`    configKey:       ${p.registrySummary.configKey}`);
    console.log(`    configFormat:    ${p.registrySummary.configFormat}`);
    console.log(
      `    transports:      ${p.registrySummary.supportedTransports.join(", ")}`,
    );
    console.log(`    headers:         ${p.registrySummary.supportsHeaders}`);
    console.log(
      `    skills:          ${p.registrySummary.agentSkillsCompatible}`,
    );
    console.log(`    instructFile:    ${p.registrySummary.instructFile}`);

    // Capabilities
    const caps = p.registrySummary.capabilities;
    if (caps) {
      console.log("    capabilities:");
      if (caps.hooks) {
        console.log(
          `      hooks:         ${caps.hooks.supported.join(", ")}`,
        );
      }
      if (caps.spawn) {
        console.log(
          `      spawn:         mechanism=${caps.spawn.spawnMechanism}, subagents=${caps.spawn.supportsSubagents}, parallel=${caps.spawn.supportsParallelSpawn}`,
        );
      }
      if (caps.skills) {
        console.log(
          `      skills:        precedence=${caps.skills.precedence}, global=${caps.skills.agentsGlobalPath ?? "n/a"}, project=${caps.skills.agentsProjectPath ?? "n/a"}`,
        );
      }
    }

    // Aggregate findings
    if (p.aggregateFindings.length > 0) {
      console.log("  Aggregate Sources (high confidence):");
      for (const f of p.aggregateFindings) {
        console.log(`    [${f.sourceId}]`);
        if (f.configPath) console.log(`      configPath:      ${f.configPath}`);
        if (f.instructionFile)
          console.log(`      instructionFile: ${f.instructionFile}`);
        if (f.skillsPath) console.log(`      skillsPath:      ${f.skillsPath}`);
        if (f.configKey) console.log(`      configKey:       ${f.configKey}`);
        if (f.transports)
          console.log(`      transports:      ${f.transports.join(", ")}`);
      }
    }

    // README discoveries
    console.log("  README Scan (lower confidence):");
    console.log(
      `    hooks:           ${p.discovered.hooks.detected ? `yes (${p.discovered.hooks.events.slice(0, 5).join(", ")})` : "no"}`,
    );
    console.log(
      `    spawn:           ${p.discovered.spawn.detected ? `yes (${p.discovered.spawn.details.slice(0, 5).join(", ")})` : "no"}`,
    );
    console.log(
      `    mcp transports:  ${p.discovered.mcp.transportsFound.join(", ") || "none detected"}`,
    );
    console.log(
      `    instruction:     ${p.discovered.instructionFile ?? "none detected"}`,
    );
    console.log(
      `    config format:   ${p.discovered.configFormat ?? "none detected"}`,
    );
    console.log(
      `    config key:      ${p.discovered.configKey ?? "none detected"}`,
    );

    if (p.discovered.errors.length > 0) {
      console.log("  Fetch Errors:");
      for (const e of p.discovered.errors) {
        console.log(`    - ${e}`);
      }
    }

    // Diff
    if (p.diff.length > 0) {
      console.log("  Differences:");
      for (const d of p.diff) {
        const tag = `${d.action.toUpperCase()}/${d.confidence.toUpperCase()}/${d.source}`;
        console.log(`    [${tag}] ${d.field}`);
        console.log(`      registry:   ${d.registry}`);
        console.log(`      discovered: ${d.discovered}`);
      }
    }

    // Recommendations
    if (p.recommendations.length > 0) {
      console.log("  Recommendations:");
      for (const r of p.recommendations) {
        console.log(`    * ${r}`);
      }
    }
  }

  // Summary
  console.log();
  console.log(line);
  console.log("  SUMMARY");
  console.log(line);
  console.log(
    `  Providers with hooks support:       ${report.summary.withHooks.length > 0 ? report.summary.withHooks.join(", ") : "none detected"}`,
  );
  console.log(
    `  Providers with spawn/subagent:      ${report.summary.withSpawn.length > 0 ? report.summary.withSpawn.join(", ") : "none detected"}`,
  );
  console.log(
    `  Providers with capabilities obj:    ${report.summary.withCapabilities.length > 0 ? report.summary.withCapabilities.join(", ") : "none"}`,
  );
  console.log(
    `  Unreachable providers:              ${report.summary.unreachable.length > 0 ? report.summary.unreachable.join(", ") : "none"}`,
  );
  console.log(
    `  Total recommendations:              ${report.summary.recommendationCount}`,
  );
  console.log(line);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      output: { type: "string", short: "o" },
      "generate-prompt": { type: "boolean", default: false },
      "skip-aggregate": { type: "boolean", default: false },
      "skip-readme": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
CAAMP Provider Research Script (v2)

Usage: npx tsx scripts/provider-research.ts [options]

Options:
  -p, --provider <id>     Research a single provider (by registry ID)
  --json                  Output as JSON instead of human-readable
  -v, --verbose           Show detailed fetch logs and extra context
  -o, --output <file>     Write JSON report to file
  --generate-prompt       Output an LLM research prompt instead of a report
  --skip-aggregate        Skip aggregate source fetching
  --skip-readme           Skip per-provider README fetching
  -h, --help              Show this help message

Examples:
  npx tsx scripts/provider-research.ts
  npx tsx scripts/provider-research.ts -p claude-code -v
  npx tsx scripts/provider-research.ts --json -o report.json
  npx tsx scripts/provider-research.ts --generate-prompt -p cursor
  npx tsx scripts/provider-research.ts -p goose --skip-aggregate

All documentation URLs are loaded from scripts/provider-sources.json.
This script NEVER modifies registry.json — read and report only.
`);
    process.exit(0);
  }

  // Load registry
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const registryPath = resolve(scriptDir, "..", "providers", "registry.json");
  const sourcesPath = resolve(scriptDir, "provider-sources.json");

  let registry: Registry;
  try {
    const raw = readFileSync(registryPath, "utf-8");
    registry = JSON.parse(raw) as Registry;
  } catch (err) {
    console.error(
      `Failed to read registry.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  let sourcesConfig: SourcesConfig;
  try {
    const raw = readFileSync(sourcesPath, "utf-8");
    sourcesConfig = JSON.parse(raw) as SourcesConfig;
  } catch (err) {
    console.error(
      `Failed to read provider-sources.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const allProviderIds = Object.keys(registry.providers);

  // Validate provider flag
  if (values.provider && !registry.providers[values.provider]) {
    console.error(
      `Provider "${values.provider}" not found in registry. Available: ${allProviderIds.join(", ")}`,
    );
    process.exit(1);
  }

  // Determine which providers to research
  let targetIds: string[];
  if (values.provider) {
    targetIds = [values.provider];
  } else {
    // Research providers that have documentation sources configured
    targetIds = allProviderIds.filter((id) => sourcesConfig.providers[id]);
  }

  // --- Fetch aggregate sources ---
  let aggregateData: AggregateData[] = [];
  if (!values["skip-aggregate"]) {
    if (!values.json && !values["generate-prompt"]) {
      console.log(
        `Fetching ${sourcesConfig.aggregateSources.length} aggregate source(s)...`,
      );
    }
    aggregateData = await fetchAggregateSources(
      sourcesConfig,
      values.verbose ?? false,
    );
    if (!values.json && !values["generate-prompt"]) {
      console.log(
        `  Parsed ${aggregateData.reduce((s, a) => s + Object.keys(a.agents).length, 0)} agent definition(s) from aggregate sources`,
      );
      console.log();
    }
  }

  // --- Generate LLM prompt mode ---
  if (values["generate-prompt"]) {
    if (!values.provider) {
      console.error("--generate-prompt requires --provider <id>");
      process.exit(1);
    }

    const provider = registry.providers[values.provider]!;
    const sourceEntry = sourcesConfig.providers[values.provider];
    const aggregateFindings = matchAggregateToProvider(
      provider.id,
      provider.aliases,
      aggregateData,
    );

    // Quick README scan for context
    const readmeSources = sourceEntry?.sources ?? [];
    const discovered = values["skip-readme"]
      ? {
          hooks: { detected: false, events: [], contextSnippets: [] },
          spawn: { detected: false, details: [], contextSnippets: [] },
          skills: { pathsFound: [] },
          mcp: { transportsFound: [] },
          instructionFile: null,
          configFormat: null,
          configKey: null,
          errors: [],
        } as DiscoveredCapabilities
      : await researchProviderReadme(
          provider,
          readmeSources,
          values.verbose ?? false,
        );

    const diff = buildDiff(provider, aggregateFindings, discovered);
    const prompt = generateLLMPrompt(
      provider,
      sourceEntry,
      aggregateFindings,
      discovered,
      diff,
    );
    console.log(prompt);
    process.exit(0);
  }

  // --- Standard research mode ---

  if (!values.json) {
    console.log(
      `Researching ${targetIds.length} provider(s) with configured sources...`,
    );
    console.log(
      `(${allProviderIds.length - targetIds.length} provider(s) skipped — no sources configured)`,
    );
    console.log();
  }

  const providerReports: ProviderReport[] = [];

  for (const id of targetIds) {
    const provider = registry.providers[id]!;
    if (!values.json) {
      process.stdout.write(`  Researching ${provider.toolName}...`);
    }

    // Match aggregate data
    const aggregateFindings = matchAggregateToProvider(
      provider.id,
      provider.aliases,
      aggregateData,
    );

    // Fetch and scan README sources
    const sourceEntry = sourcesConfig.providers[id];
    const readmeSources = sourceEntry?.sources ?? [];
    const discovered = values["skip-readme"]
      ? ({
          hooks: { detected: false, events: [], contextSnippets: [] },
          spawn: { detected: false, details: [], contextSnippets: [] },
          skills: { pathsFound: [] },
          mcp: { transportsFound: [] },
          instructionFile: null,
          configFormat: null,
          configKey: null,
          errors: [],
        } as DiscoveredCapabilities)
      : await researchProviderReadme(
          provider,
          readmeSources,
          values.verbose ?? false,
        );

    const diff = buildDiff(provider, aggregateFindings, discovered);
    const recommendations = buildRecommendations(
      provider,
      aggregateFindings,
      discovered,
      diff,
      readmeSources.length,
    );

    providerReports.push({
      id: provider.id,
      toolName: provider.toolName,
      vendor: provider.vendor,
      registrySummary: {
        status: provider.status,
        priority: provider.priority,
        configKey: provider.configKey,
        configFormat: provider.configFormat,
        supportedTransports: provider.supportedTransports,
        supportsHeaders: provider.supportsHeaders,
        agentSkillsCompatible: provider.agentSkillsCompatible,
        instructFile: provider.instructFile,
        capabilities: provider.capabilities,
      },
      aggregateFindings,
      discovered,
      diff,
      recommendations,
    });

    if (!values.json) {
      const errorCount = discovered.errors.length;
      const diffCount = diff.length;
      const aggCount = aggregateFindings.length;
      const status =
        errorCount > 0 && errorCount === readmeSources.length
          ? " unreachable"
          : diffCount > 0
            ? ` ${diffCount} diff(s), ${aggCount} agg`
            : ` ok, ${aggCount} agg`;
      console.log(status);
    }

    // Rate limit between providers
    if (targetIds.indexOf(id) < targetIds.length - 1) {
      await delay(300);
    }
  }

  const report: FullReport = {
    timestamp: new Date().toISOString(),
    registryVersion: registry.version,
    registryLastUpdated: registry.lastUpdated,
    totalProviders: allProviderIds.length,
    researchedProviders: targetIds.length,
    providers: providerReports,
    summary: {
      withHooks: providerReports
        .filter((p) => p.discovered.hooks.detected || p.registrySummary.capabilities?.hooks)
        .map((p) => p.id),
      withSpawn: providerReports
        .filter((p) => p.discovered.spawn.detected || p.registrySummary.capabilities?.spawn)
        .map((p) => p.id),
      withCapabilities: providerReports
        .filter((p) => p.registrySummary.capabilities)
        .map((p) => p.id),
      unreachable: providerReports
        .filter(
          (p) =>
            p.discovered.errors.length > 0 &&
            p.discovered.errors.length ===
              (sourcesConfig.providers[p.id]?.sources.length ?? 0),
        )
        .map((p) => p.id),
      recommendationCount: providerReports.reduce(
        (sum, p) => sum + p.recommendations.length,
        0,
      ),
    },
  };

  if (values.json) {
    const jsonOutput = JSON.stringify(report, null, 2);
    console.log(jsonOutput);
  } else {
    printConsoleReport(report);
  }

  if (values.output) {
    const outputPath = resolve(process.cwd(), values.output);
    writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`JSON report written to: ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(
    `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
