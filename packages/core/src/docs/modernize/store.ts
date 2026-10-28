/**
 * `cleo docs modernize --store` (T14118): modernize the docs already in the
 * store, not a folder.
 *
 * Plan, per stored doc:
 *
 * - **Kind.** Untyped rows, and rows the legacy `docs import` typed `spec`
 *   wholesale (owned by the `__project__` sentinel), are re-classified with
 *   the tree-mode rules over the slug and body; a rule below the floor is
 *   judged by System One (`docs.modernize.classify`), up to
 *   {@link MODERNIZE_STORE_JUDGE_LIMIT} asks per run.
 * - **Slug.** A slug carrying task, session or date tokens gets the stable
 *   slug; the old slug stays resolvable as an alias (`renameDocSlug`). Task
 *   ids it named become task refs on the doc.
 * - **ADR numbers.** When several ADRs share a number, the earliest keeps it
 *   and each later one is renumbered past the highest number in use.
 *
 * Apply runs the plan with a receipt (`rekind`, `reslug`, `link-task` ops)
 * and one graph rebuild; rollback walks the receipt backwards.
 *
 * @task T14118
 * @epic T14106
 */

import type {
  DocKindMetadata,
  DocsModernizeJudgment,
  DocsModernizePlan,
  DocsModernizeReceipt,
  DocsModernizeReceiptOp,
  DocsModernizeStoreRow,
} from '@cleocode/contracts';
import { DocKindRegistry } from '@cleocode/contracts/docs-taxonomy.js';
import type { DecideOptions } from '../../decide/client.js';
import type { DecisionSiteMode } from '../../decide/site.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { writeFileAtomic } from '../../tools/fs.js';
import { assembleAdrSlug, findHighestAdrNumber } from '../adr-allocator.js';
import { IMPORT_OWNER_TYPE, IMPORT_PROJECT_OWNER_ID } from '../import/attachment-store-accessor.js';
import { journalPath, modernizeReceiptPath, StepJournal } from './apply.js';
import { judgeDocKind, resolveModernizeJudgeSettings } from './judge.js';
import { ownerIdsFromPath } from './plan.js';
import {
  classifyDocByRules,
  MODERNIZE_CLASSIFY_FLOOR,
  stableSlugFor,
  stripVolatileTokens,
} from './rules.js';

/** System One asks per store run; past it the rule acts and the row says so. */
export const MODERNIZE_STORE_JUDGE_LIMIT = 200;

/** Actor recorded on adopted docs and task refs. */
const ACTOR = 'cleo docs modernize';

/** Options for {@link planDocsStoreModernize}. */
export interface PlanDocsStoreModernizeOptions {
  /** Project root. */
  readonly projectRoot: string;
  /** Explicit System One mode (tests). */
  readonly mode?: DecisionSiteMode;
  /** Provider wiring (tests). */
  readonly decide?: DecideOptions;
  /** Clock (tests). */
  readonly now?: () => Date;
}

/** One stored doc as the planner sees it. */
interface StoredDoc {
  readonly id: string;
  readonly sha256: string;
  readonly slug: string | null;
  readonly kind: string | null;
  readonly createdAt: string;
  readonly owners: readonly string[];
}

/** Every stored doc once, with all of its owners. */
async function listStoredDocs(projectRoot: string): Promise<StoredDoc[]> {
  const rows = await createAttachmentStore().listAllInProject(projectRoot);
  const byId = new Map<string, StoredDoc>();
  for (const r of rows) {
    const prev = byId.get(r.metadata.id);
    byId.set(r.metadata.id, {
      id: r.metadata.id,
      sha256: r.metadata.sha256,
      slug: r.slug,
      kind: r.type,
      createdAt: r.metadata.createdAt,
      owners: [...(prev?.owners ?? []), r.ownerId],
    });
  }
  return [...byId.values()];
}

/** Whether a row's kind should be re-derived. */
function needsKind(doc: StoredDoc, kinds: ReadonlySet<string>): boolean {
  if (doc.kind === null || !kinds.has(doc.kind)) return true;
  return doc.kind === 'spec' && doc.owners.every((o) => o === IMPORT_PROJECT_OWNER_ID);
}

