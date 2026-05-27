/**
 * Agent scaffold — persona.cant / manifest.json / team-config generation.
 *
 * Extracted from `cleo agent create` (packages/cleo). Contains all role-based
 * template helpers and the directory-creation logic. CLI remains a thin wrapper
 * that calls `scaffoldAgent` and emits the LAFS envelope.
 *
 * @module agents/scaffold
 * @epic T9833
 * @task T10062
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid agent roles for template generation. */
export type AgentRole = 'orchestrator' | 'lead' | 'worker' | 'docs-worker';

/** Parameters accepted by {@link scaffoldAgent}. */
export interface ScaffoldAgentParams {
  name: string;
  role: string;
  /** Defaults to role-inferred value when omitted. */
  tier?: string;
  team?: string;
  domain?: string;
  parent?: string;
  /**
   * Install into the global XDG-data agents tier instead of the project tree.
   */
  global?: boolean;
  /** Whether to create `expertise/mental-model-seed.md` and seed BRAIN. */
  seedBrain?: boolean;
  /**
   * Absolute project root — required when `global` is false.
   * Used to resolve `.cleo/cant/agents/`.
   */
  projectRoot?: string;
  /**
   * CLEO directory name inside the project root (default: `.cleo`).
   */
  cleoDirName?: string;
  /** Sub-directory under `.cleo` for CANT agent definitions. */
  cantAgentsSubdir?: string;
}

