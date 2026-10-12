/**
 * Docs triage — batch System One verdicts over the docs store (T13446).
 *
 * Thousands of docs sit in `draft` with empty `topics`/`related_tasks`; manual
 * triage does not scale. This module runs the registered `docs.triage`
 * decision site over a batch of docs (default: drafts, oldest first) and
 * produces PROPOSALS — a keep/update/supersede/archive verdict plus a
 * staleness score per doc. It never mutates a doc: the only write is the
 * opt-in `--record` path, which persists each verdict as a typed D####
 * decision (`confirmationState: 'proposed'`) via `storeDecision`, leaving the
 * docs store untouched.
 *
 * Each doc gets ONE {@link DecisionRequest} with two questions (`verdict` —
 * choice, `staleness` — score) and structured state (slug, kind, status,
 * topics, related tasks, summary, age, body excerpt); every string field is
 * redacted, then clipped, before it leaves the machine. Requests go out
 * through `decideBatch` in chunks the provider's batch capability can hold
 * (layahost: 64 requests / 256 questions). Unconfigured provider ⇒ mode
 * `off`, zero network, and every proposal is the rule fallback (age and
 * link/metadata heuristics). Provider `unauthorized` /
 * `insufficient_credits` answers abort the run: remaining chunks are skipped
 * and the report carries `aborted: true`.
 *
 * Mode comes from `decide.sites.docTriage` (`off | shadow | on`). `shadow`
 * (the registry default) asks and audits but the proposal that acts is the
 * heuristic's; the provider's answers ride along on the proposal for review.
 * `on` uses the decided verdict when it is valid and confident (≥
 * {@link DOC_TRIAGE_MIN_CONFIDENCE}).
 *
 * @task T13446
 * @saga T13339
 */

import type { DecisionAnswer, DecisionOutcome, DecisionRequest } from '@cleocode/contracts';
import { asc, eq } from 'drizzle-orm';
import type { DecisionAuditEntry, DecisionAuditSink } from '../decide/audit.js';
import { type DecideOptions, decideBatch } from '../decide/client.js';
import { redactThenClip, resolveDecisionSiteSettings } from '../decide/site.js';
import { DOC_TRIAGE_DECISION_SITE } from '../decide/sites/registry.js';
import { redactContent } from '../memory/redaction.js';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { getDb } from '../store/sqlite.js';
import {
  ATTACHMENT_LIFECYCLE_STATUSES,
  type AttachmentLifecycleStatus,
  attachmentRefs,
  attachments,
} from '../store/tasks-schema.js';

/** Call-site id for the triage decision; keys the audit line. */
export const DOC_TRIAGE_SITE = DOC_TRIAGE_DECISION_SITE.id;

/** Config key selecting the System One mode for docs triage. */
export const DOC_TRIAGE_MODE_KEY = DOC_TRIAGE_DECISION_SITE.modeKey;

/** The verdicts offered to the decision — the doc lifecycle actions a reviewer can take. */
export const DOC_TRIAGE_VERDICTS = ['keep', 'update', 'supersede', 'archive'] as const;

/** One of {@link DOC_TRIAGE_VERDICTS}. */
export type DocTriageVerdict = (typeof DOC_TRIAGE_VERDICTS)[number];

/** Staleness levels, lowest first (the `staleness` score question's scale). */
export const DOC_TRIAGE_STALENESS_LEVELS = [
  'current — the doc reflects the system as it is today',
  'minor drift — small details have aged but the substance holds',
  'dated — parts no longer match the system; a refresh is due',
  'stale — substantially outdated or abandoned as a draft',
  'abandoned — untouched for a year or more with no links or metadata signal',
] as const;

/** Minimum confidence the decided answers need before `on` mode uses them. */
export const DOC_TRIAGE_MIN_CONFIDENCE = 0.6;

/** Default number of docs one triage run scans. */
export const DOC_TRIAGE_DEFAULT_LIMIT = 25;

/** Per-chunk size for `decideBatch` — inside the layahost 64-request batch cap. */
export const DOC_TRIAGE_BATCH_CHUNK = 64;

/** Whole-chunk deadline handed to `decideBatch`, in ms. */
export const DOC_TRIAGE_BATCH_TIMEOUT_MS = 120_000;

