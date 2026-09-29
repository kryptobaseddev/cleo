/**
 * The decision-site registry — every place CLEO makes a judgement, with its
 * rung, ladder, fallback, owner-escalation rule, mode and go-live evidence
 * (spec `system-one-integration` §3, D11158; naming and config keys per
 * D11159: the `decide.*` keys stay).
 *
 * Pure data: importing this module loads nothing else, so the call sites can
 * take their ids and config keys from here without a startup cost. Each id
 * string exists once, here; the site modules re-export it under their old
 * constant names (`DUPLICATE_DECISION_SITE` …) so no caller breaks.
 *
 * Phase 1 (T12662) records the sites and changes no behaviour. Executing the
 * ladder (escalation, handoffs) is T12665; the CI gate over it is T12663.
 *
 * @task T12662
 * @epic T12486
 */

import type { DecisionSiteDefinition } from '@cleocode/contracts';

/** `tasks.duplicate-detection` — is a new task a duplicate of an open one (T12492). */
export const DUPLICATE_DETECTION_SITE = {
  id: 'tasks.duplicate-detection',
  title: 'Duplicate task detection on add',
  files: ['packages/core/src/tasks/duplicate-detector.ts'],
  questionType: 'noul',
  primaryRung: 'system-one',
  ladder: ['generative'],
  fallback: 'rule',
  floors: { '*': 0.6 },
  ownerEscalation: 'never',
  modeKey: 'decide.sites.duplicateDetection',
  generativeKey: 'decide.generativeFallback.duplicateDetection',
  defaultMode: 'shadow',
  llmSystemKey: 'consolidation',
  writePath: true,
  sends: ['task-text'],
  task: 'T12492',
  note: 'Batched noul over at most 3 candidates; rule fallback is Tier-1/Jaccard similarity.',
} as const satisfies DecisionSiteDefinition;

/** `memory.decision-contradiction` — does a new decision contradict a stored one (T12493). */
export const DECISION_CONTRADICTION_DECISION_SITE = {
  id: 'memory.decision-contradiction',
  title: 'Decision contradiction check on store',
  files: [
    'packages/core/src/memory/decision-contradiction.ts',
    'packages/core/src/memory/decisions.ts',
  ],
  questionType: 'choice',
  primaryRung: 'system-one',
  ladder: ['generative'],
  fallback: 'rule',
  floors: { '*': 0.6 },
  ownerEscalation: 'never',
  modeKey: 'decide.sites.decisionContradiction',
  generativeKey: 'decide.generativeFallback.decisionContradiction',
  defaultMode: 'shadow',
  writePath: true,
  sends: ['memory-text'],
  task: 'T12493',
  note: 'Advisory: a contradiction is reported, never blocks the write.',
} as const satisfies DecisionSiteDefinition;

/** `memory.observation-type` — which type an observation is (T12494). */
export const OBSERVATION_TYPE_DECISION_SITE = {
  id: 'memory.observation-type',
  title: 'Observation type classification',
  files: ['packages/core/src/memory/observation-type-decision.ts'],
  questionType: 'choice',
  primaryRung: 'system-one',
  ladder: [],
  fallback: 'rule',
  floors: { '*': 0.6 },
  ownerEscalation: 'never',
  modeKey: 'decide.sites.observationType',
  defaultMode: 'shadow',
  writePath: true,
  sends: ['memory-text'],
  task: 'T12494',
  note: 'Interactive observations only; rule fallback is keyword typing.',
} as const satisfies DecisionSiteDefinition;

/** `orchestration.owner-decision` — does a task wait on an owner decision (T12494). */
export const OWNER_DECISION_DECISION_SITE = {
  id: 'orchestration.owner-decision',
  title: 'Owner-decision readiness check',
  files: [
    'packages/core/src/orchestration/owner-decision-readiness.ts',
    'packages/core/src/orchestration/classify-readiness.ts',
  ],
  questionType: 'noul',
  primaryRung: 'rule',
  ladder: ['system-one'],
  fallback: 'rule',
  floors: { '*': 0.6 },
  ownerEscalation: 'escalate-only',
  modeKey: 'decide.sites.ownerDecision',
  defaultMode: 'shadow',
  writePath: true,
  sends: ['task-text'],
  task: 'T12494',
  note: 'Escalate-only: may add requiresOwnerDecision, never clears it.',
} as const satisfies DecisionSiteDefinition;

/** `cli.decide-ask` — the `cleo decide ask` debug question (T12491). */
export const DECIDE_ASK_DECISION_SITE = {
  id: 'cli.decide-ask',
  title: 'cleo decide ask (debug question)',
  files: ['packages/core/src/decide/operations.ts'],
  questionType: 'noul',
  primaryRung: 'system-one',
  ladder: [],
  fallback: 'none',
  ownerEscalation: 'never',
  defaultMode: 'on',
  writePath: false,
  sends: ['external-text'],
  task: 'T12491',
  note: 'Debug verb: the operator supplies the text; nothing acts on the answer.',
} as const satisfies DecisionSiteDefinition;

