/**
 * Shared plumbing for System One call sites: the `off | shadow | on` mode,
 * the generative-fallback opt-in, and redact-then-clip for state text.
 *
 * Every site resolves its settings the same way, so the rule that an
 * unconfigured provider means `off` (and therefore zero network) lives here
 * once. Heavy modules (credentials, config registry) load lazily: importing
 * this file costs nothing on a path that never asks a decision.
 *
 * @task T12493
 * @epic T12486
 */

import type {
  DecisionAnswer,
  DecisionOutcomeSource,
  DecisionRequest,
  DecisionSiteModeValue,
} from '@cleocode/contracts';
import type { DecisionAuditAnswer, DecisionAuditEntry, DecisionShadowRecord } from './audit.js';
import type { DecideOptions } from './client.js';

/**
 * How a call site uses System One.
 *
 * - `off` — never ask; the heuristic acts.
 * - `shadow` — ask, audit both answers, act on the heuristic.
 * - `on` — ask and act on the decision when it is confident enough.
 */
export type DecisionSiteMode = DecisionSiteModeValue;

/** Resolved settings for one call-site invocation. */
export interface DecisionSiteSettings {
  /** Effective mode; always `off` when no provider is configured. */
  readonly mode: DecisionSiteMode;
  /** Whether the site's older generative-LLM path runs. */
  readonly llmTier: boolean;
}

/** Inputs to {@link resolveDecisionSiteSettings}. */
export interface ResolveDecisionSiteSettingsInput {
  /** Config key holding the site mode, e.g. `decide.sites.duplicateDetection`. */
  readonly modeKey: string;
  /**
   * Config key holding the generative opt-in, e.g. `decide.generativeFallback.duplicateDetection`.
   * Absent for a site with no generative path: `llmTier` then comes from the
   * explicit input or {@link ResolveDecisionSiteSettingsInput.llmTierDefault}.
   */
  readonly llmTierKey?: string;
  /** Explicit mode; wins over config when a provider is configured. */
  readonly mode?: DecisionSiteMode;
  /** Explicit generative opt-in; wins over config. */
  readonly llmTier?: boolean;
  /**
   * Generative default when the config key is absent, given the effective
   * mode (`off` whenever System One is unconfigured). Sites whose generative
   * path ran unconditionally before System One use it to stay
   * behaviour-neutral outside `on`. Default: always `false`.
   */
  readonly llmTierDefault?: (mode: DecisionSiteMode) => boolean;
  /** The `decide()` wiring the site will use; an explicit provider or connection decides "configured". */
  readonly wiring?: DecideOptions;
  /** Project root for config lookup. Default: the resolved CLEO project root. */
  readonly projectRoot?: string;
}

/**
 * Type guard for {@link DecisionSiteMode}.
 *
 * @param value - Any config value.
 * @returns Whether `value` is `off`, `shadow` or `on`.
 */
export function isDecisionSiteMode(value: unknown): value is DecisionSiteMode {
  return value === 'off' || value === 'shadow' || value === 'on';
}

/**
 * Redact secrets, THEN clip to `max` characters, marking the cut.
 *
 * The order matters: clipping first can cut a secret in half, and a partial
 * secret no longer matches the redaction patterns — `decide()`'s own redaction
 * would then let the prefix through.
 *
 * @param text - Raw text.
 * @param max - Maximum length of the result, in UTF-16 characters.
 * @param redact - The redaction function (the memory redaction patterns).
 * @returns Redacted text of at most `max` characters.
 */
