/**
 * Terminal-safe text for human output (T13295).
 *
 * Device names, project labels, activity targets and other strings the Cleo
 * Nexus server returns are chosen by whoever registered them, which on a
 * shared project is another account. Printed raw, an ESC or C1 sequence in
 * one of them can move the cursor, rewrite the line, retitle the terminal or
 * plant an OSC 8 link; a bidi override can reorder what the line appears to
 * say. These helpers remove all of that before text reaches a terminal. JSON
 * output carries the raw values; only the human renderers use them.
 *
 * @task T13295
 */

/** ESC-introduced sequences: CSI, OSC (to BEL or ST), DCS/SOS/PM/APC (to ST), and two-byte escapes. */
const ESC_SEQUENCE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -~]?)/g;

/** Their single-byte C1 forms: CSI (0x9B), and OSC/DCS/SOS/PM/APC to BEL or ST (0x9C). */
const C1_SEQUENCE = /\x9b[0-?]*[ -/]*[@-~]|[\x90\x98\x9d-\x9f][^\x07\x9c\x1b]*(?:\x07|\x9c)?/g;

/** Every remaining C0 control but tab and newline, DEL, and C1 control. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069). */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` with escape sequences, controls and bidi overrides removed, keeping
 * tab and newline: for a whole human line or block built by CLEO.
 *
 * @param text - Text about to be written to a terminal.
 * @returns The same text without terminal control.
 */
export function terminalSafeLines(text: string): string {
  return text
    .replace(ESC_SEQUENCE, '')
    .replace(C1_SEQUENCE, '')
    .replace(CONTROL, '')
    .replace(BIDI, '');
}

/**
 * One server-supplied value (a name, label, id or message) made safe to
 * interpolate into a human line: {@link terminalSafeLines}, with tabs and line
 * breaks turned into spaces so the value cannot forge a line of its own.
 *
 * @param text - The raw value.
 * @returns The value as one line without terminal control.
 */
export function terminalSafe(text: string): string {
  return terminalSafeLines(text.replace(/ *[\t\n\r][\t\n\r ]*/g, ' '));
}
