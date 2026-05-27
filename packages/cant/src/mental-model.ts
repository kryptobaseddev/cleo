/**
 * Mental Model Manager -- per-agent persistent observations.
 *
 * Implements ULTRAPLAN section 12: mental models are per-project, async-updated
 * after each spawn, and validated on every load.
 *
 * Mental models compound intelligence over time by recording patterns,
 * decisions, and outcomes from agent sessions. They decay naturally and
 * are token-bounded to fit within tier caps.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Observation types
// ---------------------------------------------------------------------------

/** Trigger events that cause an observation to be recorded. */
export type ObservationTrigger =
  | 'task_completed'
  | 'bug_fixed'
  | 'pattern_observed'
  | 'decision_made';

/** A single observation in the mental model. */
export interface MentalModelObservation {
  /** Unique observation ID. */
  id: string;
  /** The agent that made this observation. */
  agentName: string;
  /** Project hash scoping this observation. */
  projectHash: string;
  /** When this observation was recorded (ISO 8601). */
  timestamp: string;
  /** The observation content. */
  content: string;
  /** Estimated tokens for this content. */
  tokens: number;
  /** What triggered this observation. */
  trigger: ObservationTrigger;
  /** Number of times this observation has been reinforced. */
  reinforceCount: number;
}

// ---------------------------------------------------------------------------
// Mental model types
// ---------------------------------------------------------------------------

/** Scope for a mental model: project-specific or global. */
export type MentalModelScope = 'project' | 'global';

/** The consolidated mental model for an agent+project. */
export interface MentalModel {
  /** Agent this model belongs to. */
  agentName: string;
  /** Project hash scoping this model. */
  projectHash: string;
  /** Scope: project or global (per ULTRAPLAN L5). */
  scope: MentalModelScope;
  /** Consolidated observations (token-bounded). */
  observations: MentalModelObservation[];
  /** Total tokens across all observations. */
  totalTokens: number;
  /** Max allowed tokens (from tier cap). */
  maxTokens: number;
  /** When this model was last consolidated (ISO 8601), or null if never. */
  lastConsolidated: string | null;
  /** When this model was last validated by an agent (ISO 8601), or null if never. */
  lastValidated: string | null;
}

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