export function redactThenClip(text: string, max: number, redact: (s: string) => string): string {
  const safe = redact(text);
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

/**
 * Resolve a site's mode and generative opt-in.
 *
 * Unconfigured (no explicit provider/connection and nothing stored by
 * `cleo decide config`) always resolves to `off`, whatever the config says,
 * so an unconfigured site never opens a socket. Never throws: unreadable
 * credentials or config fall back to the defaults.
 *
 * @param input - Config keys, explicit overrides and wiring.
 * @returns The effective settings.
 */
export async function resolveDecisionSiteSettings(
  input: ResolveDecisionSiteSettingsInput,
): Promise<DecisionSiteSettings> {
  const wiring = input.wiring ?? {};
  let configured: boolean;
  if (wiring.provider) {
    configured = true;
  } else if (wiring.connection !== undefined) {
    configured = wiring.connection !== null && wiring.connection.apiKey.trim() !== '';
  } else {
    try {
      const { loadDecideConnection } = await import('./credentials.js');
      configured = loadDecideConnection() !== null;
    } catch {
      configured = false;
    }
  }

  const needConfig =
    (configured && input.mode === undefined) ||
    (input.llmTierKey !== undefined && input.llmTier === undefined);
  let configMode: unknown;
  let configLlmTier: unknown;
  if (needConfig) {
    try {
      const { getConfigValue } = await import('../config/registry.js');
      const { getProjectRoot } = await import('../paths.js');
      const projectRoot = input.projectRoot ?? getProjectRoot();
      const llmTierKey = input.llmTierKey;
      [configMode, configLlmTier] = await Promise.all([
        getConfigValue(input.modeKey, { projectRoot }),
        llmTierKey === undefined ? undefined : getConfigValue(llmTierKey, { projectRoot }),
      ]);
    } catch {
      // Unreadable config → defaults.
    }
  }

  const mode: DecisionSiteMode = !configured
    ? 'off'
    : (input.mode ?? (isDecisionSiteMode(configMode) ? configMode : 'shadow'));
  const llmTierDefault = input.llmTierDefault?.(mode) ?? false;
  const llmTier =
    input.llmTier ?? (typeof configLlmTier === 'boolean' ? configLlmTier : llmTierDefault);
  return { mode, llmTier };
}

/** Inputs to {@link askSiteDecision}. */
export interface AskSiteDecisionInput {
  /** Call-site id; keys the audit line. */
  readonly siteId: string;
  /**
   * Budget in ms for WAITING on the decision: request building, redaction, the
   * shared request budget and the provider round trip. It starts once the
   * decision modules are loaded — module loading is a cold-start cost, not
   * provider wait, and charging it would starve every fresh CLI process.
   */
  readonly budgetMs: number;
  /** Minimum confidence EVERY answer needs before `on` mode may act on the decision. */
  readonly minConfidence: number;
  /** Effective mode (`off` never reaches a decision). */
  readonly mode: Exclude<DecisionSiteMode, 'off'>;
  /** The heuristic's overall verdict, in the site's vocabulary. */
  readonly heuristicVerdict: string;
  /** Build the request; `redact` is the memory redaction, to apply BEFORE clipping. */
  readonly buildRequest: (redact: (s: string) => string) => DecisionRequest;
  /** The heuristic's answer to every question; also the fallback. */
  readonly heuristicAnswers: Readonly<Record<string, DecisionAnswer>>;
  /**
   * Site-level validity beyond the client's type check (e.g. a `choice` value
   * among the offered options). An answered but invalid outcome is audited as
   * `rejected: "invalid_choice"` and the heuristic acts. Default: valid.
   */
  readonly isValid?: (answers: Readonly<Record<string, DecisionAuditAnswer>>) => boolean;
  /** Whether valid decided answers agree with the heuristic, on the axis the site acts on. */
  readonly agree: (answers: Readonly<Record<string, DecisionAuditAnswer>>) => boolean;
  /** Per-question extras for the shadow record. */
  readonly shadowExtras?: Pick<
    DecisionShadowRecord,
    'heuristicVerdicts' | 'heuristicScores' | 'subjects'
  >;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. */
  readonly wiring?: DecideOptions;
  /** Project root for the default audit sink. */
  readonly projectRoot?: string;
}

/** A provider (or cached) answer that passed the site's validity check. */
export interface SiteDecision {
  /** The decided answers. */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** `provider` or `cache`. */
  readonly source: Exclude<DecisionOutcomeSource, 'fallback'>;
  /** Whether every answer met `minConfidence`; only then may `on` act. */
  readonly confident: boolean;
}

function allConfident(
  answers: Readonly<Record<string, { readonly confidence: number }>>,
  min: number,
): boolean {
  return Object.values(answers).every((a) => a.confidence >= min);
}

/**
 * Ask one budgeted System One decision for a call site, auditing the
 * heuristic's answers beside the decision's in the same `decisions.jsonl` line.
 *
 * Never throws. Heavy modules load lazily FIRST; then the deadline starts, and
 * the provider is never waited on longer than `budgetMs` (request building,
 * redaction, the audit sink and the client's own setup are inside it). Module
 * load is excluded on purpose: in a cold process it alone can exceed the
 * budget, and a budget that includes it means a fast provider never answers.
 *
 * @param input - Site id, budget, mode, request builder, heuristic and wiring.
 * @returns The decision, or `null` when the heuristic answered (fallback) or the answer was invalid.
 */
export async function askSiteDecision(input: AskSiteDecisionInput): Promise<SiteDecision | null> {
  try {
    const [{ decide }, { auditAnswers, createJsonlDecisionAudit }, { redactContent }, paths] =
      await Promise.all([
        import('./client.js'),
        import('./audit.js'),
        import('../memory/redaction.js'),
        import('../paths.js'),
      ]);
    // The wait budget starts now, with every module loaded.
    const started = performance.now();
    const deadline = AbortSignal.timeout(input.budgetMs);

    const req = input.buildRequest((text) => redactContent(text).content);
    const heuristicAudit = auditAnswers({
      answers: input.heuristicAnswers,
      source: 'fallback',
      latencyMs: 0,
    });
    const isValid = input.isValid ?? ((): boolean => true);

    const wiring = input.wiring ?? {};
    let sink = wiring.audit;
    if (sink === undefined) {
      try {
        sink = createJsonlDecisionAudit(
          wiring.projectRoot ?? input.projectRoot ?? paths.getProjectRoot(),
        );
      } catch {
        sink = null;
      }
    }
    const base = sink;
    const audit = base
      ? {
          write: (entry: DecisionAuditEntry): void => {
            const answered = entry.source !== 'fallback';
            const valid = answered && isValid(entry.answers);
            base.write({
              ...entry,
              shadow: {
                mode: input.mode,
                acted:
                  input.mode === 'on' && valid && allConfident(entry.answers, input.minConfidence)
                    ? 'decision'
                    : 'heuristic',
                heuristicVerdict: input.heuristicVerdict,
                heuristicAnswers: heuristicAudit,
                agree: valid ? input.agree(entry.answers) : null,
                ...input.shadowExtras,
                ...(answered && !valid ? { rejected: 'invalid_choice' as const } : {}),
              },
            });
          },
        }
      : null;

    const remaining = Math.max(0, input.budgetMs - (performance.now() - started));
    const outcome = await decide(input.siteId, req, () => input.heuristicAnswers, {
      ...wiring,
      audit,
      timeoutMs: Math.min(wiring.timeoutMs ?? remaining, remaining),
      signal: wiring.signal ? AbortSignal.any([wiring.signal, deadline]) : deadline,
    });
    if (outcome.source === 'fallback') return null;
    if (!isValid(auditAnswers(outcome))) return null;
    return {
      answers: outcome.answers,
      source: outcome.source,
      confident: allConfident(outcome.answers, input.minConfidence),
    };
  } catch {
    return null;
  }
}
