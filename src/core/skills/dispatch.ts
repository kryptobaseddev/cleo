/**
 * Skill dispatch and protocol selection.
 * Augments CLEO's multi-strategy dispatch with @cleocode/caamp catalog dispatch matrix.
 *
 * Implements multi-strategy dispatch:
 *   1. Label-based: task labels match skill tags
 *   2. Catalog-based: ct-skills dispatch matrix (via CAAMP catalog bridge)
 *   3. Type-based: task type maps to protocol
 *   4. Keyword-based: title/description matches triggers
 *   5. Fallback: ct-task-executor
 *
 * @epic T4454
 * @task T4517
 */

import { catalog } from '@cleocode/caamp';
import type { CtDispatchMatrix } from '@cleocode/caamp';
import type { Task } from '../../types/task.js';
import type {
  DispatchResult,
  Skill,
  SkillProtocolType,
} from './types.js';
import { discoverAllSkills, findSkill } from './discovery.js';
import { injectTokens } from './injection/token.js';

// ============================================================================
// Keyword Dispatch Map
// ============================================================================

/** Keyword patterns mapped to skill names. */
const KEYWORD_DISPATCH: Array<{ pattern: RegExp; skill: string; protocol?: SkillProtocolType }> = [
  { pattern: /\b(research|investigate|explore|analyze|study)\b/i, skill: 'ct-research-agent', protocol: 'research' },
  { pattern: /\b(spec|rfc|design|specification)\b/i, skill: 'ct-spec-writer', protocol: 'specification' },
  { pattern: /\b(epic|plan|decompose|breakdown)\b/i, skill: 'ct-epic-architect', protocol: 'decomposition' },
  { pattern: /\b(implement|build|create|code|develop)\b/i, skill: 'ct-library-implementer-bash', protocol: 'implementation' },
  { pattern: /\b(test|bats|testing|unit test)\b/i, skill: 'ct-test-writer-bats' },
  { pattern: /\b(validate|check|verify|audit)\b/i, skill: 'ct-validator' },
  { pattern: /\b(doc|document|documentation|write docs)\b/i, skill: 'ct-documentor' },
  { pattern: /\b(vote|consensus|decide)\b/i, skill: 'ct-task-executor', protocol: 'consensus' },
  { pattern: /\b(release|version|publish)\b/i, skill: 'ct-task-executor', protocol: 'release' },
  { pattern: /\b(pr|merge|contribution|shared)\b/i, skill: 'ct-task-executor', protocol: 'contribution' },
];

/** Type-to-protocol mapping. */
const TYPE_PROTOCOL_MAP: Record<string, { skill: string; protocol: SkillProtocolType }> = {
  research: { skill: 'ct-research-agent', protocol: 'research' },
  consensus: { skill: 'ct-task-executor', protocol: 'consensus' },
  specification: { skill: 'ct-spec-writer', protocol: 'specification' },
  decomposition: { skill: 'ct-epic-architect', protocol: 'decomposition' },
  implementation: { skill: 'ct-library-implementer-bash', protocol: 'implementation' },
  contribution: { skill: 'ct-task-executor', protocol: 'contribution' },
  release: { skill: 'ct-task-executor', protocol: 'release' },
};

// ============================================================================
// Catalog Dispatch Matrix (from ct-skills via CAAMP)
// ============================================================================

/** Cached dispatch matrix from the ct-skills catalog. */
let _catalogMatrix: CtDispatchMatrix | null = null;

/**
 * Get the catalog dispatch matrix, caching on first access.
 * Returns null if ct-skills catalog is unavailable.
 */
function getCatalogMatrix(): CtDispatchMatrix | null {
  if (_catalogMatrix !== null) return _catalogMatrix;

  try {
    _catalogMatrix = catalog.getDispatchMatrix();
    return _catalogMatrix;
  } catch {
    return null;
  }
}

// ============================================================================
// Dispatch Strategies
// ============================================================================

/**
 * Attempt label-based dispatch: match task labels against skill tags.
 * @task T4517
 */