/** Storage interface for mental model persistence (mockable). */
export interface MentalModelStore {
  /** Load the mental model for an agent+project. */
  load(agentName: string, projectHash: string): Promise<MentalModel | null>;
  /** Save the mental model. */
  save(model: MentalModel): Promise<void>;
  /** Append a raw observation (async, non-blocking per ULTRAPLAN L5). */
  appendObservation(obs: MentalModelObservation): Promise<void>;
  /** List pending (unconsolidated) observations. */
  listPending(agentName: string, projectHash: string): Promise<MentalModelObservation[]>;
  /** Clear pending observations after consolidation. */
  clearPending(agentName: string, projectHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Consolidation options
// ---------------------------------------------------------------------------

/** Options for the {@link consolidate} function. */
export interface ConsolidateOptions {
  /** Maximum total tokens for all observations. */
  maxTokens: number;
  /** Number of days after which unreinforced observations decay. */
  decayAfterDays: number;
  /** Scope for the resulting model. */
  scope: MentalModelScope;
}

// ---------------------------------------------------------------------------
// Validation prefix (ULTRAPLAN section 12.3)
// ---------------------------------------------------------------------------

/**
 * Validation prefix injected before mental model content.
 *
 * Per ULTRAPLAN section 12.3, every load must instruct the agent to
 * re-evaluate the mental model against current project state.
 */
const VALIDATION_PREFIX =
  'VALIDATE THIS MENTAL MODEL. Re-evaluate each claim against current ' +
  'code state. Mental models are dynamic per project; assume drift.';

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Create an empty mental model for an agent+project.
 *
 * @param agentName - The agent this model belongs to.
 * @param projectHash - The project hash scoping this model.
 * @param scope - Whether this is a project or global model.
 * @param maxTokens - Maximum token budget for observations.
 * @returns A fresh, empty mental model.
 */
export function createEmptyModel(
  agentName: string,
  projectHash: string,
  scope: MentalModelScope,
  maxTokens: number,
): MentalModel {
  return {
    agentName,
    projectHash,
    scope,
    observations: [],
    totalTokens: 0,
    maxTokens,
    lastConsolidated: null,
    lastValidated: null,
  };
}

/**
 * Consolidate pending observations into the mental model.
 *
 * Implements the consolidation from ULTRAPLAN section 12.2:
 * 1. Load pending observations from the store
 * 2. Merge into existing model (deduplicate by content, reinforce matches)
 * 3. Decay entries older than decayAfterDays
 * 4. Enforce maxTokens cap (drop oldest first)
 * 5. Save consolidated model and clear pending queue
 *
 * @param store - The persistence layer for mental models.
 * @param agentName - The agent whose model to consolidate.
 * @param projectHash - The project hash scoping the model.
 * @param options - Consolidation configuration.
 * @returns The consolidated mental model.
 */
export async function consolidate(
  store: MentalModelStore,
  agentName: string,
  projectHash: string,
  options: ConsolidateOptions,
): Promise<MentalModel> {
  // Load existing model or create fresh
  let model = await store.load(agentName, projectHash);
  if (!model) {
    model = createEmptyModel(agentName, projectHash, options.scope, options.maxTokens);
  }

  // Load pending observations
  const pending = await store.listPending(agentName, projectHash);

  // Merge: add pending, increment reinforceCount for duplicates
  for (const obs of pending) {
    const existing = model.observations.find((o) => o.content === obs.content);
    if (existing) {
      existing.reinforceCount += 1;
      existing.timestamp = obs.timestamp; // refresh timestamp on reinforce
    } else {
      model.observations.push(obs);
    }
  }

  // Decay: remove observations older than decayAfterDays
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - options.decayAfterDays);
  const cutoffIso = cutoff.toISOString();
  model.observations = model.observations.filter((o) => o.timestamp >= cutoffIso);

  // Enforce token cap: sort newest first, keep within budget
  model.observations.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  let tokenSum = 0;
  const kept: MentalModelObservation[] = [];
  for (const obs of model.observations) {
    if (tokenSum + obs.tokens > options.maxTokens) break;
    kept.push(obs);
    tokenSum += obs.tokens;
  }
  model.observations = kept;
  model.totalTokens = tokenSum;
  model.maxTokens = options.maxTokens;
  model.lastConsolidated = new Date().toISOString();

  // Persist consolidated model and clear pending queue
  await store.save(model);
  await store.clearPending(agentName, projectHash);

  return model;
}

/**
 * Render a mental model for system prompt injection.
 *
 * Includes the ULTRAPLAN section 12.3 validation prefix:
 * "VALIDATE THIS MENTAL MODEL. Re-evaluate each claim against
 * current code state. Mental models are dynamic per project;
 * assume drift."
 *
 * @param model - The mental model to render.
 * @returns Rendered text for injection into system prompts, or empty string if no observations.
 */
export function renderMentalModel(model: MentalModel): string {
  if (model.observations.length === 0) return '';

  const entries = model.observations
    .map((o) => `- [${o.trigger}] ${o.content} (reinforced ${o.reinforceCount}x)`)
    .join('\n');

  return `${VALIDATION_PREFIX}\n\n${entries}`;
}

/**
 * Session output data used by {@link harvestObservations} to extract
 * mental model observations from a completed agent session.
 */
export interface SessionOutput {
  /** Patterns the agent applied during the session. */
  patternsUsed: string[];
  /** Decisions the agent made during the session. */
  decisionsMade: string[];
  /** File paths the agent touched during the session. */
  filesTouched: string[];
  /** Overall outcome of the session. */
  outcome: 'success' | 'failure' | 'partial';
}

/**
 * Generate a unique observation ID.
 *
 * @returns A prefixed unique ID string.
 */
function generateObservationId(): string {
  return `mm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract observations from a completed agent session.
 *
 * Implements ULTRAPLAN section 12.2 post-spawn harvesting:
 * parses session output for patterns, decisions, and files touched.
 * Only records task completion observations on successful outcomes.
 *
 * @param agentName - The agent that ran the session.
 * @param projectHash - The project hash for scoping observations.
 * @param sessionOutput - Structured output from the completed session.
 * @returns Array of observations ready for {@link MentalModelStore.appendObservation}.
 */
export function harvestObservations(
  agentName: string,
  projectHash: string,
  sessionOutput: SessionOutput,
): MentalModelObservation[] {
  const now = new Date().toISOString();
  const observations: MentalModelObservation[] = [];

  for (const pattern of sessionOutput.patternsUsed) {
    observations.push({
      id: generateObservationId(),
      agentName,
      projectHash,
      timestamp: now,
      content: `Pattern applied: ${pattern}`,
      tokens: Math.ceil(`Pattern applied: ${pattern}`.length / 4),
      trigger: 'pattern_observed',
      reinforceCount: 0,
    });
  }

  for (const decision of sessionOutput.decisionsMade) {
    observations.push({
      id: generateObservationId(),
      agentName,
      projectHash,
      timestamp: now,
      content: `Decision: ${decision}`,
      tokens: Math.ceil(`Decision: ${decision}`.length / 4),
      trigger: 'decision_made',
      reinforceCount: 0,
    });
  }

  if (sessionOutput.outcome === 'success') {
    const fileList = sessionOutput.filesTouched.join(', ');
    const content = `Task completed successfully. Files: ${fileList}`;
    observations.push({
      id: generateObservationId(),
      agentName,
      projectHash,
      timestamp: now,
      content,
      tokens: Math.ceil(content.length / 4),
      trigger: 'task_completed',
      reinforceCount: 0,
    });
  }

  return observations;
}
