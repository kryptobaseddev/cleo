/**
 * Pomodoro timer engine — pure state machine with no DOM coupling.
 *
 * Phases: 'work' -> 'short' (or 'long' every Nth work) -> 'work' -> ...
 * Consumers drive time by calling tick(ms) with monotonic wall time, which
 * makes the engine deterministic and unit-testable without a running clock.
 */

/** @typedef {'work'|'short'|'long'} Phase */

/**
 * @typedef {Object} TimerSettings
 * @property {number} work     minutes
 * @property {number} short    minutes
 * @property {number} long     minutes
 * @property {number} cadence  every Nth completed work phase triggers long break
 */

/**
 * @typedef {Object} TimerState
 * @property {Phase} phase
 * @property {number} phaseMs         - total ms in current phase
 * @property {number} remainingMs     - ms left in current phase
 * @property {boolean} running
 * @property {number|null} startedAt  - wall-time ms when resumed, null when paused
 * @property {number} completedWorkCycles - count of finished work phases
 */

/**
 * Factory for the initial engine state.
 * @param {TimerSettings} settings
 * @returns {TimerState}
 */
export function createTimerState(settings) {
  const phaseMs = minutesToMs(settings.work);
  return {
    phase: 'work',
    phaseMs,
    remainingMs: phaseMs,
    running: false,
    startedAt: null,
    completedWorkCycles: 0,
  };
}

/** Convert minutes to milliseconds. */
export function minutesToMs(mins) {
  return Math.max(0, Math.round(Number(mins) * 60_000));
}

/**
 * Start or resume a paused timer. No-op if already running.
 * @param {TimerState} state
 * @param {number} now wall clock ms (e.g. Date.now())
 * @returns {TimerState}
 */
export function start(state, now) {
  if (state.running) return state;
  return { ...state, running: true, startedAt: now };
}

/**
 * Pause the timer. Folds elapsed time into remainingMs so resume is exact.
 * @param {TimerState} state
 * @param {number} now
 * @returns {TimerState}
 */
export function pause(state, now) {
  if (!state.running) return state;
  const elapsed = state.startedAt == null ? 0 : Math.max(0, now - state.startedAt);
  return {
    ...state,
    running: false,
    startedAt: null,
    remainingMs: Math.max(0, state.remainingMs - elapsed),
  };
}

/**
 * Toggle start/pause.
 * @param {TimerState} state
 * @param {number} now
 * @returns {TimerState}
 */
export function toggle(state, now) {
  return state.running ? pause(state, now) : start(state, now);
}

/**
 * Reset the current phase to full duration (does not advance phase).
 * @param {TimerState} state
 * @param {TimerSettings} settings
 * @returns {TimerState}
 */
export function reset(state, settings) {
  const phaseMs = phaseDurationMs(state.phase, settings);
  return { ...state, phaseMs, remainingMs: phaseMs, running: false, startedAt: null };
}

/**
 * Advance to the next phase immediately (e.g. "skip" button).
 * @param {TimerState} state
 * @param {TimerSettings} settings
 * @returns {TimerState}
 */
export function skip(state, settings) {
  return advancePhase(state, settings);
}

/**
 * Return ms remaining given the wall clock now. Does not mutate state.
 * @param {TimerState} state
 * @param {number} now
 */
export function computeRemaining(state, now) {
  if (!state.running || state.startedAt == null) return state.remainingMs;
  const elapsed = Math.max(0, now - state.startedAt);
  return Math.max(0, state.remainingMs - elapsed);
}

/**
 * Tick the engine to the given wall clock. If remaining reaches 0, auto-advance
 * to the next phase and emit a "phaseEnded" event (returned, not dispatched).
 * @param {TimerState} state
 * @param {TimerSettings} settings
 * @param {number} now
 * @returns {{ state: TimerState, events: Array<{type:'phaseEnded', endedPhase: Phase, nextPhase: Phase}> }}
 */
export function tick(state, settings, now) {
  if (!state.running) return { state, events: [] };
  const remaining = computeRemaining(state, now);
  if (remaining > 0) {
    return { state, events: [] };
  }
  const endedPhase = state.phase;
  const next = advancePhase(state, settings);
  return {
    state: next,
    events: [{ type: 'phaseEnded', endedPhase, nextPhase: next.phase }],
  };
}

/**
 * Determine the next phase and produce a fresh state for it.
 * @param {TimerState} state
 * @param {TimerSettings} settings
 */
export function advancePhase(state, settings) {
  let nextPhase;
  let completed = state.completedWorkCycles;

  if (state.phase === 'work') {
    completed = state.completedWorkCycles + 1;
    const cadence = Math.max(1, settings.cadence | 0);
    nextPhase = completed % cadence === 0 ? 'long' : 'short';
  } else {
    // After any break, back to work.
    nextPhase = 'work';
  }

  const phaseMs = phaseDurationMs(nextPhase, settings);
  return {
    ...state,
    phase: nextPhase,
    phaseMs,
    remainingMs: phaseMs,
    running: false,
    startedAt: null,
    completedWorkCycles: completed,
  };
}

/**
 * Lookup phase duration from settings.
 * @param {Phase} phase
 * @param {TimerSettings} settings
 */
export function phaseDurationMs(phase, settings) {
  switch (phase) {
    case 'work':  return minutesToMs(settings.work);
    case 'short': return minutesToMs(settings.short);
    case 'long':  return minutesToMs(settings.long);
    default:      return minutesToMs(settings.work);
  }
}

/**
 * Apply a settings change to a running timer. Rebuilds phaseMs/remainingMs
 * for the current phase if it hasn't been consumed yet; otherwise preserves
 * remaining proportion.
 * @param {TimerState} state
 * @param {TimerSettings} next
 * @returns {TimerState}
 */
export function applySettings(state, next) {
  const newPhaseMs = phaseDurationMs(state.phase, next);
  if (state.phaseMs === 0) {
    return { ...state, phaseMs: newPhaseMs, remainingMs: newPhaseMs };
  }
  const ratio = state.remainingMs / state.phaseMs;
  return {
    ...state,
    phaseMs: newPhaseMs,
    remainingMs: Math.round(newPhaseMs * ratio),
  };
}

/**
 * Humanize remaining ms as MM:SS.
 * @param {number} ms
 */
export function formatMs(ms) {
  const clamped = Math.max(0, ms | 0);
  const totalSeconds = Math.ceil(clamped / 1000);
  const mm = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const ss = (totalSeconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}
