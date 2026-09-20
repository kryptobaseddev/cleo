/**
 * Orchestrator protocol validation against canonical current evidence or an
 * explicitly selected historical JSONL file. Historical validation is never
 * presented as verification of the current authoritative store.
 * @task T12282
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MANIFEST_STATUSES } from '@cleocode/contracts';
import { z } from 'zod';
import { EngineResultError } from '../../engine-result.js';
import {
  pipelineManifestShow,
  readManifestEntries,
} from '../../memory/pipeline-manifest-sqlite.js';
import { getAgentOutputsAbsolute, getProjectRoot } from '../../paths.js';
import { captureProjectScope, worktreeScope } from '../../project-scope.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import type { ComplianceResult, ManifestEntry, ManifestValidationResult } from '../types.js';

const KEY_FINDINGS_MIN = 3;
const KEY_FINDINGS_MAX = 7;
const VALID_STATUSES_SET = new Set(MANIFEST_STATUSES);
const CHECKED_RULES = [
  'MANIFEST_ENTRY_EXISTS',
  'REQUIRED_FIELDS_PRESENT',
  'STATUS_VALID_ENUM',
  'KEY_FINDINGS_COUNT_3_7',
  'DATE_ISO_8601',
  'TOPICS_ARRAY_NON_EMPTY',
  'NEEDS_FOLLOWUP_ARRAY',
  'ACTIONABLE_BOOLEAN',
  'OUTPUT_FILE_EXISTS',
];
const historicalEntrySchema = z.looseObject({
  id: z.string().min(1),
  file: z.string().min(1),
  title: z.string().min(1),
  date: z.string().min(1),
  status: z.enum(MANIFEST_STATUSES),
  agent_type: z.string().optional(),
  topics: z.array(z.string()),
  key_findings: z.array(z.string()),
  actionable: z.boolean(),
  needs_followup: z.array(z.string()),
  linked_tasks: z.array(z.string()).optional(),
});

function currentSourceIssue(method: string): string {
  return `CURRENT_MANIFEST_REQUIRES_ASYNC: Use ${method} for the authoritative store, or explicitly select a historicalManifestPath.`;
}

function readHistoricalEntries(cwd: string | undefined, manifestPath: string) {
  const entries: ManifestEntry[] = [];
  const issues: string[] = [];
  let content: string;
  try {
    content = readFileSync(resolve(cwd ?? process.cwd(), manifestPath), 'utf8');
  } catch (error) {
    issues.push(
      `HISTORICAL_MANIFEST_READ_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exists: false, entries, issues, totalLines: 0, invalidEntries: 0 };
  }
  let totalLines = 0;
  let invalidEntries = 0;
  const seen = new Set<string>();
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    totalLines++;
    try {
      const parsed = historicalEntrySchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        issues.push(`LINE_${index + 1}_INVALID_ENTRY: ${parsed.error.message}`);
        invalidEntries++;
        continue;
      }
      if (seen.has(parsed.data.id)) {
        issues.push(`LINE_${index + 1}_DUPLICATE_ID: ${parsed.data.id}`);
        invalidEntries++;
        continue;
      }
      seen.add(parsed.data.id);
      entries.push(parsed.data);
    } catch (error) {
      issues.push(
        `LINE_${index + 1}_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      invalidEntries++;
    }
  }
  if (totalLines === 0) issues.push('MANIFEST_EMPTY: Selected historical file has no evidence');
  return { exists: true, entries, issues, totalLines, invalidEntries };
}

function entryIssues(entry: ManifestEntry | undefined, researchId: string): string[] {
  if (!entry) return [`MANIFEST_ENTRY_MISSING: No manifest entry found for id=${researchId}`];
  const issues: string[] = [];
  for (const field of ['id', 'file', 'title', 'date'] as const) {
    if (!entry[field]) issues.push(`MISSING_FIELD: ${field}`);
  }
  if (!VALID_STATUSES_SET.has(entry.status)) issues.push(`INVALID_STATUS: ${entry.status}`);
  if (
    entry.key_findings.length < KEY_FINDINGS_MIN ||
    entry.key_findings.length > KEY_FINDINGS_MAX
  ) {
    issues.push(
      `KEY_FINDINGS_COUNT: count=${entry.key_findings.length} (must be ${KEY_FINDINGS_MIN}-${KEY_FINDINGS_MAX})`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) issues.push(`INVALID_DATE: ${entry.date}`);
  if (entry.topics.length === 0) issues.push('TOPICS_EMPTY: topics must be a non-empty array');
  return issues;
}

function historicalOutputIssue(entry: ManifestEntry, cwd?: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(entry.file)) {
    return `HISTORICAL_OUTPUT_REQUIRES_ASYNC: Cannot resolve ${entry.file} as an explicit historical file`;
  }
  try {
    const scope = captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
    const outputRoot = worktreeScope.run(scope, () => getAgentOutputsAbsolute(scope.worktreeRoot));
    readFileSync(join(outputRoot, entry.file));
    return null;
  } catch (error) {
    return `OUTPUT_FILE_READ_FAILED: ${entry.file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function selectedEntry(entries: ManifestEntry[], taskId: string, researchId?: string) {
  return researchId
    ? entries.find((entry) => entry.id === researchId)
    : entries.find((entry) => entry.linked_tasks?.includes(taskId));
}

function complianceResult(
  taskId: string,
  entry: ManifestEntry | undefined,
  issues: string[],
): ComplianceResult {
  const violations = [...issues];
  const researchLinkedToTask = entry?.linked_tasks?.includes(taskId) ?? false;
  if (entry && !researchLinkedToTask)
    violations.push(`RESEARCH_NOT_LINKED: ${entry.id} is not linked to ${taskId}`);
  const returnStatusValid = entry ? VALID_STATUSES_SET.has(entry.status) : null;
  if (returnStatusValid === false) violations.push(`INVALID_MANIFEST_STATUS: ${entry?.status}`);
  return {
    previousTaskId: taskId,
    researchId: entry?.id ?? null,
    checks: { manifestEntryExists: !!entry, researchLinkedToTask, returnStatusValid },
    canSpawnNext: violations.length === 0,
    violations,
    warnings: [],
  };
}

function currentRoot(cwd?: string): string {
  return captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore()).worktreeRoot;
}

async function currentOutputIssue(entry: ManifestEntry, root: string): Promise<string | null> {
  const result = await pipelineManifestShow(entry.id, root);
  if (!result.success) throw new EngineResultError(result.error);
  const data = result.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('fileExists' in data) ||
    typeof data.fileExists !== 'boolean'
  ) {
    throw new EngineResultError({
      code: 'E_MANIFEST_RESULT_INVALID',
      message: 'Canonical manifest show did not disclose output availability',
      details: { entryId: entry.id },
    });
  }
  return data.fileExists ? null : `OUTPUT_FILE_MISSING: ${entry.file}`;
}

/**
 * Validate one entry in an explicitly selected historical JSONL file synchronously.
 * @remarks Bare calls cannot validate the authoritative current store and return
 * an unavailable-current-source issue. Use validateCurrentSubagentOutput for that store.
 * @param researchId - Exact historical entry identity.
 * @param cwd - Root used for relative historical paths and output files.
 * @param historicalManifestPath - Explicit historical file; never inferred from cwd.
 * @returns Synchronous compliance result with all historical read/parse issues.
 * @example
 * ```ts
 * const result = validateSubagentOutput('entry', '/project', 'history.jsonl');
 * ```
 */
