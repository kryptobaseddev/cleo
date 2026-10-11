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

import { isDeepStrictEqual } from 'node:util';
import type { AcceptanceGate, AcceptanceItem, TransactionAccessor } from '@cleocode/contracts';
import { acceptanceGateSchema } from '@cleocode/contracts/acceptance-gate-schema.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { enforceAcceptanceImmutability } from './ac-immutability.js';
import { acItemToText, applyAcPlan, planAcUpdate, replaceAcRowPlan } from './ac-table.js';

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
  /** Proposed replacements evaluated against the transaction snapshot. */
  proposals: MigrationProposal[];
  /** Number of free-text criteria replaced by validated gates. */
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

async function persistAcceptanceProjection(
  tx: TransactionAccessor,
  taskId: string,
  acceptance: readonly AcceptanceItem[],
  updatedAt: string,
): Promise<void> {
  await tx.updateTaskFields(taskId, {
    acceptanceJson: JSON.stringify(acceptance),
    updatedAt,
  });
  const existing = await tx.getAcRows(taskId);
  const plan = planAcUpdate(taskId, existing, acceptance);
  await applyAcPlan(tx, taskId, plan);
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
 * @remarks
 * Validates before opening storage. Reading existing acceptance, checking REQ-ID
 * uniqueness and persisting the task/AC projection share one transaction, so
 * competing appends cannot overwrite each other. This records a gate; it does
 * not execute it or record passing verification evidence.
 *
 * @returns The committed acceptance array and its owning task identity.
 * @example
 * ```typescript
 * const gate: AcceptanceGate = {
 *   kind: 'test', command: 'node', args: ['verify.mjs'], expect: 'exit0',
 *   req: 'PARTNER-121', description: 'Task-specific checks pass',
 * };
 * await reqAdd(projectRoot, 'T121', gate, undefined);
 * ```
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param gate - Typed gate; runtime schema validation also applies to SDK callers
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws CleoError E_NOT_FOUND when the task does not exist
 * @throws CleoError E_VALIDATION when the REQ-ID already exists on the task
 *
 * @task T782
 */
export async function reqAdd(
  projectRoot: string,
  taskId: string,
  gate: AcceptanceGate,
  accessor?: DataAccessor,
): Promise<{ task: { id: string; acceptance: AcceptanceItem[] } }> {
  const validated = validateGate(gate);
  const acc = accessor ?? (await getTaskAccessor(projectRoot));
  return acc.transaction(async (tx) => {
    const task = await loadTask(acc, taskId);

    const existing = (task.acceptance ?? []) as AcceptanceItem[];

    // Check REQ-ID uniqueness
    if (validated.req) {
      const dup = existing.find(
        (item): item is AcceptanceGate => typeof item === 'object' && item.req === validated.req,
      );
      if (dup) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `REQ-ID "${validated.req}" already exists on task ${taskId}`,
          {
            fix: `Choose a unique REQ-ID or remove the existing gate with 'cleo req list ${taskId}'`,
          },
        );
      }
    }

    const updated: AcceptanceItem[] = [...existing, validated];
    await persistAcceptanceProjection(tx, taskId, updated, new Date().toISOString());

    return { task: { id: taskId, acceptance: updated } };
  });
}

/** Result of {@link reqReplace}. */
export interface ReqReplaceResult {
  /** The task and its committed acceptance array. */
  task: { id: string; acceptance: AcceptanceItem[] };
  /** The replaced REQ-ID. */
  req: string;
  /** Zero-based index of the gate in the acceptance array (unchanged). */
  index: number;
  /** The gate that was superseded, kept in the AC history and the audit row. */
  superseded: AcceptanceGate;
  /** False when the new gate equals the current one (nothing was written). */
  changed: boolean;
}

/**
 * Replace the typed gate that carries `req` with `gate`, in place (T12988).
 *
 * @remarks
 * The gate keeps its index, its AC row (id and ordinal: a REQ-ID row's id
 * derives from the REQ-ID, `evidenceBoundSourceKey`) and therefore its
 * evidence bindings, which go stale rather than being re-pointed: typed results
 * and criterion links are pinned to the criterion text hash, so the replaced
 * gate must be verified again. The superseded gate is kept as an AC history row
 * (reason `replace`) and in the task audit row, with its last typed result. In
 * a locked pipeline stage the change needs `reason`, exactly as `cleo update
 * --acceptance` does.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId - Target task ID.
 * @param req - REQ-ID of the gate to replace.
 * @param gate - The new gate. Its `req` must be absent or equal `req`.
 * @param options - `reason` for a locked stage; `accessor` for tests.
 * @returns The committed acceptance array and the superseded gate.
 * @throws CleoError E_NOT_FOUND for an unknown task or REQ-ID, E_VALIDATION for
 *   an invalid gate or a REQ-ID mismatch, AC_LOCKED in a locked stage without `reason`.
 * @example
 * ```typescript
 * await reqReplace(root, 'T42', 'TIMER-01', {
 *   kind: 'test', command: 'pnpm', args: ['--filter', 'app', 'exec', 'vitest', 'run'],
 *   expect: 'pass', description: 'Timer tests pass', req: 'TIMER-01',
 * });
 * ```
 * @task T12988
 */