/** The number of an `adr-NNN-…` slug, or null. */
function adrNumber(slug: string | null): number | null {
  const m = slug ? /^adr-(\d+)(?:-|$)/.exec(slug) : null;
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Plan a store-mode modernize run.
 *
 * @param options - Project root and System One overrides.
 * @returns A plan with `mode: 'store'` and one `storeRows` entry per doc that changes.
 */
export async function planDocsStoreModernize(
  options: PlanDocsStoreModernizeOptions,
): Promise<DocsModernizePlan> {
  const { projectRoot } = options;
  const kinds: readonly DocKindMetadata[] = DocKindRegistry.load(projectRoot).list();
  const kindIds = new Set(kinds.map((k) => k.kind));
  const settings = await resolveModernizeJudgeSettings(projectRoot, options.decide, options.mode);
  const store = createAttachmentStore();
  const docs = await listStoredDocs(projectRoot);
  const taken = new Set(docs.map((d) => d.slug).filter((s): s is string => s !== null));
  let asks = 0;

  const out: DocsModernizeStoreRow[] = [];
  const read = async (sha: string): Promise<string> =>
    (await store.get(sha, projectRoot))?.bytes.toString('utf-8') ?? '';

  for (const doc of docs) {
    const reasons: string[] = [];
    const judgments: DocsModernizeJudgment[] = [];
    const slugBroken = doc.slug !== null && stripVolatileTokens(doc.slug) !== doc.slug;
    const kindStale = needsKind(doc, kindIds);
    if (!slugBroken && !kindStale) continue;
    const content = await read(doc.sha256);
    const pathHint = `${doc.slug ?? doc.id}.md`;

    let newKind = doc.kind ?? 'note';
    if (kindStale) {
      const rule = classifyDocByRules(pathHint, content, kinds);
      newKind = rule.kind;
      reasons.push(`kind ${rule.kind}: ${rule.reason}`);
      if (rule.confidence < MODERNIZE_CLASSIFY_FLOOR) {
        if (asks < MODERNIZE_STORE_JUDGE_LIMIT) {
          asks += 1;
          const j = await judgeDocKind(
            {
              path: pathHint,
              title: doc.slug ?? '',
              content,
              ruleKind: rule.kind,
              ruleConfidence: rule.confidence,
              kinds,
            },
            settings,
          );
          judgments.push(j);
          newKind = j.acted;
        } else {
          reasons.push('System One ask limit reached for this run; the rule acts');
        }
      }
    }

    let newSlug = doc.slug;
    if (doc.slug !== null && slugBroken) {
      let candidate = stableSlugFor(pathHint, content, newKind);
      if (candidate !== doc.slug && taken.has(candidate)) {
        let n = 2;
        while (taken.has(`${candidate}-${n}`)) n += 1;
        candidate = `${candidate}-${n}`;
      }
      if (candidate !== doc.slug) {
        taken.add(candidate);
        newSlug = candidate;
        reasons.push(
          `slug ${candidate}: task, session and date tokens dropped; ${doc.slug} stays as an alias`,
        );
      }
    }
    if (newSlug === doc.slug && newKind === doc.kind) continue;
    out.push({
      attachmentId: doc.id,
      sha256: doc.sha256,
      slug: doc.slug,
      newSlug,
      kind: doc.kind,
      newKind,
      ownerTasks: doc.slug ? ownerIdsFromPath(doc.slug).filter((id) => id.startsWith('T')) : [],
      reasons,
      judgments,
    });
  }

  // ADR number collisions: earliest keeps the number, later ones move past the highest.
  const planned = new Map(out.map((r) => [r.attachmentId, r]));
  const byNumber = new Map<number, StoredDoc[]>();
  for (const doc of docs) {
    const slug = planned.get(doc.id)?.newSlug ?? doc.slug;
    const kind = planned.get(doc.id)?.newKind ?? doc.kind;
    const n = kind === 'adr' ? adrNumber(slug) : null;
    if (n === null) continue;
    byNumber.set(n, [...(byNumber.get(n) ?? []), doc]);
  }
  let next = (await findHighestAdrNumber(projectRoot)) + 1;
  for (const [n, group] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    if (group.length < 2) continue;
    const [, ...later] = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const doc of later) {
      const row = planned.get(doc.id);
      const current = row?.newSlug ?? doc.slug ?? '';
      const title = current.replace(/^adr-\d+-?/, '') || 'decision';
      const renumbered = assembleAdrSlug(next, title);
      next += 1;
      taken.add(renumbered);
      const reason = `ADR ${String(n).padStart(3, '0')} is shared; an earlier ADR keeps it, this one becomes ${renumbered}`;
      if (row) {
        const updated = { ...row, newSlug: renumbered, reasons: [...row.reasons, reason] };
        out[out.indexOf(row)] = updated;
        planned.set(doc.id, updated);
      } else {
        const added: DocsModernizeStoreRow = {
          attachmentId: doc.id,
          sha256: doc.sha256,
          slug: doc.slug,
          newSlug: renumbered,
          kind: doc.kind,
          newKind: doc.kind ?? 'adr',
          ownerTasks: [],
          reasons: [reason],
          judgments: [],
        };
        out.push(added);
        planned.set(doc.id, added);
      }
    }
  }

  out.sort((a, b) => (a.slug ?? a.attachmentId).localeCompare(b.slug ?? b.attachmentId));
  return {
    root: projectRoot,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    rows: [],
    counts: { keep: 0, rename: 0, 'merge-into': 0, delete: 0 },
    mode: 'store',
    storeRows: out,
  };
}

