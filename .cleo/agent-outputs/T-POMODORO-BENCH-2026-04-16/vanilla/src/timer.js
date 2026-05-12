// @ts-check
/**
 * Pomodoro state machine — pure logic, no DOM.
 *
 * Phases: 'work' → 'short_break' → 'work' → 'short_break' → 'work' →
 *         'short_break' → 'work' → 'long_break' → 'work' ...
 *
 * Long break triggers after every 4th completed WORK phase.
 *
 * Durations are configurable via settings (minutes, stored as seconds here).
 *
 * The timer exposes an event callback when a phase completes so the app can:
 *   - increment session counters (on work completion)
 *   - play a chime
 *   - announce the change to assistive tech
 */

export const DEFAULT_SETTINGS = Object.freeze({
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4, // long break every N work phases
  chime: true,
});

export const PHASES = Object.freeze({
  WORK: 'work',
  SHORT: 'short_break',
  LONG: 'long_break',
});

/** @typedef {typeof PHASES[keyof typeof PHASES]} Phase */
/** @typedef {{ workMin: number, shortMin: number, longMin: number, longEvery: number, chime: boolean }} Settings */

/**
 * Compute the phase duration in seconds for a given phase and settings.
 * @param {Phase} phase
 * @param {Settings} settings
 * @returns {number}
 */
export function phaseDuration(phase, settings) {
  switch (phase) {
    case PHASES.WORK:  return Math.max(1, settings.workMin) * 60;
    case PHASES.SHORT: return Math.max(1, settings.shortMin) * 60;
    case PHASES.LONG:  return Math.max(1, settings.longMin) * 60;
    default: return 0;
  }
}

/**
 * Determine the NEXT phase after the currently completed one.
 * The `completedWorkCount` is the number of work phases completed so far,
 * BEFORE this completion is recorded (so if we just finished work #4 and we
 * pass 3, this function will return LONG).
 *
 * @param {Phase} currentPhase
 * @param {number} completedWorkCount — how many work phases have been completed before
 * @param {Settings} settings
 * @returns {Phase}
 */
export function nextPhase(currentPhase, completedWorkCount, settings) {
  if (currentPhase === PHASES.WORK) {
    // This work just finished. Next work count becomes completedWorkCount + 1.
    const nextWorkNumber = completedWorkCount + 1;
    return nextWorkNumber % Math.max(1, settings.longEvery) === 0
      ? PHASES.LONG
      : PHASES.SHORT;
  }
  // After any break, always return to work
  return PHASES.WORK;
}

/**
 * Make a new pomodoro timer instance.
 *
 * Uses a deadline-based approach (Date.now + remainingMs) so a single setTimeout
 * or setInterval gives visually smooth progress without drifting.
 *
 * Dependency injection:
 *   - now:    clock function (default Date.now) — overridable in tests
 *   - setT:   setTimeout    (default globalThis.setTimeout)
 *   - clearT: clearTimeout  (default globalThis.clearTimeout)
 *
 * Callbacks:
 *   - onTick(remainingSec, durationSec, phase) — called each tick
 *   - onPhaseEnd(completedPhase, nextPhase)    — called when a phase completes
 *
 * @param {{
 *   settings?: Settings,
 *   now?: () => number,
 *   setT?: typeof setTimeout,
 *   clearT?: typeof clearTimeout,
 *   onTick?: (remaining: number, duration: number, phase: Phase) => void,
 *   onPhaseEnd?: (completed: Phase, next: Phase) => void,
 * }} [deps]
 */
export function createTimer(deps = {}) {
  const now = deps.now ?? Date.now;
  const setT = deps.setT ?? /** @type {any} */(globalThis.setTimeout).bind(globalThis);
  const clearT = deps.clearT ?? /** @type {any} */(globalThis.clearTimeout).bind(globalThis);

  let settings = { ...DEFAULT_SETTINGS, ...(deps.settings ?? {}) };
  /** @type {Phase} */
  let phase = PHASES.WORK;
  let durationSec = phaseDuration(phase, settings);
  let remainingMs = durationSec * 1000;
  let deadline = 0; // absolute timestamp when running
  let running = false;
  let completedWork = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let handle = null;

  function schedule() {
    if (handle != null) {
      clearT(handle);
      handle = null;
    }
    if (!running) return;
    // Tick every 200ms for smooth ring updates but exact deadline for end
    const ms = Math.max(0, deadline - now());
    const tick = Math.min(200, ms);
    handle = setT(onTimeout, tick);
  }

  function onTimeout() {
    handle = null;
    if (!running) return;
    const rem = deadline - now();
    if (rem <= 0) {
      remainingMs = 0;
      deps.onTick?.(0, durationSec, phase);
      completePhase();
    } else {
      remainingMs = rem;
      deps.onTick?.(Math.ceil(rem / 1000), durationSec, phase);
      schedule();
    }
  }

  function completePhase() {
    const completedPhase = phase;
    if (completedPhase === PHASES.WORK) completedWork += 1;
    const next = nextPhase(
      completedPhase,
      completedPhase === PHASES.WORK ? completedWork - 1 : completedWork,
      settings,
    );
    phase = next;
    durationSec = phaseDuration(phase, settings);
    remainingMs = durationSec * 1000;
    running = false; // auto-pause between phases; user hits Space to continue
    deps.onPhaseEnd?.(completedPhase, next);
  }

  return {
    /** Start the timer (or resume). */
    start() {
      if (running) return;
      running = true;
      deadline = now() + remainingMs;
      schedule();
    },
    /** Pause the timer, preserving remaining time. */
    pause() {
      if (!running) return;
      remainingMs = Math.max(0, deadline - now());
      running = false;
      if (handle != null) { clearT(handle); handle = null; }
    },
    /** Toggle between running and paused. */
    toggle() {
      if (running) this.pause(); else this.start();
    },
    /** Reset current phase back to its full duration (stops the timer). */
    reset() {
      running = false;
      if (handle != null) { clearT(handle); handle = null; }
      durationSec = phaseDuration(phase, settings);
      remainingMs = durationSec * 1000;
      deps.onTick?.(durationSec, durationSec, phase);
    },
    /** Force-advance to the next phase (used by the Skip button). */
    skip() {
      running = false;
      if (handle != null) { clearT(handle); handle = null; }
      // Behave like the current phase "completed" but don't count sessions —
      // the phase-end callback receives the transition so the UI can chime.
      const completedPhase = phase;
      if (completedPhase === PHASES.WORK) completedWork += 1;
      const next = nextPhase(
        completedPhase,
        completedPhase === PHASES.WORK ? completedWork - 1 : completedWork,
        settings,
      );
      phase = next;
      durationSec = phaseDuration(phase, settings);
      remainingMs = durationSec * 1000;
      deps.onPhaseEnd?.(completedPhase, next);
    },
    /** Update settings (re-applies duration only if timer is paused). */
    updateSettings(/** @type {Partial<Settings>} */ patch) {
      settings = { ...settings, ...patch };
      if (!running) {
        durationSec = phaseDuration(phase, settings);
        remainingMs = durationSec * 1000;
        deps.onTick?.(durationSec, durationSec, phase);
      }
    },
    /** Snapshot current state (for UI rendering and tests). */
    getState() {
      const rem = running
        ? Math.max(0, Math.ceil((deadline - now()) / 1000))
        : Math.ceil(remainingMs / 1000);
      return {
        phase,
        running,
        remainingSec: rem,
        durationSec,
        completedWork,
        settings: { ...settings },
      };
    },
  };
}