function dispatchByLabels(task: Task, skills: Skill[]): DispatchResult | null {
  const labels = task.labels ?? [];
  if (labels.length === 0) return null;

  const labelSet = new Set(labels.map(l => l.toLowerCase()));

  for (const skill of skills) {
    const tags = skill.frontmatter.tags ?? [];
    for (const tag of tags) {
      if (labelSet.has(tag.toLowerCase())) {
        return {
          skill: skill.dirName,
          strategy: 'label',
          confidence: 0.9,
          protocol: skill.frontmatter.protocol,
        };
      }
    }
  }

  return null;
}

/**
 * Attempt catalog-based dispatch: use ct-skills dispatch matrix.
 * Checks by_task_type and by_keyword from the catalog.
 * @task T4517
 */
function dispatchByCatalog(task: Task): DispatchResult | null {
  const matrix = getCatalogMatrix();
  if (!matrix) return null;

  // Check by task type if available
  const taskType = (task as unknown as Record<string, unknown>)['type'] as string | undefined;
  if (taskType && matrix.by_task_type[taskType]) {
    const skillName = matrix.by_task_type[taskType];
    const protocol = matrix.by_protocol[taskType] as SkillProtocolType | undefined;
    return {
      skill: skillName,
      strategy: 'type',
      confidence: 0.85,
      protocol,
    };
  }

  // Check by keyword in title/description
  const searchText = `${task.title} ${task.description ?? ''}`.toLowerCase();
  for (const [keyword, skillName] of Object.entries(matrix.by_keyword)) {
    if (searchText.includes(keyword.toLowerCase())) {
      const protocol = matrix.by_protocol[keyword] as SkillProtocolType | undefined;
      return {
        skill: skillName,
        strategy: 'keyword',
        confidence: 0.75,
        protocol,
      };
    }
  }

  return null;
}

/**
 * Attempt type-based dispatch: map task type to protocol.
 * @task T4517
 */
function dispatchByType(task: Task): DispatchResult | null {
  // Look for type indicators in labels or description
  const taskType = (task as unknown as Record<string, unknown>)['type'] as string | undefined;
  if (!taskType) return null;

  const mapping = TYPE_PROTOCOL_MAP[taskType.toLowerCase()];
  if (mapping) {
    return {
      skill: mapping.skill,
      strategy: 'type',
      confidence: 0.85,
      protocol: mapping.protocol,
    };
  }

  return null;
}

/**
 * Attempt keyword-based dispatch: match title/description against trigger patterns.
 * @task T4517
 */