export function validateSubagentOutput(
  researchId: string,
  cwd?: string,
  historicalManifestPath?: string,
): { passed: boolean; issues: string[]; checkedRules: string[] } {
  if (!historicalManifestPath)
    return {
      passed: false,
      issues: [currentSourceIssue('validateCurrentSubagentOutput')],
      checkedRules: [...CHECKED_RULES],
    };
  const history = readHistoricalEntries(cwd, historicalManifestPath);
  const entry = history.entries.find((candidate) => candidate.id === researchId);
  const issues = [...history.issues, ...entryIssues(entry, researchId)];
  const outputIssue = entry && historicalOutputIssue(entry, cwd);
  if (outputIssue) issues.push(outputIssue);
  return { passed: issues.length === 0, issues, checkedRules: [...CHECKED_RULES] };
}

/**
 * Validate an explicitly selected historical manifest synchronously.
 * @remarks This preserves the synchronous return shape without equating a retired
 * or missing JSONL file with a valid current database. Every malformed row fails.
 * @param cwd - Root for relative historical and output paths.
 * @param historicalManifestPath - Explicit historical JSONL file.
 * @returns Historical validation result; absent explicit source fails.
 * @example
 * ```ts
 * const result = validateManifestIntegrity('/project', 'history.jsonl');
 * ```
 */
