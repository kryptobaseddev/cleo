export type DirectiveType = 'actionable' | 'routing' | 'informational';

export interface ParsedCANTMessage {
  directive?: string;
  directive_type: DirectiveType;
  addresses: string[];
  task_refs: string[];
  tags: string[];
  header_raw: string;
  body: string;
}

/**
 * A single contract clause — a precondition (requires) or postcondition (ensures)
 * on agent behavior, expressed as OpenProse semiformal text.
 *
 * Syntax in .cant file:
 *   contracts:
 *     requires:
 *       - "Task is in started state before work begins"
 *     ensures:
 *       - "Output file written to OUTPUT_PATH before return"
 */
export interface CantContractClause {
  text: string;
  enforcement?: 'hard' | 'soft';
}

/**
 * Paired precondition/postcondition contract block attached to a CANT agent.
 * `requires` clauses MUST hold before agent execution; `ensures` clauses MUST
 * hold on successful return.
 */
export interface CantContractBlock {
  requires: CantContractClause[];
  ensures: CantContractClause[];
}

/**
 * Reference to a mental model slice to load into agent context.
 * `scope` selects project-local vs global mental model store; `maxTokens`
 * bounds the rendered slice; `validateOnLoad` enforces schema checks.
 */
export interface CantMentalModelRef {
  scope: 'project' | 'global';
  maxTokens: number;
  validateOnLoad: boolean;
}

/**
 * Declarative context source binding: a CantContextSourceDef instructs the
 * composer to query `source` with `query` and inject up to `maxEntries`
 * results into the agent's spawn payload context.
 */
export interface CantContextSourceDef {
  source: string;
  query: string;
  maxEntries: number;
}

/**
 * Strategy the composer applies when the rendered agent payload exceeds the
 * tier token cap. `escalate_tier` promotes to the next tier; `fail` aborts.
 */
export type CantOverflowStrategy = 'escalate_tier' | 'fail';

/**
 * Agent capability tier. Tier selection drives token budgets, tool
 * allowlists, and hierarchical spawn permissions.
 */
export type CantTier = 'low' | 'mid' | 'high';

/**
 * Filesystem permission ACL for an agent — separate read, write, and execute
 * globs. Paths are evaluated against the spawning project root.
 */
export interface CantPathPermissions {
  read?: string[];
  write?: string[];
  execute?: string[];
}

/**
 * Fully-typed CANT agent DSL v3 record. Represents the complete parsed shape
 * of an agent declared in a `.cant` file with `kind: agent`. Consumed by the
 * bundle compiler, composer, and spawn pipeline.
 */
export interface CantAgentV3 {
  name: string;
  sourcePath: string;
  version: string;
  role: string;
  description: string;
  prompt: string;
  skills: string[];
  permissions: Record<string, string>;
  model?: string;
  persist?: boolean | string;
  parent?: string;
  filePermissions?: CantPathPermissions;
  tier: CantTier;
  contextSources: CantContextSourceDef[];
  onOverflow: CantOverflowStrategy;
  mentalModelRef: CantMentalModelRef | null;
  contracts: CantContractBlock;
  consultWhen?: string;
  workers?: string[];
  stages?: string[];
  tools?: Record<string, string[]>;
  deprecated?: boolean;
  supersededBy?: string;
}

/**
 * Structural type guard for `CantAgentV3`. Validates the required surface
 * (name, sourcePath, version, role, description, prompt, skills,
 * permissions, tier, contextSources, contracts). Returns `true` when `x`
 * safely narrows to `CantAgentV3`.
 */
export function isCantAgentV3(x: unknown): x is CantAgentV3 {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.sourcePath === 'string' &&
    typeof o.version === 'string' &&
    typeof o.role === 'string' &&
    typeof o.description === 'string' &&
    typeof o.prompt === 'string' &&
    Array.isArray(o.skills) &&
    typeof o.permissions === 'object' &&
    o.permissions !== null &&
    typeof o.tier === 'string' &&
    ['low', 'mid', 'high'].includes(o.tier as string) &&
    Array.isArray(o.contextSources) &&
    typeof o.contracts === 'object' &&
    o.contracts !== null
  );
}
