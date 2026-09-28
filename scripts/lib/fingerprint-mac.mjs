/**
 * The MAC over a Gate B/C fingerprint JSON (T12636).
 *
 * `scripts/fingerprint-store.mjs` signs every fingerprint with the
 * comparison's HMAC key, and `scripts/compare-fingerprints.mjs` verifies the
 * signature before it trusts any field (`rowsFile`, `rowsSha256`, digests,
 * counts). Both import this module, so the signer and the verifier cannot
 * drift apart on the encoding.
 *
 * The encoding is canonical JSON: object keys sorted at every level, no
 * whitespace, the `mac` field itself left out. Numbers and strings use
 * `JSON.stringify`'s own forms, which are deterministic.
 *
 * @module scripts/lib/fingerprint-mac
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Canonical JSON text of a value: keys sorted at every level, no whitespace.
 *
 * @param {unknown} value - A JSON-compatible value.
 * @returns {string} The canonical encoding.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * HMAC-SHA256 of a fingerprint, over its canonical encoding without `mac`.
 *
 * @param {Record<string, unknown>} fingerprint - The parsed fingerprint.
 * @param {string} key - The comparison key.
 * @returns {string} The MAC as lowercase hex.
 */
export function fingerprintMac(fingerprint, key) {
  const { mac: _mac, ...body } = fingerprint;
  return createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
}

/**
 * Whether a fingerprint's `mac` field is the MAC of its content under `key`.
 *
 * @param {Record<string, unknown>} fingerprint - The parsed fingerprint.
 * @param {string} key - The comparison key.
 * @returns {boolean} `true` only for an untouched fingerprint signed with `key`.
 */
export function verifyFingerprintMac(fingerprint, key) {
  if (typeof fingerprint.mac !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint.mac)) return false;
  const expected = Buffer.from(fingerprintMac(fingerprint, key), 'hex');
  return timingSafeEqual(expected, Buffer.from(fingerprint.mac, 'hex'));
}

/**
 * Read a comparison key file: the trimmed text, at least 32 characters.
 *
 * @param {string} text - The key file's content.
 * @returns {string} The key.
 */
export function parseKey(text) {
  const key = text.trim();
  if (key.length < 32) throw new Error('the key file must hold at least 32 characters');
  return key;
}