export function validateManifestIntegrity(
  cwd?: string,
  historicalManifestPath?: string,
): ManifestValidationResult {
  if (!historicalManifestPath)
    return {
      exists: false,
      passed: false,
      issues: [currentSourceIssue('validateCurrentManifestIntegrity')],
    };
  const history = readHistoricalEntries(cwd, historicalManifestPath);
  const issues = [...history.issues];
  for (const entry of history.entries) {
    issues.push(...entryIssues(entry, entry.id));
    const outputIssue = historicalOutputIssue(entry, cwd);
    if (outputIssue) issues.push(outputIssue);
  }
  return {
    exists: history.exists,
    passed: issues.length === 0,
    issues,
    stats: {
      totalLines: history.totalLines,
      validEntries: history.entries.length,
      invalidEntries: history.invalidEntries,
    },
  };
}

/**
 * Check exact task linkage and output validity in explicitly selected history.
 * @remarks Entry names and follow-up requests do not establish task evidence.
 * Bare synchronous calls fail with current-store async guidance.
 * @param previousTaskId - Exact task whose evidence is required.
 * @param researchId - Optional exact historical entry identity.
 * @param cwd - Root for relative historical and output paths.
 * @param historicalManifestPath - Explicit historical JSONL file.
 * @returns Synchronous compliance result, never successful after read/parse failure.
 * @example
 * ```ts
 * const result = verifyCompliance('T1', undefined, '/project', 'history.jsonl');
 * ```
 */
export function verifyCompliance(
  previousTaskId: string,
  researchId?: string,
  cwd?: string,
  historicalManifestPath?: string,
): ComplianceResult {
  if (!historicalManifestPath)
    return complianceResult(previousTaskId, undefined, [
      currentSourceIssue('verifyCurrentCompliance'),
    ]);
  const history = readHistoricalEntries(cwd, historicalManifestPath);
  const entry = selectedEntry(history.entries, previousTaskId, researchId);
  const issues = [...history.issues, ...entryIssues(entry, researchId ?? previousTaskId)];
  const outputIssue = entry && historicalOutputIssue(entry, cwd);
  if (outputIssue) issues.push(outputIssue);
  return complianceResult(previousTaskId, entry, issues);
}

/**
 * Validate an exact entry from canonical modern and retained historical rows.
 * @remarks Captures project ownership before awaiting and verifies real output
 * availability through the same canonical resolver as manifest show.
 * @param researchId - Exact canonical entry identity.
 * @param cwd - Optional explicit project root.
 * @returns Field and output validation result.
 * @throws If canonical storage, history, metadata or output resolution fails.
 * @example
 * ```ts
 * const result = await validateCurrentSubagentOutput('entry', '/project');
 * ```
 */
export async function validateCurrentSubagentOutput(
  researchId: string,
  cwd?: string,
): Promise<ReturnType<typeof validateSubagentOutput>> {
  const root = currentRoot(cwd);
  const entries = await readManifestEntries(root);
  const entry = entries.find((candidate) => candidate.id === researchId);
  const issues = entryIssues(entry, researchId);
  const outputIssue = entry && (await currentOutputIssue(entry, root));
  if (outputIssue) issues.push(outputIssue);
  return { passed: issues.length === 0, issues, checkedRules: [...CHECKED_RULES] };
}

/**
 * Validate eligible canonical manifest rows and their actual output availability.
 * @remarks The existing totalLines counter denotes records for the database
 * source. Empty evidence fails; archived rows remain outside current eligibility.
 * @param cwd - Optional explicit project root.
 * @returns Integrity result for current eligible evidence.
 * @throws If canonical reads, history comparison or output resolution fail.
 * @example
 * ```ts
 * const result = await validateCurrentManifestIntegrity('/project');
 * ```
 */