/** Per-field character caps for the decision state. */
const SLUG_MAX_CHARS = 200;
const KIND_MAX_CHARS = 40;
const SUMMARY_MAX_CHARS = 400;
const LIST_MAX_CHARS = 200;
const EXCERPT_MAX_CHARS = 2_000;

/** Question names keying the request and its answers. */
const VERDICT_QUESTION = 'verdict';
const STALENESS_QUESTION = 'staleness';

/** Fallback reasons that abort the run (credit exhaustion, bad credentials). */
const ABORT_REASONS = new Set(['unauthorized', 'insufficient_credits']);

const VERDICT_CRITERIA: Record<DocTriageVerdict, string> = {
  keep: 'The doc is accurate, linked (topics or related tasks set) and still useful as-is.',
  update:
    'The doc is worth keeping but needs a content or metadata refresh — empty topics/related_tasks, aged details, or a draft that was never finished.',
  supersede: 'A newer doc covers the same ground; this one should be marked superseded by it.',
  archive: 'The doc is no longer relevant to the project; archive it.',
};

/** One doc selected for triage, with the metadata the request and heuristic need. */
export interface DocTriageCandidate {
  /** Attachment id (UUID). */
  readonly attachmentId: string;
  /** Content address. */
  readonly sha256: string;
  /** Stable slug, when the doc has one. */
  readonly slug: string | null;
  /** Taxonomy kind (adr, spec, research …). */
  readonly kind: string | null;
  /** Lifecycle status the candidate was selected by. */
  readonly status: string;
  /** Canonical topic slugs (parsed from `attachments.topics`). */
  readonly topics: readonly string[];
  /** Related `T####` task ids (parsed from `attachments.related_tasks`). */
  readonly relatedTasks: readonly string[];
  /** One-sentence summary, when stored. */
  readonly summary: string | null;
  /** ISO 8601 creation timestamp. */
  readonly createdAt: string;
  /** Owning entity (task/session id) from the first attachment ref. */
  readonly ownerId: string | null;
}

/** The rule fallback's verdict for one candidate. */
export interface DocTriageHeuristic {
  /** Verdict the heuristic proposes. */
  readonly verdict: DocTriageVerdict;
  /** 0-based index into {@link DOC_TRIAGE_STALENESS_LEVELS}. */
  readonly staleness: number;
  /** One-line explanation for audits and rationales. */
  readonly rationale: string;
}

/** One triage proposal. The docs store is never mutated — this is advisory. */
export interface DocTriageProposal {
  /** Attachment id. */
  readonly attachmentId: string;
  /** Slug, when the doc has one. */
  readonly slug: string | null;
  /** Taxonomy kind. */
  readonly kind: string | null;
  /** The verdict that acts: the heuristic's in `off`/`shadow`, the decision's in `on`. */
  readonly verdict: DocTriageVerdict;
  /** `system-one` only when `on` mode acted on a confident, valid answer. */
  readonly source: 'rule' | 'system-one';
  /** Confidence of the acting verdict (flat 0.5 for the rule fallback). */
  readonly confidence: number;
  /** Acting staleness level (0-based into {@link DOC_TRIAGE_STALENESS_LEVELS}). */
  readonly staleness: number;
  /** Human label of the acting staleness level. */
  readonly stalenessLabel: string;
  /** Why this verdict was proposed. */
  readonly rationale: string;
  /** The provider's answers, when one answered (shadow-mode visibility). */
  readonly decided?: {
    readonly verdict: DocTriageVerdict | null;
    readonly verdictConfidence: number;
    readonly staleness: number | null;
    readonly stalenessConfidence: number;
  };
  /** The recorded D#### decision id, set only on the `--record` path. */
  readonly decisionId?: string;
}

/** The result of one {@link triageDocs} run. */
export interface DocsTriageReport {
  /** The decision site that produced the verdicts. */
  readonly site: string;
  /** Effective site mode (`off` when no provider is configured). */
  readonly mode: 'off' | 'shadow' | 'on';
  /** Lifecycle status that was scanned. */
  readonly status: string;
  /** Candidates selected. */
  readonly scanned: number;
  /** Proposals recorded as D#### decisions (`--record` only). */
  readonly recorded: number;
  /** True when the run aborted early on `unauthorized` / `insufficient_credits`. */
  readonly aborted: boolean;
  /** Why the run aborted, when it did. */
  readonly abortReason?: string;
  /** Fallback-reason histogram across every asked question (empty in `off`). */
  readonly fallbackReasons: Record<string, number>;
  /** One proposal per scanned doc, oldest first. */
  readonly proposals: readonly DocTriageProposal[];
}

