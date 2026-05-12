// @ts-check
/**
 * Lightweight chime using the Web Audio API — no external files.
 * A gentle two-note signal so phase changes are noticeable but not jarring.
 */

/** @type {AudioContext | null} */
let ctx = null;

/**
 * Lazily construct the audio context. Browsers require a user gesture before
 * creating one; we defer until first play.
 * @returns {AudioContext | null}
 */
function getCtx() {
  if (ctx) return ctx;
  const AC = /** @type {any} */(globalThis).AudioContext || /** @type {any} */(globalThis).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Play a two-tone chime. `phase` determines pitch — higher for breaks.
 * @param {'work' | 'break'} [kind]
 */
export function playChime(kind = 'work') {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});

  const now = c.currentTime;
  const base = kind === 'break' ? 660 : 523.25; // E5 or C5
  const second = kind === 'break' ? 880 : 783.99; // A5 or G5

  [0, 0.18].forEach((offset, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 0 ? base : second;
    gain.gain.setValueAtTime(0, now + offset);
    gain.gain.linearRampToValueAtTime(0.18, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.4);
    osc.connect(gain).connect(c.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.42);
  });
}