/** Result of a successful scaffold operation. */
export interface ScaffoldAgentResult {
  agent: string;
  role: string;
  tier: string;
  directory: string;
  scope: 'global' | 'project';
  files: string[];
  registered: false;
  brainSeeded: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scaffold a new agent package on disk.
 *
 * Creates the agent directory, `persona.cant`, `manifest.json`, an optional
 * `team-config.cant`, and an optional mental-model seed. Does NOT register
 * the agent in the SignalDock registry — the CLI handler handles that as a
 * best-effort step.
 *
 * @param params - Scaffold parameters
 * @returns Metadata about the created files
 * @throws {Error} When the directory already exists or validation fails
 */
export function scaffoldAgent(params: ScaffoldAgentParams): ScaffoldAgentResult {
  const {
    name,
    role,
    team,
    domain,
    parent,
    global: isGlobal = false,
    seedBrain = false,
    projectRoot,
    cleoDirName = '.cleo',
    cantAgentsSubdir = 'cant/agents',
  } = params;

  const tier = params.tier ?? inferTierFromRole(role);

  validateRole(role);
  validateTier(tier);
  validateName(name);

  const targetRoot = resolveTargetRoot({ isGlobal, projectRoot, cleoDirName, cantAgentsSubdir });
  const agentDir = join(targetRoot, name);

  if (existsSync(agentDir)) {
    throw new Error(`Agent directory already exists: ${agentDir}`);
  }

  mkdirSync(agentDir, { recursive: true });

  const personaContent = generatePersonaCant({ name, role, tier, team, domain, parent });
  const personaPath = join(agentDir, 'persona.cant');
  writeFileSync(personaPath, personaContent, 'utf-8');

  const manifest = generateManifest({ name, role, tier, domain });
  const manifestPath = join(agentDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const createdFiles: string[] = [personaPath, manifestPath];

  if (team) {
    const teamConfigPath = join(agentDir, 'team-config.cant');
    writeFileSync(teamConfigPath, generateTeamConfig(name, role, team), 'utf-8');
    createdFiles.push(teamConfigPath);
  }

  if (seedBrain) {
    const expertiseDir = join(agentDir, 'expertise');
    mkdirSync(expertiseDir, { recursive: true });
    const seedPath = join(expertiseDir, 'mental-model-seed.md');
    writeFileSync(seedPath, generateMentalModelSeed(name, role, domain), 'utf-8');
    createdFiles.push(seedPath);
  }

  return {
    agent: name,
    role,
    tier,
    directory: agentDir,
    scope: isGlobal ? 'global' : 'project',
    files: createdFiles,
    registered: false,
    brainSeeded: seedBrain,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ROLES: AgentRole[] = ['orchestrator', 'lead', 'worker', 'docs-worker'];
const VALID_TIERS = ['low', 'mid', 'high'];

/** @throws {Error} when role is not in {@link VALID_ROLES}. */
export function validateRole(role: string): void {
  if (!VALID_ROLES.includes(role as AgentRole)) {
    throw new Error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`);
  }
}

/** @throws {Error} when tier is not in `['low', 'mid', 'high']`. */
export function validateTier(tier: string): void {
  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Must be one of: ${VALID_TIERS.join(', ')}`);
  }
}

/** @throws {Error} when name is not kebab-case. */
export function validateName(name: string): void {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(
      `Agent name must be kebab-case: "${name}". Use lowercase letters, numbers, and hyphens.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface ResolveTargetRootOpts {
  isGlobal: boolean;
  projectRoot?: string;
  cleoDirName: string;
  cantAgentsSubdir: string;
}

function resolveTargetRoot(opts: ResolveTargetRootOpts): string {
  if (opts.isGlobal) {
    return join(getCleoHome(), 'cant', 'agents');
  }
  if (!opts.projectRoot) {
    throw new Error('projectRoot is required for non-global agent scaffold');
  }
  return join(opts.projectRoot, opts.cleoDirName, opts.cantAgentsSubdir);
}

// ---------------------------------------------------------------------------
// Tier inference
// ---------------------------------------------------------------------------

/**
 * Infer the default tier from the agent role.
 *
 * - `orchestrator` → `high`
 * - everything else → `mid`
 */
export function inferTierFromRole(role: string): string {
  return role === 'orchestrator' ? 'high' : 'mid';
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

interface PersonaParams {
  name: string;
  role: string;
  tier: string;
  team?: string;
  domain?: string;
  parent?: string;
}

interface ManifestParams {
  name: string;
  role: string;
  tier: string;
  domain?: string;
}

/**
 * Generate `persona.cant` content from role-based templates.
 *
 * @see packages/cleo-os/starter-bundle/agents/ — canonical format reference
 */
export function generatePersonaCant(params: PersonaParams): string {
  const { name, role, tier, team, domain, parent } = params;
  switch (role as AgentRole) {
    case 'orchestrator':
      return generateOrchestratorPersona(name, tier, team, parent);
    case 'lead':
      return generateLeadPersona(name, tier, team, domain, parent);
    case 'docs-worker':
      return generateDocsWorkerPersona(name, tier, team, domain, parent);
    default:
      return generateWorkerPersona(name, tier, team, domain, parent);
  }
}

/** Generate `persona.cant` for the `orchestrator` role. */
export function generateOrchestratorPersona(
  name: string,
  tier: string,
  team?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '';
  const teamComment = team ? `\n# Team: ${team}` : '';
  return `---
kind: agent
version: "1"
---

# ${name} — orchestrator agent.${teamComment}
# Coordinates the team, classifies work, dispatches to leads/workers.

agent ${name}:
  role: orchestrator${parentLine}
  tier: ${tier}
  description: "Orchestrator agent. Reads task context, classifies work, dispatches to leads, and synthesizes results. Does not execute code — coordinates."
  consult-when: "Cross-team decisions, scope changes, human-in-the-loop escalation, or when a lead reports a blocking ambiguity"

  context_sources:
    - source: decisions
      query: "recent architectural and project decisions"
      max_entries: 5
    - source: patterns
      query: "project conventions and established patterns"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 2000
    on_load:
      validate: true

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write

  skills:
    - ct-cleo
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_user]

  on SessionStart:
    session "Read active tasks and recent decisions to build situational awareness"
      context: [active-tasks, memory-bridge, recent-decisions]

  on TaskCompleted:
    if **the completed task unblocks downstream work**:
      session "Reassess task queue and dispatch next work"
`;
}

/** Generate `persona.cant` for the `lead` role. */
export function generateLeadPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: project-orchestrator';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain}.` : '';
  return `---
kind: agent
version: "1"
---

# ${name} — lead agent.${teamComment}
# Decomposes tasks, reviews worker output, decides technical approach.
# MUST NOT hold Edit/Write/Bash tools (TEAM-002 / ULTRAPLAN 10.3).

agent ${name}:
  role: lead${parentLine}
  tier: ${tier}
  description: "Development lead.${domainDesc} Decomposes tasks into concrete implementation steps, reviews worker output, and decides technical approach. Does not write code directly."
  consult-when: "Implementation strategy, code architecture, refactoring direction, task decomposition, or when workers need clarification"

  context_sources:
    - source: patterns
      query: "codebase conventions and architecture patterns"
      max_entries: 5
    - source: decisions
      query: "technical decisions affecting implementation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      read: ["**/*"]

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_orchestrator]

  on SessionStart:
    session "Review current task assignments and worker availability"
      context: [active-tasks, memory-bridge]

  on TaskCompleted:
    if **the completed task introduced new code**:
      session "Review worker output for quality and completeness before reporting to orchestrator"
`;
}

/** Generate `persona.cant` for the `worker` role. */
export function generateWorkerPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: dev-lead';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain}.` : '';
  const writeGlobs = deriveWriteGlobs(domain);
  return `---
kind: agent
version: "1"
---

# ${name} — worker agent.${teamComment}
# Executes code changes within declared file globs.

agent ${name}:
  role: worker${parentLine}
  tier: ${tier}
  description: "Code worker.${domainDesc} Reads requirements, writes code, runs tests, and validates changes. Operates within declared file permission globs."
  consult-when: "Writing code, fixing bugs, running tests, formatting, or any file modification task"

  context_sources:
    - source: patterns
      query: "coding conventions and testing patterns"
      max_entries: 5
    - source: learnings
      query: "past implementation mistakes and fixes"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ${JSON.stringify(writeGlobs)}
      read: ["**/*"]
      delete: ${JSON.stringify(writeGlobs)}

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned task and read relevant source files before starting work"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify the change compiles and passes lint before proceeding"
`;
}

/** Generate `persona.cant` for the `docs-worker` role. */
export function generateDocsWorkerPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: dev-lead';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain} documentation.` : '';
  return `---
kind: agent
version: "1"
---

# ${name} — documentation worker agent.${teamComment}
# Writes and maintains documentation within declared globs.

agent ${name}:
  role: worker${parentLine}
  tier: ${tier}
  description: "Documentation worker.${domainDesc} Writes READMEs, updates guides, adds TSDoc comments, and maintains project documentation. Operates within declared documentation file globs."
  consult-when: "Writing documentation, updating READMEs, adding TSDoc comments, or improving existing docs"

  context_sources:
    - source: patterns
      query: "documentation conventions and style patterns"
      max_entries: 3
    - source: decisions
      query: "architectural decisions needing documentation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ["docs/**", "**/*.md", "**/*.mdx"]
      read: ["**/*"]
      delete: ["docs/**"]

  skills:
    - ct-cleo
    - ct-documentor
    - ct-docs-write

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned documentation task and review existing docs for context"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify markdown renders correctly and follows project style conventions"
`;
}

/**
 * Derive file write globs from a domain description string.
 *
 * Maps common domain keywords to appropriate file glob patterns.
 * Falls back to the project-wide defaults when no domain is specified.
 */
export function deriveWriteGlobs(domain?: string): string[] {
  const defaults = ['src/**', 'packages/**', 'lib/**', 'test/**', 'tests/**'];
  if (!domain) return defaults;
  const lower = domain.toLowerCase();
  if (lower.includes('frontend') || lower.includes('ui') || lower.includes('component')) {
    return ['src/**', 'packages/**', 'components/**', 'styles/**', 'public/**', 'test/**'];
  }
  if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) {
    return ['src/**', 'packages/**', 'lib/**', 'api/**', 'test/**', 'tests/**'];
  }
  if (lower.includes('infra') || lower.includes('deploy') || lower.includes('ci')) {
    return ['.github/**', 'infra/**', 'deploy/**', 'scripts/**', 'Dockerfile*'];
  }
  if (lower.includes('test') || lower.includes('qa') || lower.includes('quality')) {
    return ['test/**', 'tests/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'packages/**/*.test.*'];
  }
  if (lower.includes('rust') || lower.includes('crate')) {
    return ['crates/**', 'src/**', 'Cargo.toml', 'test/**'];
  }
  if (lower.includes('doc')) {
    return ['docs/**', '**/*.md', '**/*.mdx'];
  }
  return defaults;
}

/**
 * Generate a `manifest.json` object conforming to CANTZ-PACKAGE-STANDARD.md §2.3.
 */
export function generateManifest(params: ManifestParams): Record<string, unknown> {
  return {
    name: params.name,
    version: '1.0.0',
    description: `${capitalizeFirst(params.role)} agent${params.domain ? ` for ${params.domain}` : ''}`,
    cant: {
      minVersion: '1',
      tier: params.tier,
      role: params.role === 'docs-worker' ? 'worker' : params.role,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate a `team-config.cant` fragment declaring the agent's team membership.
 */
export function generateTeamConfig(name: string, role: string, team: string): string {
  return `---
kind: team-config
version: "1"
---

# Team membership for ${name}

team ${team}:
  member ${name}:
    role: ${role}
    status: active
`;
}

/**
 * Generate a mental-model seed markdown file for BRAIN seeding.
 */
export function generateMentalModelSeed(name: string, role: string, domain?: string): string {
  const domainSection = domain
    ? `## Domain\n\n${domain}\n`
    : `## Domain\n\nTODO: Describe the domain this agent specializes in.\n`;
  return `# Mental Model Seed: ${name}

> Auto-generated at ${new Date().toISOString()}
> Role: ${role}

${domainSection}
## Key Patterns

TODO: Document recurring patterns this agent should recognize.

## Known Pitfalls

TODO: Document common mistakes or anti-patterns in this domain.

## Decision History

TODO: Track important decisions and their rationale.

## Learning Log

TODO: Record discoveries and insights as the agent operates.
`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Capitalize the first character of a string. */
function capitalizeFirst(str: string): string {
  if (str.length === 0) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
