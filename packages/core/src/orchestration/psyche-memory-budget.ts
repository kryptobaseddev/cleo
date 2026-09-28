/**
 * PSYCHE-MEMORY block budgeting for spawn prompts (T12519 · E-TOKEN-ECONOMY).
 *
 * `buildRetrievalBundle` returns up to ~400 cold-pass user-profile traits plus
 * the ten most recent learnings, patterns and decisions. It does not consider
 * the task being spawned. Rendering all of it made the PSYCHE-MEMORY block
 * about 51 % of a tier-1 prompt (measured 2026-09-27: ~3,844 of 7,497 tokens).
 * Most of that was operation receipts ("Cleo tasks update operation
 * succeeded") and dispatch traces.
 *
 * This module turns a bundle into a bounded block:
 *
 * 1. **Exclude noise.** Drop entries that only record an operation succeeding,
 *    and serialized dispatch traces. See {@link isOperationReceiptText} for why
 *    this is a text match rather than a field match.
 * 2. **Rank by relevance to the spawned task.** First by overlap with the
 *    task's id, epic, labels and files. Then by stored quality score. Then by
 *    citation count.
 * 3. **Cap at a token budget** ({@link PSYCHE_MEMORY_TOKEN_BUDGET}) using the
 *    repo's `estimateTokens` (chars / 4). Entries are admitted whole or not at
 *    all, never cut mid-entry. The omitted count is surfaced as a single
 *    `cleo memory find` pointer line.
 *
 * @module orchestration/psyche-memory-budget
 * @task T12519
 * @epic T12484
 */

import type { RetrievalBundle, Task } from '@cleocode/contracts';
import { isDispatchTraceText } from '../memory/dispatch-trace-format.js';
import { estimateTokens } from '../metrics/token-estimation.js';

/** Default token budget for the whole `## PSYCHE-MEMORY` block (T12519). */
export const PSYCHE_MEMORY_TOKEN_BUDGET = 800;

/**
 * Text shapes that mark an entry as a bare operation receipt.
 *
 * **Why text and not a field (checked 2026-09-27 against the live stores):**
 * the receipts reach the prompt as cold-pass user-profile traits. Of 403
 * traits at confidence ≥ 0.5, 399 have `source='dialectic:<sessionId>'`, and
 * every one of those has `reinforcementCount=1`. That is true of the receipts
 * and of the genuine traits alike, and there is no type or kind column. No
 * stored field separates "Operation succeeded in domain 'check'" from "User is
 * concise and makes direct instructions." The Dialectic Evaluator derives them
 * the same way. The patterns below are anchored to the receipt wording seen in
 * the stores, not to general words like "success".
 */
