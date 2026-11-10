/**
 * Narrows CLEO envelope data into the plugin's view types (T14462).
 *
 * The worker hands the panel small, bounded view rows instead of raw CLEO
 * records: every field is checked, long text is clipped to what a panel may
 * draw, and an answer missing its core shape is a `malformed-envelope` failure
 * rather than a half-drawn view.
 */

import { failure, isRecord } from './cleo-cli.ts';
import type {
  AcceptanceRow,
  CleoFailure,
  GateRow,
  TaskDetail,
  TaskPage,
  TaskRow,
  WorkerClaim,
} from './protocol.ts';

/** Longest title the tree and detail draw. */
const MAX_TITLE_LENGTH = 300;

/** Longest description or criterion text the detail draws. */
const MAX_TEXT_LENGTH = 4000;

/** Most acceptance criteria and evidence atoms read from one task. */
const MAX_ITEMS = 100;

/** A string field, clipped; `null` when absent or not a string. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** A non-negative integer field; `fallback` when absent or not one. */
function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** One list or detail record as a tree row; `null` when it has no id. */
function toTaskRow(value: unknown): TaskRow | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  return {
    id: value['id'],
    title: text(value['title'], MAX_TITLE_LENGTH) ?? '(untitled)',
    status: text(value['status'], 40) ?? 'unknown',
    type: text(value['type'], 40) ?? 'task',
    priority: text(value['priority'], 40),
    parentId: text(value['parentId'], 40),
  };
}

/**
 * Reads the `data` of a `cleo list` envelope as one page of tree rows.
 *
 * @param data - `data` of a successful list envelope.
 * @param offset - Offset the page was requested with.
 */
export function toTaskPage(data: Record<string, unknown>, offset: number): TaskPage | CleoFailure {
  const records = data['tasks'];
  if (!Array.isArray(records)) {
    return failure('malformed-envelope', 'CLEO answered the list read without a task list.');
  }
  const tasks: TaskRow[] = [];
  for (const record of records) {
    const row = toTaskRow(record);
    if (row === null) {
      return failure('malformed-envelope', 'CLEO listed a task without an id.');
    }
    tasks.push(row);
  }
  const population = isRecord(data['population']) ? data['population'] : {};
  const shown = offset + tasks.length;
  const matched = count(population['matched'], count(data['filtered'], shown));
  return {
    ok: true,
    tasks,
    matched,
    // CLEO's own `population.truncated` only says the page is shorter than the match, which
    // stays true on the last page. More rows exist only while the cursor is short of the
    // match and the page still added something.
    truncated: tasks.length > 0 && shown < matched,
    offset,
  };
}

/** A criterion as drawn, with the CLEO id evidence may name it by. */
type Criterion = { row: AcceptanceRow; id: string | null };

/** Acceptance criteria from `acRows`, falling back to the task's plain strings. */
function toAcceptance(data: Record<string, unknown>, task: Record<string, unknown>): Criterion[] {
  const criteria: Criterion[] = [];
  const acRows = Array.isArray(data['acRows']) ? data['acRows'] : [];
  for (const row of acRows.slice(0, MAX_ITEMS)) {
    if (!isRecord(row)) continue;
    const criterion = text(row['text'], MAX_TEXT_LENGTH);
    if (criterion === null) continue;
    const alias = text(row['alias'], 20) ?? `AC${criteria.length + 1}`;
    criteria.push({ row: { alias, text: criterion, gates: [] }, id: text(row['id'], 60) });
  }
  if (criteria.length > 0) return criteria;
  const plain = Array.isArray(task['acceptance']) ? task['acceptance'] : [];
  for (const entry of plain.slice(0, MAX_ITEMS)) {
    const criterion = text(entry, MAX_TEXT_LENGTH);
    if (criterion === null) continue;
    criteria.push({
      row: { alias: `AC${criteria.length + 1}`, text: criterion, gates: [] },
      id: null,
    });
  }
  return criteria;
}

