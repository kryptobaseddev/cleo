/**
 * Task atomicity checker — 6-point heuristic test for decomposition quality.
 * Used by orchestrator gating and protocol validators.
 *
 * @epic T4454
 * @task T5001
 */
import type { Task } from '../../types/task.js';

export interface AtomicityResult {
  score: number;        // 0–6
  passed: boolean;      // score >= threshold
  violations: string[]; // names of failed criteria
}

export const ATOMICITY_CRITERIA = [
  'single-file-scope',
  'single-cognitive-concern',
  'clear-acceptance-criteria',
  'no-context-switching',
  'no-hidden-decisions',
  'programmatic-validation-possible',
] as const;

export type AtomicityCriterion = typeof ATOMICITY_CRITERIA[number];

const ACTION_VERBS = /\b(add|create|update|fix|refactor)\b/gi;

const ACCEPTANCE_KEYWORDS =
  /\b(must|should|acceptance|criteria|verify|test|passes when|done when)\b/i;

const DOMAIN_KEYWORDS = [
  'frontend', 'backend', 'database', 'api', 'ui', 'cli', 'mcp', 'test', 'docs',
] as const;

const HIDDEN_DECISION_KEYWORDS =
  /\b(decide|choose|pick|tbd|todo|unclear|figure out|determine)\b/i;

const VALIDATION_KEYWORDS =
  /\b(test|spec|assert|verify|check|validate|returns|output)\b/i;

function countFileExtensions(text: string): number {
  const matches = text.match(/\.(ts|js|json)\b/g);
  return matches ? matches.length : 0;
}

function countActionVerbs(text: string): number {
  const matches = text.match(ACTION_VERBS);
  return matches ? new Set(matches.map(v => v.toLowerCase())).size : 0;
}

function countDomainKeywords(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of DOMAIN_KEYWORDS) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

/**
 * Check task atomicity using 6-point heuristic test.
 * Default threshold: 4 (passing requires >= 4/6 criteria met).
 */
export function checkAtomicity(task: Task, threshold = 4): AtomicityResult {
  const description = task.description ?? '';
  const title = task.title ?? '';
  const combined = `${title} ${description}`;

  const violations: string[] = [];

  // single-file-scope: description < 500 chars OR <= 3 file-extension mentions
  if (description.length >= 500 && countFileExtensions(description) > 3) {
    violations.push('single-file-scope');
  }

  // single-cognitive-concern: title doesn't have " and "/" & "/" + " and <= 1 action verb
  const hasConjunction = /\band\b|\s&\s|\s\+\s/i.test(title);
  const actionVerbCount = countActionVerbs(title);
  if (hasConjunction || actionVerbCount > 1) {
    violations.push('single-cognitive-concern');
  }

  // clear-acceptance-criteria: description contains acceptance-related keywords
  if (!ACCEPTANCE_KEYWORDS.test(description)) {
    violations.push('clear-acceptance-criteria');
  }

  // no-context-switching: <= 2 distinct domain keywords in title + description
  if (countDomainKeywords(combined) > 2) {
    violations.push('no-context-switching');
  }

  // no-hidden-decisions: description doesn't contain decision/uncertainty keywords
  if (HIDDEN_DECISION_KEYWORDS.test(description)) {
    violations.push('no-hidden-decisions');
  }

  // programmatic-validation-possible: description contains validation keywords
  if (!VALIDATION_KEYWORDS.test(description)) {
    violations.push('programmatic-validation-possible');
  }

  const score = ATOMICITY_CRITERIA.length - violations.length;

  return {
    score,
    passed: score >= threshold,
    violations,
  };
}