const OPERATION_RECEIPT_PATTERNS: readonly RegExp[] = [
  // "Operation succeeded in domain 'check'" · "Cleo tasks update operation succeeded"
  /\boperation succeeded\b/i,
  // "... succeeded in domain 'docs'" · "succeeded for taskId T382"
  /\bsucceeded (?:in|for) (?:the )?(?:domain|task)/i,
  // "cleo successfully executed operation 'set'" · "gate ... is successfully set"
  /\bsuccessfully (?:executed|set|updated|completed|recorded)\b/i,
  // "set taskId in gate successfully"
  /\bgate successfully\b/i,
  // "Gate 'qaPassed' set to true for task T12240" · "Gate status set to 'implemented'"
  /\bgate(?:\s+status)?(?:\s+['"]?\w+['"]?)?\s+(?:is\s+)?set\s+(?:to|for)\b/i,
  // "cleo set implemented gate for T776"
  /\bset\s+(?:the\s+)?['"]?\w+['"]?\s+gate\s+for\b/i,
  // "Passed test gates for T388"
  /^passed (?:test |all )?gates? for\b/i,
];

/**
 * Whether memory text only records that an operation succeeded, or is a
 * serialized dispatch trace. Such text carries no knowledge a spawned agent
 * can act on.
 *
 * @param text - Entry text (trait value, pattern, insight, title, …).
 * @returns `true` when the entry is noise and must not be injected.
 */
export function isOperationReceiptText(text: string): boolean {
  const trimmed = text.trim();
  if (isDispatchTraceText(trimmed)) return true;
  return OPERATION_RECEIPT_PATTERNS.some((re) => re.test(trimmed));
}

/** Task facts used to rank memory entries by relevance. */
export interface PsycheRelevanceContext {
  /** Id of the task being spawned. */
  taskId: string;
  /** Parent (epic) id of the spawned task, when it has one. */
  epicId?: string | null;
  /** Task labels. */
  labels?: readonly string[];
  /** Files the task declares. */
  files?: readonly string[];
}

/**
 * Derive a {@link PsycheRelevanceContext} from a task record.
 *
 * @param task - The task being spawned.
 * @returns The relevance context for ranking memory entries.
 */
export function relevanceContextFromTask(task: Task): PsycheRelevanceContext {
  return {
    taskId: task.id,
    epicId: task.parentId ?? null,
    labels: task.labels ?? [],
    files: task.files ?? [],
  };
}

/** Section headings, in render order. */
const SECTION_ORDER = [
  'User Profile',
  'Peer Instructions',
  'Key Decisions',
  'Patterns',
  'Learnings',
  'Session Narrative',
  'Recent Observations',
  'Active Tasks',
] as const;

type SectionName = (typeof SECTION_ORDER)[number];

/** One renderable memory entry, with its ranking signals. */
interface Candidate {
  section: SectionName;
  /** The rendered markdown line(s) for this entry. */
  text: string;
  /** Text used for overlap matching. */
  matchText: string;
  /** The stored value alone, used for noise classification. */
  noiseText: string;
  /** Always ranked ahead of everything else (deliberately configured identity). */
  pinned: boolean;
  /** Explicitly linked task/epic ids (e.g. a decision's `context_task_id`). */
  linkedIds: readonly string[];
  /** Quality in [0, 1] — stored `quality_score`, or trait confidence. */
  quality: number;
  /** Citation / reinforcement count. */
  citations: number;
  /** Original position, for a stable tie-break (recency order from the bundle). */
  order: number;
}

/** Collapse runs of whitespace (including newlines) so each entry is one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token, case-insensitive mention of `needle` in `haystack`. */
function mentions(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, 'i').test(haystack);
}

/**
 * Score how strongly an entry overlaps the spawned task.
 *
 * Weights: task id 8, epic id 4, each declared file 3, each label 2 (at most
 * three labels count). The exact values matter less than their order. A
 * direct task link outranks an epic link, which outranks topical overlap.
 *
 * @param candidate - Entry under consideration.
 * @param ctx - Relevance facts of the spawned task.
 * @returns A non-negative overlap score; 0 means no overlap.
 */
function overlapScore(candidate: Candidate, ctx: PsycheRelevanceContext): number {
  const text = candidate.matchText;
  let score = 0;
  if (candidate.linkedIds.includes(ctx.taskId) || mentions(text, ctx.taskId)) score += 8;
  if (ctx.epicId && (candidate.linkedIds.includes(ctx.epicId) || mentions(text, ctx.epicId))) {
    score += 4;
  }
  for (const file of ctx.files ?? []) {
    const base = file.split('/').pop() ?? file;
    if (text.includes(file) || (base.length >= 5 && base.includes('.') && text.includes(base))) {
      score += 3;
    }
  }
  let labelHits = 0;
  for (const label of ctx.labels ?? []) {
    if (labelHits >= 3) break;
    if (label.length >= 3 && mentions(text, label)) {
      score += 2;
      labelHits += 1;
    }
  }
  return score;
}

/**
 * Weight applied to a trait that has been observed only once
 * (`reinforcementCount <= 1`).
 */
const UNCONFIRMED_TRAIT_WEIGHT = 0.5;

/**
 * Put a user-profile trait's quality on the same scale as the stored
 * `quality_score` of decisions, learnings and patterns.
 *
 * A trait's `confidence` is the Dialectic Evaluator's certainty about a single
 * extraction, not a curated quality score. Measured 2026-09-27, 399 of 403
 * traits sat at 0.95–1.0 with `reinforcementCount=1`, which is above every
 * curated decision (≈0.9). Traits confirmed only once are therefore
 * discounted. A trait reinforced more than once keeps its full confidence.
 *
 * @param trait - A cold-pass user-profile trait.
 * @returns Quality in [0, 1], comparable with a stored `quality_score`.
 */
function traitQuality(trait: RetrievalBundle['cold']['userProfile'][number]): number {
  return trait.reinforcementCount > 1
    ? trait.confidence
    : trait.confidence * UNCONFIRMED_TRAIT_WEIGHT;
}

/** Flatten a bundle into renderable candidates (sigil card excluded — it is fixed). */
function collectCandidates(bundle: RetrievalBundle): Candidate[] {
  const out: Candidate[] = [];
  let order = 0;
  const push = (c: Omit<Candidate, 'order'>): void => {
    out.push({ ...c, order: order++ });
  };

  for (const trait of bundle.cold.userProfile) {
    push({
      section: 'User Profile',
      text: `- **${trait.traitKey}**: ${oneLine(trait.traitValue)}`,
      matchText: `${trait.traitKey} ${trait.traitValue}`,
      noiseText: trait.traitValue,
      pinned: false,
      linkedIds: [],
      quality: traitQuality(trait),
      citations: trait.reinforcementCount,
    });
  }
  if (bundle.cold.peerInstructions) {
    push({
      section: 'Peer Instructions',
      text: bundle.cold.peerInstructions,
      matchText: bundle.cold.peerInstructions,
      noiseText: bundle.cold.peerInstructions,
      pinned: true,
      linkedIds: [],
      quality: 1,
      citations: 0,
    });
  }
  for (const d of bundle.warm.decisions) {
    push({
      section: 'Key Decisions',
      text: `- [${d.id}] ${oneLine(d.decision)}`,
      matchText: d.decision,
      noiseText: d.decision,
      pinned: false,
      linkedIds: [d.contextTaskId, d.contextEpicId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
      quality: d.qualityScore ?? 0.5,
      citations: d.citationCount ?? 0,
    });
  }
  for (const p of bundle.warm.peerPatterns) {
    push({
      section: 'Patterns',
      text: `- [${p.id}] ${oneLine(p.pattern)}`,
      matchText: p.pattern,
      noiseText: p.pattern,
      pinned: false,
      linkedIds: [],
      quality: p.qualityScore ?? 0.5,
      citations: p.citationCount ?? 0,
    });
  }
  for (const l of bundle.warm.peerLearnings) {
    push({
      section: 'Learnings',
      text: `- [${l.id}] ${oneLine(l.insight)}`,
      matchText: l.insight,
      noiseText: l.insight,
      pinned: false,
      linkedIds: [],
      quality: l.qualityScore ?? 0.5,
      citations: l.citationCount ?? 0,
    });
  }
  if (bundle.hot.sessionNarrative) {
    push({
      section: 'Session Narrative',
      text: bundle.hot.sessionNarrative,
      matchText: bundle.hot.sessionNarrative,
      noiseText: bundle.hot.sessionNarrative,
      pinned: false,
      linkedIds: [],
      quality: 0.5,
      citations: 0,
    });
  }
  for (const o of bundle.hot.recentObservations) {
    push({
      section: 'Recent Observations',
      text: `- [${o.id}] ${oneLine(o.title)}`,
      matchText: `${o.title} ${o.narrative}`,
      noiseText: o.title,
      pinned: false,
      linkedIds: [],
      quality: o.qualityScore ?? 0.5,
      citations: o.citationCount ?? 0,
    });
  }
  for (const t of bundle.hot.activeTasks) {
    push({
      section: 'Active Tasks',
      text: `- ${t.id}: ${oneLine(t.title)} (${t.status})`,
      matchText: t.title,
      noiseText: t.title,
      pinned: false,
      linkedIds: [t.id],
      quality: 0.5,
      citations: 0,
    });
  }
  return out;
}

/** Inputs for {@link buildBudgetedPsycheMemoryBlock}. */
export interface BudgetedPsycheMemoryInput {
  /** Retrieval bundle from `buildRetrievalBundle`. */
  bundle: RetrievalBundle;
  /** Relevance facts of the spawned task. */
  relevance: PsycheRelevanceContext;
  /** Pre-rendered, already-bounded Tier-2 attention digest lines (T11374). */
  attentionDigestLines?: readonly string[];
  /** Token budget for the whole block. Defaults to {@link PSYCHE_MEMORY_TOKEN_BUDGET}. */
  tokenBudget?: number;
}

/** Result of {@link buildBudgetedPsycheMemoryBlock}. */
export interface BudgetedPsycheMemoryResult {
  /** The rendered `## PSYCHE-MEMORY` markdown section. */
  block: string;
  /** Estimated tokens of `block` (chars / 4). */
  tokens: number;
  /** Entries rendered. */
  shown: number;
  /** Relevant (non-noise) entries omitted because the budget ran out. */
  omitted: number;
  /** Entries dropped as operation receipts / dispatch traces. */
  excludedNoise: number;
}

/**
 * Render the `## PSYCHE-MEMORY` block under a token budget.
 *
 * The header, the attention digest (already bounded by its own renderer) and
 * the sigil card are fixed. Every other entry competes for the remaining
 * budget in rank order: pinned first, then overlap score, then quality, then
 * citations, then bundle (recency) order. An entry that does not fit is skipped
 * whole, and a smaller one further down may still fit. Admitted entries render
 * grouped under their usual section headings, in rank order within each
 * section.
 *
 * @param input - Bundle, relevance context, attention lines and budget.
 * @returns The rendered block plus accounting.
 *
 * @example
 * ```ts
 * const { block } = buildBudgetedPsycheMemoryBlock({
 *   bundle,
 *   relevance: relevanceContextFromTask(task),
 * });
 * ```
 */
export function buildBudgetedPsycheMemoryBlock(
  input: BudgetedPsycheMemoryInput,
): BudgetedPsycheMemoryResult {
  const { bundle, relevance, attentionDigestLines } = input;
  const budget = input.tokenBudget ?? PSYCHE_MEMORY_TOKEN_BUDGET;

  // -- Fixed lines: attention digest + sigil card.
  const fixedLines: string[] = [];
  if (attentionDigestLines && attentionDigestLines.length > 0) {
    fixedLines.push('', ...attentionDigestLines);
  }
  const sigil = bundle.cold.sigilCard;
  if (sigil) {
    fixedLines.push('', '### Active Peer Sigil');
    if (sigil.displayName) fixedLines.push(`- **Name**: ${sigil.displayName}`);
    if (sigil.role) fixedLines.push(`- **Role**: ${sigil.role}`);
    if (sigil.cantFile) fixedLines.push(`- **CANT file**: ${sigil.cantFile}`);
    if (sigil.capabilityFlags) fixedLines.push(`- **Capabilities**: ${sigil.capabilityFlags}`);
  }

  // -- Noise exclusion.
  const all = collectCandidates(bundle);
  const kept = all.filter((c) => c.pinned || !isOperationReceiptText(c.noiseText));
  const excludedNoise = all.length - kept.length;

  // -- Ranking.
  const scored = kept.map((c) => ({ c, overlap: overlapScore(c, relevance) }));
  scored.sort(
    (a, b) =>
      Number(b.c.pinned) - Number(a.c.pinned) ||
      b.overlap - a.overlap ||
      b.c.quality - a.c.quality ||
      b.c.citations - a.c.citations ||
      a.c.order - b.c.order,
  );

  // -- Reserve the header + pointer at worst-case width, then admit whole entries.
  //    Per-piece ceil() sums over-estimate the joined text, so the final block
  //    is guaranteed to fit the budget.
  const header = (shown: number, omitted: number, used: number): string =>
    `> Budget: ${used}/${budget} tokens · ${shown} shown · ${omitted} omitted · ` +
    `${excludedNoise} operation receipts excluded`;
  const pointer = (omitted: number): string =>
    `> ${omitted} more via \`cleo memory find "${relevance.taskId}"\``;
  const worst = 99999;
  let used =
    estimateTokens('## PSYCHE-MEMORY\n\n') +
    estimateTokens(`${header(worst, worst, worst)}\n`) +
    estimateTokens(`\n${pointer(worst)}\n`) +
    (fixedLines.length > 0 ? estimateTokens(`${fixedLines.join('\n')}\n`) : 0);

  const admitted = new Map<SectionName, string[]>();
  let omitted = 0;
  for (const { c } of scored) {
    const headingCost = admitted.has(c.section) ? 0 : estimateTokens(`\n### ${c.section}\n`);
    const cost = headingCost + estimateTokens(`${c.text}\n`);
    if (used + cost > budget) {
      omitted += 1;
      continue;
    }
    used += cost;
    const list = admitted.get(c.section) ?? [];
    list.push(c.text);
    admitted.set(c.section, list);
  }
  const shown = kept.length - omitted;

  // -- Render.
  const body: string[] = [];
  for (const section of SECTION_ORDER) {
    const entries = admitted.get(section);
    if (!entries) continue;
    body.push('', `### ${section}`, ...entries);
  }

  const lines: string[] = ['## PSYCHE-MEMORY', ''];
  const headerIndex = lines.length;
  lines.push(''); // placeholder — filled once the final size is known
  lines.push(...fixedLines, ...body);
  if (omitted > 0) lines.push('', pointer(omitted));
  if (fixedLines.length === 0 && body.length === 0 && omitted === 0) {
    lines.push(
      '',
      excludedNoise > 0
        ? '> No task-relevant memory context: every retrieved entry was an operation receipt.'
        : '> No memory context available. All entries are pending the T1147 W7 sweep (.132) ' +
            "to promote from 'unswept-pre-T1151' to 'swept-clean'. Proceed without memory context.",
    );
  }

  lines[headerIndex] = header(shown, omitted, 0);
  const sizeWithoutUsed = lines.join('\n');
  lines[headerIndex] = header(shown, omitted, estimateTokens(sizeWithoutUsed));
  const block = lines.join('\n');
  return { block, tokens: estimateTokens(block), shown, omitted, excludedNoise };
}
