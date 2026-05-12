// lib/timer.js — Pure Pomodoro state machine. No DOM, no setInterval, no I/O.
// Time is injected as `nowMs`, making the machine fully testable.

export const PHASES = Object.freeze({ IDLE: "idle", WORK: "work", SHORT: "short", LONG: "long" });

/**
 * Create a new timer state.
 * @param {{work:number,short:number,long:number}} durations in MINUTES
 */
export function createTimer(durations = { work: 25, short: 5, long: 15 }) {
  return {
    phase: PHASES.IDLE,
    running: false,
    cyclesCompleted: 0,      // number of completed WORK phases
    durations: { ...durations },
    remainingMs: null,       // ms left in current phase (null when idle)
    startedAt: null,         // performance.now() when phase started (or resumed)
    accumulatedMs: 0,        // ms already spent in current phase when paused
  };
}

/** ms for a given phase based on current state durations. */
export function phaseDuration(state, phase = state.phase) {
  if (phase === PHASES.IDLE) return 0;
  const key = phase === PHASES.WORK ? "work" : phase === PHASES.SHORT ? "short" : "long";
  return Math.max(0, Math.round((state.durations[key] || 0) * 60_000));
}

/**
 * Determine the next phase and whether cyclesCompleted advances.
 * Transitions:
 *   idle  → work
 *   work  → long  (when new cyclesCompleted % 4 === 0)
 *   work  → short (otherwise)
 *   short → work
 *   long  → work
 */
export function nextPhase(state) {
  let next = { ...state };
  if (state.phase === PHASES.IDLE || state.phase === PHASES.SHORT || state.phase === PHASES.LONG) {
    next.phase = PHASES.WORK;
  } else if (state.phase === PHASES.WORK) {
    next.cyclesCompleted = state.cyclesCompleted + 1;
    next.phase = next.cyclesCompleted % 4 === 0 ? PHASES.LONG : PHASES.SHORT;
  }
  next.remainingMs = phaseDuration(next, next.phase);
  next.accumulatedMs = 0;
  next.startedAt = null;
  next.running = false;
  return next;
}

/** Start (or resume) the timer. If idle, auto-advance to work. */
export function start(state, nowMs) {
  let s = state;
  if (s.phase === PHASES.IDLE) s = nextPhase(s);
  return {
    ...s,
    running: true,
    startedAt: nowMs - s.accumulatedMs,
    remainingMs: phaseDuration(s) - s.accumulatedMs,
  };
}

/** Pause the timer, freezing accumulated time. */
export function pause(state, nowMs) {
  if (!state.running || state.startedAt === null) return { ...state, running: false };
  const elapsed = nowMs - state.startedAt;
  return {
    ...state,
    running: false,
    accumulatedMs: Math.min(elapsed, phaseDuration(state)),
    remainingMs: Math.max(0, phaseDuration(state) - elapsed),
    startedAt: null,
  };
}

/** Reset the current phase to full duration without changing phase or cyclesCompleted. */
export function reset(state) {
  return {
    ...state,
    running: false,
    accumulatedMs: 0,
    startedAt: null,
    remainingMs: state.phase === PHASES.IDLE ? null : phaseDuration(state),
  };
}

/**
 * Advance the timer. Returns `{ state, fired }`.
 * `fired === "phaseEnd"` when the current phase finished this tick; the
 * returned state has auto-advanced to the next phase, running = false
 * (caller decides whether to auto-start the next phase).
 */
export function tick(state, nowMs) {
  if (!state.running || state.startedAt === null) {
    return { state, fired: null };
  }
  const total = phaseDuration(state);
  const elapsed = nowMs - state.startedAt;
  const remainingMs = Math.max(0, total - elapsed);
  if (remainingMs <= 0) {
    const ended = { ...state, remainingMs: 0, running: false, accumulatedMs: 0, startedAt: null };
    const advanced = nextPhase(ended);
    return { state: advanced, fired: "phaseEnd" };
  }
  return { state: { ...state, remainingMs }, fired: null };
}

/** Set new durations at runtime; applies immediately to any non-started phase. */
export function setDurations(state, durations) {
  const merged = { ...state.durations, ...durations };
  const next = { ...state, durations: merged };
  if (!state.running && state.phase !== PHASES.IDLE) {
    next.remainingMs = phaseDuration(next);
    next.accumulatedMs = 0;
  }
  return next;
}

/** Clamp an mm:ss render value from remainingMs. */
export function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
