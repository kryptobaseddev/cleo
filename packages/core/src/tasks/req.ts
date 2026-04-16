/**
 * REQ-ID acceptance gate operations for `cleo req add|list|migrate`.
 *
 * Each operation reads/writes the `Task.acceptance` mixed array
 * (`(string | AcceptanceGate)[]`) via the DataAccessor without touching
 * any other task fields.
 *
 * @epic T760
 * @task T782
 */

import type { AcceptanceGate, AcceptanceItem } from '@cleocode/contracts';
import { acceptanceGateSchema, ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

// ─── Heuristic regex patterns ─────────────────────────────────────────────────

const RE_TEST = /\b(tests?\s+pass(es)?|npm\s+test|pnpm\s+test|yarn\s+test)\b/i;
const RE_FILE_EXISTS = /^(?:file\s+(?:at\s+)?([^\s]+)|([^\s]+)\s+exists?)$/i;
const RE_LINT = /\b(lint\s+clean|biome\s+check|eslint|tsc\s+--noEmit)\b/i;
const RE_EXIT_ZERO = /\b(?:(.+?)\s+returns?\s+(?:exit\s+)?0|(.+?)\s+exit\s+(?:code\s+)?0)\b/i;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Shape returned by `reqList`. */
export interface ReqListEntry {
  /** Zero-based index in the task's acceptance array. */
  index: number;
  /** The REQ-ID (always present — strings are filtered out). */
  req: string;
  /** Gate kind discriminant. */
  kind: AcceptanceGate['kind'];
  /** Human-readable description. */
  description: string;
  /** Advisory flag. */
  advisory: boolean;
}

/** Proposal produced by `reqMigrate`. */
export interface MigrationProposal {
  /** Zero-based index in the original acceptance array. */
  index: number;
  /** Original free-text string. */
  original: string;
  /** Proposed gate (null means no heuristic matched — item is left as-is). */
  proposed: AcceptanceGate | null;
  /** Auto-generated REQ-ID for the proposed gate. */
  reqId: string | null;
  /** Short label for the matched heuristic ('test'|'file'|'lint'|'command'|'manual'). */
  heuristic: string | null;
}

/** Result of `reqMigrate` with `apply: true`. */
export interface MigrationApplyResult {
  proposals: MigrationProposal[];
  applied: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function loadTask(accessor: DataAccessor, taskId: string) {
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`, {
      fix: `Run 'cleo find "${taskId}"' to verify the task ID`,
    });
  }
  return task;
}

/**
 * Classify a free-text acceptance string into a gate proposal using heuristics.
 *
 * @internal
 */
function heuristicClassify(text: string, reqId: string): MigrationProposal['proposed'] {
  const t = text.trim();

  // test pass
  if (RE_TEST.test(t)) {
    const command = t.match(/npm\s+test/i)
      ? 'npm test'
      : t.match(/pnpm\s+test/i)
        ? 'pnpm test'
        : t.match(/yarn\s+test/i)
          ? 'yarn test'
          : 'pnpm test';
    return {
      kind: 'test',
      command,
      expect: 'pass',
      description: t,
      req: reqId,
    };
  }

  // file exists
  const fileMatch = t.match(RE_FILE_EXISTS);
  if (fileMatch) {
    const path = (fileMatch[1] ?? fileMatch[2] ?? '').trim();
    if (path) {
      return {
        kind: 'file',
        path,
        assertions: [{ type: 'exists' }],
        description: t,
        req: reqId,
      };
    }
  }

  // lint clean
  if (RE_LINT.test(t)) {
    const tool: import('@cleocode/contracts').LintGate['tool'] = t.match(/biome/i)
      ? 'biome'
      : t.match(/eslint/i)
        ? 'eslint'
        : t.match(/tsc/i)
          ? 'tsc'
          : 'biome';
    return {
      kind: 'lint',
      tool,
      expect: 'clean',
      description: t,
      req: reqId,
    };
  }

  // command returns exit 0
  const exitMatch = t.match(RE_EXIT_ZERO);
  if (exitMatch) {
    const cmd = (exitMatch[1] ?? exitMatch[2] ?? '').trim();
    if (cmd) {
      return {
        kind: 'command',
        cmd,
        exitCode: 0,
        description: t,
        req: reqId,
      };
    }
  }

  // manual fallback
  return {
    kind: 'manual',
    prompt: t,
    description: t,
    req: reqId,
  };
}

// ─── Public operations ────────────────────────────────────────────────────────

/**
 * Add a typed `AcceptanceGate` (with a REQ-ID) to a task's acceptance array.
 *
 * Validates the gate JSON against the Zod schema before writing. Rejects
 * duplicate REQ-IDs within the same task.
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param gate - Parsed `AcceptanceGate` object (already validated)
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws {CleoError} E_NOT_FOUND when the task does not exist
 * @throws {CleoError} E_VALIDATION when the REQ-ID already exists on the task
 *
 * @task T782
 */
export async function reqAdd(
  projectRoot: string,
  taskId: string,
  gate: AcceptanceGate,
  accessor?: DataAccessor,
): Promise<{ task: { id: string; acceptance: AcceptanceItem[] } }> {
  const acc = accessor ?? (await getAccessor(projectRoot));
  const task = await loadTask(acc, taskId);

  const existing = (task.acceptance ?? []) as AcceptanceItem[];

  // Check REQ-ID uniqueness
  if (gate.req) {
    const dup = existing.find(
      (item): item is AcceptanceGate =>
        typeof item === 'object' && (item as AcceptanceGate).req === gate.req,
    );
    if (dup) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `REQ-ID "${gate.req}" already exists on task ${taskId}`,
        {
          fix: `Choose a unique REQ-ID or remove the existing gate with 'cleo req list ${taskId}'`,
        },
      );
    }
  }

  const updated: AcceptanceItem[] = [...existing, gate];
  await acc.updateTaskFields(taskId, {
    acceptanceJson: JSON.stringify(updated),
    updatedAt: new Date().toISOString(),
  });

  return { task: { id: taskId, acceptance: updated } };
}

/**
 * List all REQ-ID–addressed acceptance gates on a task.
 *
 * Free-text strings (legacy) in the acceptance array are skipped because
 * they have no REQ-ID. Only structured `AcceptanceGate` items with a `req`
 * field are returned.
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws {CleoError} E_NOT_FOUND when the task does not exist
 *
 * @task T782
 */
export async function reqList(
  projectRoot: string,
  taskId: string,
  accessor?: DataAccessor,
): Promise<{ taskId: string; gates: ReqListEntry[] }> {
  const acc = accessor ?? (await getAccessor(projectRoot));
  const task = await loadTask(acc, taskId);

  const acceptance = (task.acceptance ?? []) as AcceptanceItem[];
  const gates: ReqListEntry[] = [];

  for (let i = 0; i < acceptance.length; i++) {
    const item = acceptance[i];
    if (typeof item === 'object' && item !== null && (item as AcceptanceGate).req) {
      const gate = item as AcceptanceGate;
      gates.push({
        index: i,
        req: gate.req!,
        kind: gate.kind,
        description: gate.description,
        advisory: gate.advisory ?? false,
      });
    }
  }

  return { taskId, gates };
}

/**
 * Heuristic migrator: reads free-text acceptance strings and proposes typed
 * `AcceptanceGate` replacements.
 *
 * Without `apply: true` only proposals are returned. With `apply: true` the
 * matched strings are replaced in the task's acceptance array and the updated
 * array is persisted.
 *
 * Auto-generated REQ-IDs use the pattern `MIGRATED-001`, `MIGRATED-002`, etc.
 * Strings that already contain a structured gate (object items) are skipped.
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param apply - When true, writes the proposals back to the task
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws {CleoError} E_NOT_FOUND when the task does not exist
 *
 * @task T782
 */
export async function reqMigrate(
  projectRoot: string,
  taskId: string,
  apply: boolean,
  accessor?: DataAccessor,
): Promise<{ proposals: MigrationProposal[]; applied?: number }> {
  const acc = accessor ?? (await getAccessor(projectRoot));
  const task = await loadTask(acc, taskId);

  const acceptance = (task.acceptance ?? []) as AcceptanceItem[];
  const proposals: MigrationProposal[] = [];
  let counter = 1;

  // Collect free-text indices only
  for (let i = 0; i < acceptance.length; i++) {
    const item = acceptance[i];
    if (typeof item !== 'string') continue; // skip existing gates

    const reqId = `MIGRATED-${String(counter).padStart(3, '0')}`;
    counter++;

    const proposed = heuristicClassify(item, reqId);
    proposals.push({
      index: i,
      original: item,
      proposed,
      reqId: proposed ? reqId : null,
      heuristic: proposed ? proposed.kind : null,
    });
  }

  if (!apply) {
    return { proposals };
  }

  // Apply: replace matched strings with their proposed gates
  // Unmatched strings (where proposed is null) are left as-is
  const updated: AcceptanceItem[] = acceptance.map((item, i) => {
    const proposal = proposals.find((p) => p.index === i);
    if (proposal?.proposed) return proposal.proposed;
    return item;
  });

  await acc.updateTaskFields(taskId, {
    acceptanceJson: JSON.stringify(updated),
    updatedAt: new Date().toISOString(),
  });

  return {
    proposals,
    applied: proposals.filter((p) => p.proposed !== null).length,
  };
}

/**
 * Validate a raw JSON string against the `acceptanceGateSchema` Zod schema.
 *
 * Returns the parsed `AcceptanceGate` on success or throws a `CleoError`
 * with exit code `E_VALIDATION` on failure.
 *
 * @param raw - Raw JSON string from `--gate` CLI flag
 *
 * @throws {CleoError} E_VALIDATION when JSON is malformed or schema invalid
 *
 * @task T782
 */
export function parseGateJson(raw: string): AcceptanceGate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `--gate value is not valid JSON: ${raw}`, {
      fix: 'Wrap the gate JSON in single quotes, e.g. --gate \'{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass"}\'',
    });
  }

  const result = acceptanceGateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Gate JSON failed schema validation: ${issues}`,
      {
        fix: 'Check AcceptanceGate schema: kind, description, and kind-specific required fields',
      },
    );
  }

  return result.data;
}