/**
 * Apply a store-mode plan with a receipt.
 *
 * @param plan - A `mode: 'store'` plan.
 * @param projectRoot - Project root.
 * @param now - Clock (tests).
 * @returns The receipt.
 */
export async function applyDocsStoreModernize(
  plan: DocsModernizePlan,
  projectRoot: string,
  now: () => Date = () => new Date(),
): Promise<DocsModernizeReceipt> {
  const started = now();
  const t0 = performance.now();
  const stamp = started.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
  const runId = `dm-${stamp}-store`;
  const journal = new StepJournal(journalPath(projectRoot, runId));
  const receipt = (edgeCount: number, durationMs?: number): DocsModernizeReceipt => ({
    runId,
    root: projectRoot,
    appliedAt: started.toISOString(),
    planSha256: '',
    ops: journal.list(),
    edgeCount,
    rolledBackAt: null,
    blobs: [],
    moves: [],
    deleted: [],
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  const save = async (edgeCount = 0, durationMs?: number): Promise<void> => {
    await writeFileAtomic({
      path: modernizeReceiptPath(projectRoot, runId),
      content: `${JSON.stringify(receipt(edgeCount, durationMs), null, 2)}\n`,
    });
  };
  await save();
  const { renameDocSlug, setDocKind, getDocKind } = await import('../slug-rename.js');
  const store = createAttachmentStore();
  const { rebuildDocsWikilinks } = await import('../wikilinks.js');
  let edgeCount = 0;
  try {
    for (const row of plan.storeRows ?? []) {
      if (row.newKind !== row.kind) {
        const i = journal.begin({
          op: 'rekind',
          attachmentId: row.attachmentId,
          prior: { kind: await getDocKind(projectRoot, row.attachmentId) },
        });
        await setDocKind(projectRoot, row.attachmentId, row.newKind);
        journal.done(i);
      }
      if (row.slug && row.newSlug && row.newSlug !== row.slug) {
        const i = journal.begin({
          op: 'reslug',
          attachmentId: row.attachmentId,
          slug: row.slug,
          target: row.newSlug,
        });
        await renameDocSlug(projectRoot, {
          oldSlug: row.slug,
          newSlug: row.newSlug,
          reason: 'modernize',
          authorAgentId: ACTOR,
        });
        journal.done(i);
      }
      for (const task of row.ownerTasks) {
        const refs = await store.listRefs(row.attachmentId, projectRoot);
        if (refs.some((r) => r.ownerType === IMPORT_OWNER_TYPE && r.ownerId === task)) continue;
        const i = journal.begin({ op: 'link-task', attachmentId: row.attachmentId, ownerId: task });
        await store.ref(row.attachmentId, IMPORT_OWNER_TYPE, task, ACTOR, projectRoot);
        journal.done(i);
      }
    }
  } finally {
    ({ edgeCount } = await rebuildDocsWikilinks({ projectRoot }));
    await save(edgeCount, Math.round(performance.now() - t0));
  }
  return receipt(edgeCount, Math.round(performance.now() - t0));
}

/**
 * Reverse one store-mode op (called by the shared rollback walk).
 *
 * @param projectRoot - Project root.
 * @param op - A `rekind`, `reslug` or `link-task` op.
 * @returns Whether the op was a store-mode op.
 */
export async function reverseStoreOp(
  projectRoot: string,
  op: DocsModernizeReceiptOp,
): Promise<boolean> {
  const { renameDocSlug, setDocKind } = await import('../slug-rename.js');
  switch (op.op) {
    case 'rekind':
      if (op.attachmentId) await setDocKind(projectRoot, op.attachmentId, op.prior?.kind ?? null);
      return true;
    case 'reslug': {
      const store = createAttachmentStore();
      // A pending rename that never happened has nothing to undo.
      const renamed = op.target ? await store.findBySlug(op.target, projectRoot) : null;
      if (op.slug && op.target && renamed) {
        await renameDocSlug(projectRoot, {
          oldSlug: op.target,
          newSlug: op.slug,
          reason: 'modernize-rollback',
          authorAgentId: ACTOR,
        });
      }
      return true;
    }
    case 'link-task': {
      const store = createAttachmentStore();
      const refs = op.attachmentId ? await store.listRefs(op.attachmentId, projectRoot) : [];
      if (op.attachmentId && op.ownerId && refs.some((r) => r.ownerId === op.ownerId)) {
        await store.deref(op.attachmentId, IMPORT_OWNER_TYPE, op.ownerId, projectRoot);
      }
      return true;
    }
    default:
      return false;
  }
}