/** Options for {@link listTriageCandidates}. */
export interface ListTriageCandidatesOptions {
  /** Lifecycle status to select. Default `'draft'`. */
  readonly status?: string;
  /** Maximum candidates, oldest first. Default {@link DOC_TRIAGE_DEFAULT_LIMIT}. */
  readonly limit?: number;
  /** Project root for the store. Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
}

/** Parse a nullable JSON-array column (`topics`, `related_tasks`) into strings. */
function parseStringArray(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Select triage candidates from the attachments store: one row per doc with a
 * slug, filtered by lifecycle status (`draft` by default), oldest first.
 *
 * Read-only: this is a drizzle SELECT through the canonical `getDb`
 * chokepoint, never a write.
 *
 * @param opts - Status filter, limit and project root.
 * @returns The candidates, oldest first.
 */
export async function listTriageCandidates(
  opts: ListTriageCandidatesOptions = {},
): Promise<DocTriageCandidate[]> {
  const status = opts.status ?? 'draft';
  const limit = opts.limit ?? DOC_TRIAGE_DEFAULT_LIMIT;
  if (!(ATTACHMENT_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Invalid lifecycle status '${status}'. Valid: ${ATTACHMENT_LIFECYCLE_STATUSES.join(', ')}`,
    );
  }
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const db = await getDb(projectRoot);
  const rows = await db
    .select({
      id: attachments.id,
      sha256: attachments.sha256,
      slug: attachments.slug,
      type: attachments.type,
      lifecycleStatus: attachments.lifecycleStatus,
      topics: attachments.topics,
      relatedTasks: attachments.relatedTasks,
      summary: attachments.summary,
      createdAt: attachments.createdAt,
      ownerId: attachmentRefs.ownerId,
    })
    .from(attachments)
    .leftJoin(attachmentRefs, eq(attachmentRefs.attachmentId, attachments.id))
    .where(eq(attachments.lifecycleStatus, status as AttachmentLifecycleStatus))
    .orderBy(asc(attachments.createdAt))
    .all();

  const seen = new Set<string>();
  const out: DocTriageCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      attachmentId: row.id,
      sha256: row.sha256,
      slug: row.slug ?? null,
      kind: row.type ?? null,
      status: row.lifecycleStatus,
      topics: parseStringArray(row.topics),
      relatedTasks: parseStringArray(row.relatedTasks),
      summary: row.summary ?? null,
      createdAt: row.createdAt,
      ownerId: row.ownerId ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Whole days between `createdAt` and `now`; never negative. */
function ageDays(createdAt: string, now: Date): number {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * The rule fallback: a deterministic verdict from age, lifecycle status and
 * whether the doc carries any topics or related-task links.
 *
 * - Non-draft docs and linked drafts that are still fresh: `keep`.
 * - Drafts missing all metadata, or linked drafts that have drifted: `update`.
 * - Unlinked drafts untouched for a year or more: `archive`.
 *
 * @param doc - The candidate.
 * @param now - The clock reading the age is measured against.
 * @returns The heuristic verdict, staleness level and rationale.
 */
export function heuristicDocTriage(doc: DocTriageCandidate, now: Date): DocTriageHeuristic {
  const age = ageDays(doc.createdAt, now);
  const linked = doc.topics.length > 0 || doc.relatedTasks.length > 0;
  let staleness = age < 30 ? 0 : age < 90 ? 1 : age < 180 ? 2 : age < 365 ? 3 : 4;
  if (!linked) staleness = Math.min(staleness + 1, DOC_TRIAGE_STALENESS_LEVELS.length - 1);

  if (doc.status !== 'draft') {
    return {
      verdict: 'keep',
      staleness,
      rationale: `status '${doc.status}' is past the draft gate; triage only proposes on drafts`,
    };
  }
  if (linked && staleness <= 1) {
    return {
      verdict: 'keep',
      staleness,
      rationale: 'draft with topics/related-task links, still fresh',
    };
  }
  if (!linked && age >= 365) {
    return {
      verdict: 'archive',
      staleness,
      rationale: `draft with no topics or related tasks, untouched for ${age} days`,
    };
  }
  return {
    verdict: 'update',
    staleness,
    rationale: linked
      ? `linked draft showing drift (${age} days old)`
      : `draft with empty topics/related_tasks (${age} days old) — needs metadata`,
  };
}

/**
 * Build the decision request for one candidate: structured state (every
 * string redacted, then clipped) plus the `verdict` choice and `staleness`
 * score questions.
 *
 * @param doc - The candidate.
 * @param bodyExcerpt - Body text excerpt (already fetched), when readable.
 * @param now - Clock reading for the age field.
 * @returns The request.
 */
export function buildDocTriageRequest(
  doc: DocTriageCandidate,
  bodyExcerpt: string | null,
  now: Date,
): DecisionRequest {
  const redact = (s: string): string => redactContent(s).content;
  return {
    state: {
      slug: redactThenClip(doc.slug ?? doc.attachmentId, SLUG_MAX_CHARS, redact),
      kind: redactThenClip(doc.kind ?? 'unknown', KIND_MAX_CHARS, redact),
      status: doc.status,
      topics: redactThenClip(doc.topics.join(', '), LIST_MAX_CHARS, redact),
      relatedTasks: redactThenClip(doc.relatedTasks.join(', '), LIST_MAX_CHARS, redact),
      summary: redactThenClip(doc.summary ?? '', SUMMARY_MAX_CHARS, redact),
      ageDays: ageDays(doc.createdAt, now),
      ...(bodyExcerpt !== null
        ? { bodyExcerpt: redactThenClip(bodyExcerpt, EXCERPT_MAX_CHARS, redact) }
        : {}),
    },
    questions: {
      [VERDICT_QUESTION]: {
        type: 'choice',
        instructions:
          'Triage verdict for this document. Judge from its status, age, links and content.',
        criteria: VERDICT_CRITERIA,
      },
      [STALENESS_QUESTION]: {
        type: 'score',
        instructions: 'How stale is this document relative to the system it describes?',
        criteria: DOC_TRIAGE_STALENESS_LEVELS,
      },
    },
  };
}

/** Whether `value` is one of the offered verdicts. */
function isTriageVerdict(value: unknown): value is DocTriageVerdict {
  return (DOC_TRIAGE_VERDICTS as readonly unknown[]).includes(value);
}

/** Fetch a body excerpt for one candidate from the attachment store. */
async function fetchExcerpt(doc: DocTriageCandidate, projectRoot: string): Promise<string | null> {
  try {
    const store = createAttachmentStore();
    const result = await store.get(doc.sha256, projectRoot);
    return result ? result.bytes.toString('utf-8') : null;
  } catch {
    return null;
  }
}

/** An audit sink that counts fallback reasons and spots abort conditions. */
function collectingAudit(): {
  readonly sink: DecisionAuditSink;
  readonly fallbackReasons: Record<string, number>;
  readonly state: { abortReason?: string };
} {
  const fallbackReasons: Record<string, number> = {};
  const state: { abortReason?: string } = {};
  return {
    fallbackReasons,
    state,
    sink: {
      write(entry: DecisionAuditEntry): void {
        const reason = entry.fallbackReason;
        if (reason === undefined) return;
        fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
        if (state.abortReason === undefined && ABORT_REASONS.has(reason)) {
          state.abortReason = reason;
        }
      },
    },
  };
}

/** Map a numeric confidence onto the brain decision confidence enum. */
function toConfidenceLevel(confidence: number): 'low' | 'medium' | 'high' {
  return confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';
}

/** Read the provider's `verdict`/`staleness` answers off an outcome, when valid. */
function decidedAnswers(outcome: DecisionOutcome): DocTriageProposal['decided'] | undefined {
  if (outcome.source === 'fallback') return undefined;
  const verdict = outcome.answers[VERDICT_QUESTION];
  const staleness = outcome.answers[STALENESS_QUESTION];
  if (verdict?.type !== 'choice' || staleness?.type !== 'score') return undefined;
  return {
    verdict: isTriageVerdict(verdict.value) ? verdict.value : null,
    verdictConfidence: verdict.confidence,
    staleness:
      staleness.value >= 0 && staleness.value < DOC_TRIAGE_STALENESS_LEVELS.length
        ? staleness.value
        : null,
    stalenessConfidence: staleness.confidence,
  };
}

/** Options for {@link triageDocs}. */
export interface TriageDocsOptions {
  /** Lifecycle status to scan. Default `'draft'`. */
  readonly status?: string;
  /** Maximum docs to scan, oldest first. Default {@link DOC_TRIAGE_DEFAULT_LIMIT}. */
  readonly limit?: number;
  /** Persist every proposal as a `proposed` D#### decision. Default false (dry report). */
  readonly record?: boolean;
  /** Explicit site mode; wins over config when a provider is configured. */
  readonly mode?: 'off' | 'shadow' | 'on';
  /** Provider, connection, budget, cache and audit wiring forwarded to `decideBatch()`. */
  readonly decide?: DecideOptions;
  /** Project root for the store, config lookup and the audit sink. */
  readonly projectRoot?: string;
  /** Clock override (tests pin the age heuristic). */
  readonly now?: Date;
}

/**
 * Batch-triage docs through the `docs.triage` site.
 *
 * Produces one proposal per scanned doc and NEVER mutates a doc. With
 * `record: true` each proposal is persisted as a typed D#### decision
 * (`confirmationState: 'proposed'`, `decidedBy: 'agent'`) whose text names the
 * doc slug, so the verdicts stay reviewable and reversible. An
 * `unauthorized`/`insufficient_credits` answer aborts the run before the next
 * chunk goes out.
 *
 * @param opts - Status filter, limit, record flag, mode and wiring.
 * @returns The triage report.
 */
export async function triageDocs(opts: TriageDocsOptions = {}): Promise<DocsTriageReport> {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const now = opts.now ?? new Date();
  const status = opts.status ?? 'draft';
  const candidates = await listTriageCandidates({ status, limit: opts.limit, projectRoot });

  const collector = collectingAudit();
  const proposals: DocTriageProposal[] = [];
  let recorded = 0;

  const heuristics = candidates.map((doc) => heuristicDocTriage(doc, now));
  const settings = await resolveDecisionSiteSettings({
    modeKey: DOC_TRIAGE_MODE_KEY,
    mode: opts.mode,
    wiring: opts.decide,
    projectRoot,
  });

  if (settings.mode !== 'off' && candidates.length > 0) {
    const entries = await Promise.all(
      candidates.map(async (doc, i) => {
        const heuristic = heuristics[i]!;
        const excerpt = await fetchExcerpt(doc, projectRoot);
        const heuristicAnswers: Record<string, DecisionAnswer> = {
          [VERDICT_QUESTION]: {
            type: 'choice',
            value: heuristic.verdict,
            probabilities: Object.fromEntries(
              DOC_TRIAGE_VERDICTS.map((v) => [v, v === heuristic.verdict ? 1 : 0]),
            ),
            confidence: 0.5,
          },
          [STALENESS_QUESTION]: {
            type: 'score',
            value: heuristic.staleness,
            probabilities: DOC_TRIAGE_STALENESS_LEVELS.map((_, k) =>
              k === heuristic.staleness ? 1 : 0,
            ),
            confidence: 0.5,
          },
        };
        return {
          req: buildDocTriageRequest(doc, excerpt, now),
          fallback: () => heuristicAnswers,
        };
      }),
    );

    const outcomes: DecisionOutcome[] = new Array(entries.length);
    // Audit: every asked question lands in the standard decisions.jsonl trail
    // (the shadow-mode observability every site gets) AND in the collector
    // that drives this report's fallback-reason histogram and abort flag.
    let fileSink: DecisionAuditSink | null = null;
    if (opts.decide?.audit === undefined) {
      try {
        const { createJsonlDecisionAudit } = await import('../decide/audit.js');
        fileSink = createJsonlDecisionAudit(projectRoot);
      } catch {
        fileSink = null;
      }
    } else {
      fileSink = opts.decide.audit;
    }
    const base = fileSink;
    const audit: DecisionAuditSink = {
      write(entry: DecisionAuditEntry): void {
        collector.sink.write(entry);
        base?.write(entry);
      },
    };
    for (let start = 0; start < entries.length; start += DOC_TRIAGE_BATCH_CHUNK) {
      if (collector.state.abortReason !== undefined) break;
      const chunk = entries.slice(start, start + DOC_TRIAGE_BATCH_CHUNK);
      const chunkOutcomes = await decideBatch(DOC_TRIAGE_SITE, chunk, {
        ...opts.decide,
        audit,
        timeoutMs: opts.decide?.timeoutMs ?? DOC_TRIAGE_BATCH_TIMEOUT_MS,
        projectRoot,
      });
      for (const [k, outcome] of chunkOutcomes.entries()) outcomes[start + k] = outcome;
    }

    for (const [i, doc] of candidates.entries()) {
      const heuristic = heuristics[i]!;
      const outcome = outcomes[i];
      const decided = outcome ? decidedAnswers(outcome) : undefined;
      let verdict = heuristic.verdict;
      let staleness = heuristic.staleness;
      let source: DocTriageProposal['source'] = 'rule';
      let confidence = 0.5;
      if (
        settings.mode === 'on' &&
        decided?.verdict != null &&
        decided.verdictConfidence >= DOC_TRIAGE_MIN_CONFIDENCE
      ) {
        verdict = decided.verdict;
        source = 'system-one';
        confidence = decided.verdictConfidence;
        if (decided.staleness !== null && decided.stalenessConfidence >= DOC_TRIAGE_MIN_CONFIDENCE)
          staleness = decided.staleness;
      }
      proposals.push({
        attachmentId: doc.attachmentId,
        slug: doc.slug,
        kind: doc.kind,
        verdict,
        source,
        confidence,
        staleness,
        stalenessLabel: DOC_TRIAGE_STALENESS_LEVELS[staleness] ?? String(staleness),
        rationale: heuristic.rationale,
        ...(decided !== undefined ? { decided } : {}),
      });
    }
  } else {
    for (const [i, doc] of candidates.entries()) {
      const heuristic = heuristics[i]!;
      proposals.push({
        attachmentId: doc.attachmentId,
        slug: doc.slug,
        kind: doc.kind,
        verdict: heuristic.verdict,
        source: 'rule',
        confidence: 0.5,
        staleness: heuristic.staleness,
        stalenessLabel: DOC_TRIAGE_STALENESS_LEVELS[heuristic.staleness] ?? '',
        rationale: heuristic.rationale,
      });
    }
  }

  if (opts.record === true && proposals.length > 0) {
    const { storeDecision } = await import('../memory/decisions.js');
    for (const [i, proposal] of proposals.entries()) {
      const ownerId = candidates[i]?.ownerId ?? null;
      const handle = proposal.slug ?? proposal.attachmentId;
      const decidedNote =
        proposal.decided?.verdict != null
          ? ` System One (${settings.mode}) answered '${proposal.decided.verdict}' at confidence ${proposal.decided.verdictConfidence.toFixed(2)}.`
          : '';
      const row = await storeDecision(projectRoot, {
        type: 'process',
        decision: `docs.triage verdict for ${handle}: ${proposal.verdict}`,
        rationale:
          `${proposal.rationale}. Staleness: ${proposal.stalenessLabel}. ` +
          `Source: ${proposal.source} (confidence ${proposal.confidence.toFixed(2)}).` +
          decidedNote +
          ` Site ${DOC_TRIAGE_SITE} (T13446); proposal only — the doc was not mutated.`,
        confidence: toConfidenceLevel(proposal.confidence),
        ...(ownerId !== null && /^T\d+$/.test(ownerId) ? { contextTaskId: ownerId } : {}),
        confirmationState: 'proposed',
        decidedBy: 'agent',
      });
      recorded += 1;
      proposals[i] = { ...proposal, decisionId: row.id };
    }
  }

  const aborted = collector.state.abortReason !== undefined;
  return {
    site: DOC_TRIAGE_SITE,
    mode: settings.mode,
    status,
    scanned: candidates.length,
    recorded,
    aborted,
    ...(aborted ? { abortReason: collector.state.abortReason } : {}),
    fallbackReasons: collector.fallbackReasons,
    proposals,
  };
}
