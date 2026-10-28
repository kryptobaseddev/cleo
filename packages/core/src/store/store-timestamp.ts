/**
 * Store timestamp parsing (T12329), in a leaf module (T14094) so evidence
 * checks outside the store read stored times exactly as the store does.
 *
 * @task T12329
 * @task T14094
 */

/** Strict ISO-8601 / SQLite timestamp: date, optional time, optional zone. */
const STORE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Epoch milliseconds of a stored timestamp, or `null` when absent or not a
 * strict ISO-8601 / SQLite timestamp. A value WITHOUT a zone is UTC:
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` meaning UTC, and a zoneless
 * `YYYY-MM-DDTHH:MM:SS` is read the same way, never as the device's local
 * time (`Date.parse` would, and a uid would then depend on the device's
 * timezone). Anything else (`Date.parse` extensions such as `Sep 24 2026`,
 * out-of-range fields) is `null`, i.e. an unparseable birth. Comparing that
 * text against ISO text is wrong within a day (`' '` sorts before `'T'`), so
 * every comparison and every uid birth goes through this function (T12329).
 *
 * @param value - Stored timestamp.
 * @returns Epoch milliseconds, or `null`.
 */
export function parseStoreTimestamp(
  value: string | number | bigint | Uint8Array | null | undefined,
): number | null {
  if (typeof value !== 'string') return null;
  const m = STORE_TIMESTAMP.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(sec);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number(frac.padEnd(3, '0').slice(0, 3) || '0');
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(utc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (!zone || zone === 'Z') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2, 4)) > 59) return null;
  return utc - sign * offset;
}