/**
 * The criterion a `satisfies` atom names. An atom carries the criterion's id
 * (`targetAcId`, the canonical form) or its alias (`targetAcAlias`), and CLEO
 * adds the id it resolved an alias to as `resolvedAcUuid`. An id decides when
 * both sides have one, so evidence recorded for an earlier criterion is not
 * shown against a different one that now holds the same alias.
 */
function criterionOf(atom: Record<string, unknown>, criteria: Criterion[]): Criterion | undefined {
  const ids = [atom['targetAcId'], atom['resolvedAcUuid']].filter((id) => typeof id === 'string');
  if (ids.length > 0 && criteria.some((criterion) => criterion.id !== null)) {
    return criteria.find((criterion) => criterion.id !== null && ids.includes(criterion.id));
  }
  return criteria.find((criterion) => criterion.row.alias === atom['targetAcAlias']);
}

/**
 * Evidence gates of a task. Each gate lists the atom kinds recorded for it,
 * and a `satisfies` atom marks the criterion it names with the gate.
 */
function toGates(task: Record<string, unknown>, criteria: Criterion[]): GateRow[] {
  const verification = isRecord(task['verification']) ? task['verification'] : {};
  const gates = isRecord(verification['gates']) ? verification['gates'] : {};
  const evidence = isRecord(verification['evidence']) ? verification['evidence'] : {};
  const rows: GateRow[] = [];
  for (const [gate, passed] of Object.entries(gates).slice(0, MAX_ITEMS)) {
    const record = isRecord(evidence[gate]) ? evidence[gate] : {};
    const atoms = Array.isArray(record['atoms']) ? record['atoms'].slice(0, MAX_ITEMS) : [];
    const kinds = new Map<string, number>();
    for (const atom of atoms) {
      if (!isRecord(atom) || typeof atom['kind'] !== 'string') continue;
      kinds.set(atom['kind'], (kinds.get(atom['kind']) ?? 0) + 1);
      if (atom['kind'] !== 'satisfies' || atom['targetTaskId'] !== task['id']) continue;
      const criterion = criterionOf(atom, criteria);
      if (criterion && !criterion.row.gates.includes(gate)) criterion.row.gates.push(gate);
    }
    rows.push({
      gate: gate.slice(0, 60),
      passed: passed === true,
      atoms: [...kinds].map(([kind, n]) => (n > 1 ? `${kind} x${n}` : kind)).join(', '),
      capturedAt: text(record['capturedAt'], 40),
    });
  }
  return rows;
}

/** The claim a worker holds on the task; `null` when nobody holds it. */
function toClaim(value: unknown): WorkerClaim | null {
  if (!isRecord(value)) return null;
  return {
    agentId: text(value['agentId'], 120),
    sessionId: text(value['sessionId'], 120),
    claimedAt: text(value['claimedAt'], 40),
    leaseExpiresAt: text(value['leaseExpiresAt'], 40),
  };
}

/**
 * Reads the `data` of a `cleo show --full` envelope as one task detail.
 *
 * @param data - `data` of a successful show envelope.
 */
export function toTaskDetail(data: Record<string, unknown>): TaskDetail | CleoFailure {
  const task = data['task'];
  const row = toTaskRow(task);
  if (!isRecord(task) || row === null) {
    return failure('malformed-envelope', 'CLEO answered the task read without a task.');
  }
  const criteria = toAcceptance(data, task);
  const gates = toGates(task, criteria);
  const verification = isRecord(task['verification']) ? task['verification'] : {};
  const relations = isRecord(task['relationCounts']) ? task['relationCounts'] : {};
  const view = isRecord(data['view']) ? data['view'] : {};
  return {
    ok: true,
    task: {
      ...row,
      description: text(task['description'], MAX_TEXT_LENGTH) ?? '',
      size: text(task['size'], 40),
      pipelineStage: text(task['pipelineStage'], 60),
      children: count(relations['children'], 0),
      updatedAt: text(task['updatedAt'], 40),
    },
    acceptance: criteria.map((criterion) => criterion.row),
    gates,
    verificationPassed: verification['passed'] === true,
    claim: toClaim(task['claim']),
    nextAction: text(view['nextAction'], 60),
  };
}