function dispatchByKeyword(task: Task): DispatchResult | null {
  const searchText = `${task.title} ${task.description ?? ''}`;

  for (const entry of KEYWORD_DISPATCH) {
    if (entry.pattern.test(searchText)) {
      return {
        skill: entry.skill,
        strategy: 'keyword',
        confidence: 0.7,
        protocol: entry.protocol,
      };
    }
  }

  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Auto-dispatch a task to the most appropriate skill.
 * Tries strategies in priority order: label -> catalog -> type -> keyword -> fallback.
 * @task T4517
 */
export function autoDispatch(task: Task, cwd?: string): DispatchResult {
  const skills = discoverAllSkills(cwd);

  // Strategy 1: Label-based
  const labelResult = dispatchByLabels(task, skills);
  if (labelResult) return labelResult;

  // Strategy 2: Catalog-based (ct-skills dispatch matrix via CAAMP)
  const catalogResult = dispatchByCatalog(task);
  if (catalogResult) return catalogResult;

  // Strategy 3: Type-based
  const typeResult = dispatchByType(task);
  if (typeResult) return typeResult;

  // Strategy 4: Keyword-based
  const keywordResult = dispatchByKeyword(task);
  if (keywordResult) return keywordResult;

  // Strategy 5: Fallback
  return {
    skill: 'ct-task-executor',
    strategy: 'fallback',
    confidence: 0.5,
  };
}

/**
 * Dispatch with explicit skill override.
 * Verifies the skill exists before returning.
 * @task T4517
 */
export function dispatchExplicit(skillName: string, cwd?: string): DispatchResult | null {
  const skill = findSkill(skillName, cwd);
  if (!skill) return null;

  return {
    skill: skill.dirName,
    strategy: 'label', // Explicit is highest confidence
    confidence: 1.0,
    protocol: skill.frontmatter.protocol,
  };
}

/**
 * Get the protocol type for a dispatch result.
 * @task T4517
 */
export function getProtocolForDispatch(result: DispatchResult): SkillProtocolType | null {
  return result.protocol ?? null;
}

/**
 * Prepare spawn context for a dispatched skill.
 * Returns the skill name and protocol needed for token injection.
 * @task T4517
 */
export function prepareSpawnContext(
  task: Task,
  overrideSkill?: string,
  cwd?: string,
): { skill: string; protocol: SkillProtocolType | null; dispatch: DispatchResult } {
  const dispatch = overrideSkill
    ? dispatchExplicit(overrideSkill, cwd) ?? autoDispatch(task, cwd)
    : autoDispatch(task, cwd);

  return {
    skill: dispatch.skill,
    protocol: getProtocolForDispatch(dispatch),
    dispatch,
  };
}

// ============================================================================
// Multi-Skill Composition
// ============================================================================

/** Result of multi-skill composition. */
export interface MultiSkillComposition {
  skillCount: number;
  primarySkill: string;
  skills: Array<{
    skill: string;
    mode: 'full' | 'progressive';
    estimatedTokens: number;
  }>;
  totalEstimatedTokens: number;
  prompt: string;
}

/**
 * Load a skill in progressive mode: frontmatter + first section only.
 * @task T4712
 * @epic T4663
 */
function loadProgressive(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inFrontmatter = false;
  let afterFrontmatter = false;
  let inFirstSection = false;

  for (const line of lines) {
    if (line.trim() === '---' && !inFrontmatter && !afterFrontmatter) {
      inFrontmatter = true;
      result.push(line);
      continue;
    }
    if (line.trim() === '---' && inFrontmatter) {
      inFrontmatter = false;
      afterFrontmatter = true;
      result.push(line);
      result.push('');
      continue;
    }
    if (inFrontmatter) {
      result.push(line);
      continue;
    }
    if (afterFrontmatter && /^##? /.test(line) && !inFirstSection) {
      inFirstSection = true;
      result.push(line);
      continue;
    }
    if (afterFrontmatter && /^##? /.test(line) && inFirstSection) {
      break;
    }
    if (inFirstSection) {
      result.push(line);
    }
  }

  result.push('');
  result.push('> **Note**: This skill is loaded in progressive mode. Request full content if needed.');

  return result.join('\n');
}

/**
 * Compose multiple skills into a single prompt with progressive disclosure.
 * Ports skill_prepare_spawn_multi from lib/skills/skill-dispatch.sh.
 *
 * The first skill is loaded fully (primary). Secondary skills use progressive
 * disclosure (frontmatter + first section only) to save context budget.
 *
 * @task T4712
 * @epic T4663
 */
export function prepareSpawnMulti(
  skillNames: string[],
  tokenValues: Record<string, string>,
  cwd?: string,
): MultiSkillComposition {
  if (skillNames.length === 0) {
    throw new Error('At least one skill required for multi-skill composition');
  }

  const primarySkill = skillNames[0];
  const skillEntries: MultiSkillComposition['skills'] = [];
  const promptParts: string[] = [];
  let totalTokens = 0;

  for (let i = 0; i < skillNames.length; i++) {
    const skillName = skillNames[i];
    const isPrimary = i === 0;

    const skill = findSkill(skillName, cwd);
    if (!skill || !skill.content) {
      continue;
    }

    // Primary: full content. Secondary: progressive disclosure.
    let content = isPrimary ? skill.content : loadProgressive(skill.content);

    // Inject tokens
    content = injectTokens(content, tokenValues);

    const estimatedTokens = Math.ceil(content.length / 4);
    totalTokens += estimatedTokens;

    skillEntries.push({
      skill: skillName,
      mode: isPrimary ? 'full' : 'progressive',
      estimatedTokens,
    });

    promptParts.push(`\n---\n\n## Skill: ${skillName}\n\n${content}`);
  }

  const prompt = `## Skills Loaded (${skillNames.length} total)\n${promptParts.join('\n')}`;

  return {
    skillCount: skillEntries.length,
    primarySkill,
    skills: skillEntries,
    totalEstimatedTokens: totalTokens,
    prompt,
  };
}