export async function validateCurrentManifestIntegrity(
  cwd?: string,
): Promise<ManifestValidationResult> {
  const root = currentRoot(cwd);
  const entries = await readManifestEntries(root);
  const issues: string[] = entries.length
    ? []
    : ['MANIFEST_EMPTY: Current store has no eligible evidence'];
  let invalidEntries = 0;
  for (const entry of entries) {
    const entryProblems = entryIssues(entry, entry.id);
    const outputIssue = await currentOutputIssue(entry, root);
    if (outputIssue) entryProblems.push(outputIssue);
    if (entryProblems.length) invalidEntries++;
    issues.push(...entryProblems.map((issue) => `${entry.id}: ${issue}`));
  }
  return {
    exists: true,
    passed: issues.length === 0,
    issues,
    stats: {
      totalLines: entries.length,
      validEntries: entries.length - invalidEntries,
      invalidEntries,
    },
  };
}

/**
 * Check current canonical evidence for an exact task before another spawn.
 * @remarks Requires explicit task linkage and valid fields/output; identifier
 * substrings and follow-up requests cannot authorize the next action.
 * @param previousTaskId - Exact task whose evidence is required.
 * @param researchId - Optional exact canonical entry identity.
 * @param cwd - Optional explicit project root.
 * @returns Compliance result with current canonical evidence checks.
 * @throws If canonical reads, history comparison or output resolution fail.
 * @example
 * ```ts
 * const result = await verifyCurrentCompliance('T1', undefined, '/project');
 * ```
 */
export async function verifyCurrentCompliance(
  previousTaskId: string,
  researchId?: string,
  cwd?: string,
): Promise<ComplianceResult> {
  const root = currentRoot(cwd);
  const entries = await readManifestEntries(root);
  const entry = selectedEntry(entries, previousTaskId, researchId);
  const issues = entryIssues(entry, researchId ?? previousTaskId);
  const outputIssue = entry && (await currentOutputIssue(entry, root));
  if (outputIssue) issues.push(outputIssue);
  return complianceResult(previousTaskId, entry, issues);
}

/**
 * Validate orchestrator compliance (post-hoc behavioral checks).
 * @remarks Uses canonical manifest evidence and propagates failed task reads.
 * @param epicId - Optional epic for dependency completion-order checks.
 * @param cwd - Optional explicit project root.
 * @returns Compliance result and observed protocol violations.
 * @throws If canonical evidence or task storage reads fail.
 * @example
 * ```ts
 * const result = await validateOrchestratorCompliance('T0', '/project');
 * ```
 */
export async function validateOrchestratorCompliance(
  epicId?: string,
  cwd?: string,
): Promise<{
  compliant: boolean;
  violations: string[];
  warnings: string[];
}> {
  const violations: string[] = [];
  const warnings: string[] = [];

  const root = currentRoot(cwd);
  const manifest = await validateCurrentManifestIntegrity(root);
  if (!manifest.passed) violations.push(...manifest.issues);

  // Check dependency order (ORC-004) for completed tasks via DataAccessor
  if (epicId) {
    const acc = await getTaskAccessor(root);
    if (!(await acc.loadSingleTask(epicId))) {
      violations.push(`ORC_EPIC_NOT_FOUND: Cannot assess dependency order for ${epicId}`);
      return { compliant: false, violations, warnings };
    }
    const children = await acc.getChildren(epicId);
    const tasks = children.filter((t) => t.status === 'done');

    // Sort by updatedAt and check for dependency violations
    const sorted = tasks.sort(
      (a, b) => new Date(a.updatedAt ?? '').getTime() - new Date(b.updatedAt ?? '').getTime(),
    );
    const completionOrder = sorted.map((t) => t.id);

    for (let i = 0; i < sorted.length; i++) {
      const deps = sorted[i].depends ?? [];
      for (const dep of deps) {
        const depIdx = completionOrder.indexOf(dep);
        if (depIdx >= 0 && depIdx >= i) {
          violations.push(
            `ORC-004_DEPENDENCY_ORDER: Task ${sorted[i].id} completed before dependency ${dep}`,
          );
        }
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
    warnings,
  };
}