export async function reqReplace(
  projectRoot: string,
  taskId: string,
  req: string,
  gate: AcceptanceGate,
  options: { reason?: string; accessor?: DataAccessor } = {},
): Promise<ReqReplaceResult> {
  const reqId = req.trim();
  if (gate.req !== undefined && gate.req !== reqId) {
    // @sync-invariant none:input-shape a gate naming another REQ-ID is refused before any read; nothing is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Gate JSON names REQ-ID "${gate.req}", but it replaces "${reqId}"`,
      { fix: `Set "req":"${reqId}" in the gate JSON, or omit it` },
    );
  }
  const validated = validateGate({ ...gate, req: reqId });
  const acc = options.accessor ?? (await getTaskAccessor(projectRoot));
  return acc.transaction(async (tx) => {
    const task = await loadTask(acc, taskId);
    const existing = (task.acceptance ?? []) as AcceptanceItem[];
    const index = existing.findIndex(
      (item): item is AcceptanceGate => typeof item === 'object' && item.req === reqId,
    );
    if (index < 0) {
      const known = existing.flatMap((item) =>
        typeof item === 'object' && item.req ? [item.req] : [],
      );
      // @sync-invariant none:input-shape an unknown REQ-ID is refused before any write; nothing is written
      throw new CleoError(ExitCode.NOT_FOUND, `REQ-ID "${reqId}" is not a gate on task ${taskId}`, {
        fix: known.length
          ? `REQ-IDs on ${taskId}: ${known.join(', ')} (cleo req list ${taskId})`
          : `${taskId} has no REQ-ID gates; add one with cleo req add ${taskId} --gate '<json>'`,
      });
    }
    const superseded = existing[index] as AcceptanceGate;
    if (acItemToText(superseded) === acItemToText(validated)) {
      return {
        task: { id: taskId, acceptance: existing },
        req: reqId,
        index,
        superseded,
        changed: false,
      };
    }
    const updated: AcceptanceItem[] = existing.map((item, i) => (i === index ? validated : item));
    // Same guard as `cleo update --acceptance`: a locked stage needs a reason.
    const authorization = enforceAcceptanceImmutability({
      task,
      newAcceptance: updated,
      reason: options.reason,
      projectRoot,
    });
    const now = new Date().toISOString();
    await tx.updateTaskFields(taskId, { acceptanceJson: JSON.stringify(updated), updatedAt: now });
    const rows = await tx.getAcRows(taskId);
    await applyAcPlan(tx, taskId, replaceAcRowPlan(taskId, rows, index, validated));
    const lastResult = task.verification?.gateResults?.find((r) => r.index === index);
    await tx.appendLog({
      timestamp: now,
      action: 'req_replaced',
      taskId,
      actor: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      details: {
        req: reqId,
        index,
        ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
        ...(authorization ? { acceptanceOverride: { ...authorization, status: 'committed' } } : {}),
      },
      before: { gate: superseded, ...(lastResult ? { lastResult } : {}) },
      after: { gate: validated },
    });
    return {
      task: { id: taskId, acceptance: updated },
      req: reqId,
      index,
      superseded,
      changed: true,
    };
  });
}

/**
 * List all REQ-ID–addressed acceptance gates on a task.
 *
 * @remarks
 * Free-text strings are skipped because they have no REQ-ID. This summary does
 * not execute gates or establish verification; full payloads remain on the task.
 *
 * @returns Requirement identity, index, kind and description for each named gate.
 * @example
 * ```typescript
 * const { gates } = await reqList(projectRoot, 'T121', undefined);
 * ```
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws CleoError E_NOT_FOUND when the task does not exist
 *
 * @task T782
 */