/**
 * Generative and agent-rung sites that predate the ladder: registered so every
 * model call site is listed (spec §3.3). All `on`; none uses System One.
 */
const GENERATIVE_SITES = [
  {
    id: 'memory.derivation',
    title: 'Memory derivation',
    files: ['packages/core/src/deriver/deriver.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'derivation',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'memory.extraction',
    title: 'Memory and transcript extraction',
    files: [
      'packages/core/src/memory/llm-extraction.ts',
      'packages/core/src/memory/transcript-extractor.ts',
      'packages/core/src/memory/llm-backend-resolver.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'extraction',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'memory.dialectic-evaluation',
    title: 'Dialectic evaluation of memory claims',
    files: ['packages/core/src/memory/dialectic-evaluator.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
    note: 'Calls generateObject directly (a known chokepoint bypass, gate 13 baseline).',
  },
  {
    id: 'memory.consolidation',
    title: 'Sleep consolidation and dream cycle',
    files: [
      'packages/core/src/memory/sleep-consolidation.ts',
      'packages/core/src/sentient/dream-cycle.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'consolidation',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'memory.observer-reflection',
    title: 'Observer / reflector',
    files: ['packages/core/src/memory/observer-reflector.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'memory.specialists',
    title: 'Memory specialists',
    files: ['packages/core/src/memory/specialists.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'memory.summarization',
    title: 'Context summarization',
    files: [
      'packages/core/src/llm/plugin-facade.ts',
      'packages/core/src/memory/context-engines/llm-summarizer.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['memory-text'],
    task: 'T12662',
  },
  {
    id: 'sentient.hygiene',
    title: 'Hygiene scan',
    files: [
      'packages/core/src/sentient/hygiene-scan.ts',
      'packages/core/src/llm/auxiliary-fallback.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'hygiene',
    writePath: false,
    sends: ['task-text', 'memory-text'],
    task: 'T12662',
  },
  {
    id: 'selfimprove.fix-gen',
    title: 'Self-improvement fix generation',
    files: ['packages/core/src/selfimprove/fix-gen.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'fix-gen',
    writePath: false,
    sends: ['diff'],
    task: 'T12662',
  },
  {
    id: 'nexus.wiki',
    title: 'Nexus wiki generation',
    files: ['packages/core/src/nexus/wiki-orchestrator.ts'],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['diff'],
    task: 'T12662',
  },
  {
    id: 'tools.agent-tools',
    title: 'Web and media agent tools',
    files: [
      'packages/core/src/tools/web-agent-tools.ts',
      'packages/core/src/tools/media-agent-tools.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    llmSystemKey: 'task-executor',
    writePath: false,
    sends: ['external-text'],
    task: 'T12662',
  },
  {
    id: 'llm.probe',
    title: 'Provider probes (cleo llm, login)',
    files: [
      'packages/core/src/llm/onboarding/login-engine.ts',
      'packages/core/src/llm/cli-ops.ts',
      'packages/cleo/src/cli/commands/llm-stream.ts',
    ],
    questionType: 'text',
    primaryRung: 'generative',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: [],
    task: 'T12662',
  },
  {
    id: 'llm.agent-transport',
    title: 'Agent-rung transports',
    files: [
      'packages/core/src/llm/role-executor.ts',
      'packages/core/src/llm/session-factory.ts',
      'packages/core/src/llm/pi/pi-stream-fn.ts',
      'packages/core/src/playbooks/cantbook-profile.ts',
    ],
    questionType: 'multi-step',
    primaryRung: 'agent',
    ladder: [],
    fallback: 'none',
    ownerEscalation: 'never',
    defaultMode: 'on',
    writePath: false,
    sends: ['task-text'],
    task: 'T12662',
  },
] as const satisfies readonly DecisionSiteDefinition[];

/**
 * Every registered decision site. The System One sites come first, then the
 * generative and agent-rung sites.
 */
export const DECISION_SITES: readonly DecisionSiteDefinition[] = [
  DUPLICATE_DETECTION_SITE,
  DECISION_CONTRADICTION_DECISION_SITE,
  OBSERVATION_TYPE_DECISION_SITE,
  OWNER_DECISION_DECISION_SITE,
  DECIDE_ASK_DECISION_SITE,
  ...GENERATIVE_SITES,
];

/**
 * The registry row for `id`.
 *
 * @param id - Site id.
 * @returns The row, or `undefined` when no site has that id.
 */
export function getDecisionSite(id: string): DecisionSiteDefinition | undefined {
  return DECISION_SITES.find((site) => site.id === id);
}