export async function reqList(
  projectRoot: string,
  taskId: string,
  accessor?: DataAccessor,
): Promise<{ taskId: string; gates: ReqListEntry[] }> {
  const acc = accessor ?? (await getTaskAccessor(projectRoot));
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
 * @remarks
 * Without `apply: true` only proposals are returned. With `apply: true` the
 * matched strings are replaced in the task's acceptance array and the updated
 * array is persisted.
 *
 * Auto-generated REQ-IDs use the pattern `MIGRATED-001`, `MIGRATED-002`, etc.
 * Existing structured gates and their requirement identities are preserved.
 * Apply plans and persists under one transaction; preview does not write.
 *
 * @returns Proposed replacements and, when applied, the committed replacement count.
 * @example
 * ```typescript
 * const preview = await reqMigrate(projectRoot, 'T121', false, undefined);
 * ```
 *
 * @param projectRoot - Absolute path to project root
 * @param taskId - Target task ID
 * @param apply - When true, writes the proposals back to the task
 * @param accessor - Optional pre-created accessor (for testing)
 *
 * @throws CleoError E_NOT_FOUND when the task does not exist
 *
 * @task T782
 */
export async function reqMigrate(
  projectRoot: string,
  taskId: string,
  apply: boolean,
  accessor?: DataAccessor,
): Promise<{ proposals: MigrationProposal[]; applied?: number }> {
  const acc = accessor ?? (await getTaskAccessor(projectRoot));
  const migrate = async (tx?: TransactionAccessor) => {
    const task = await loadTask(acc, taskId);

    const acceptance = (task.acceptance ?? []) as AcceptanceItem[];
    const proposals: MigrationProposal[] = [];
    let counter = 1;
    const usedRequirements = new Set(
      acceptance.flatMap((item) => (typeof item === 'object' && item.req ? [item.req] : [])),
    );

    // Collect free-text indices only
    for (let i = 0; i < acceptance.length; i++) {
      const item = acceptance[i];
      if (typeof item !== 'string') continue; // skip existing gates

      let reqId: string;
      do {
        reqId = `MIGRATED-${String(counter++).padStart(3, '0')}`;
      } while (usedRequirements.has(reqId));
      usedRequirements.add(reqId);

      const classified = heuristicClassify(item, reqId);
      const proposed = classified ? validateGate(classified) : null;
      proposals.push({
        index: i,
        original: item,
        proposed,
        reqId: proposed ? reqId : null,
        heuristic: proposed ? proposed.kind : null,
      });
    }

    if (!tx) {
      return { proposals };
    }

    // Apply: replace matched strings with their proposed gates
    // Unmatched strings (where proposed is null) are left as-is
    const updated: AcceptanceItem[] = acceptance.map((item, i) => {
      const proposal = proposals.find((p) => p.index === i);
      if (proposal?.proposed) return proposal.proposed;
      return item;
    });

    await persistAcceptanceProjection(tx, taskId, updated, new Date().toISOString());

    return {
      proposals,
      applied: proposals.filter((p) => p.proposed !== null).length,
    };
  };
  return apply ? acc.transaction(migrate) : migrate();
}

/**
 * Validate a raw JSON string against the `acceptanceGateSchema` Zod schema.
 *
 * Returns the parsed `AcceptanceGate` on success or throws a `CleoError`
 * with exit code `E_VALIDATION` on failure.
 *
 * @remarks
 * Uses the same schema boundary as direct SDK writes and rejects unsupported
 * fields, including nested fields that the schema would otherwise strip.
 *
 * @returns The validated gate without executing its command.
 * @example
 * ```typescript
 * const raw = '{"kind":"manual","description":"Review","prompt":"Approve?"}';
 * const gate = parseGateJson(raw);
 * ```
 * @param raw - Raw JSON string from `--gate` CLI flag
 *
 * @throws CleoError E_VALIDATION when JSON is malformed or schema invalid
 *
 * @task T782
 */
export function parseGateJson(raw: string): AcceptanceGate {
  let parsed: AcceptanceGate;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CleoError(ExitCode.VALIDATION_ERROR, `--gate value is not valid JSON: ${raw}`, {
      fix: 'Wrap the gate JSON in single quotes, e.g. --gate \'{"kind":"test","command":"pnpm test","expect":"pass","description":"Tests pass"}\'',
    });
  }

  return validateGate(parsed);
}

/** Validate the canonical schema without silently dropping unsupported gate fields. */
function validateGate(gate: AcceptanceGate): AcceptanceGate {
  const result = acceptanceGateSchema.safeParse(gate);
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

  if (!isDeepStrictEqual(gate, result.data)) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Gate includes unsupported fields', {
      fix: 'Use only fields supported by the canonical AcceptanceGate schema; unsupported nested fields are also rejected.',
    });
  }
  return result.data;
}
