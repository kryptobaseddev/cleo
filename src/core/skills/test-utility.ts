/**
 * Test utility functions for implementation protocol validation.
 * Ported from lib/skills/test-utility.sh
 *
 * Provides date formatting and timestamp generation helpers
 * used in skill test validation workflows.
 *
 * @task T4552
 * @epic T4545
 */

/**
 * Format a date string in ISO 8601 format.
 * Converts a YYYY-MM-DD date string to a full ISO 8601 timestamp.
 *
 * @param inputDate - Date string in YYYY-MM-DD format
 * @returns ISO 8601 formatted string (e.g., "2026-02-03T00:00:00Z")
 * @throws Error if date format is invalid or missing
 * @task T4552
 */
export function formatIsoDate(inputDate: string): string {
  if (!inputDate) {
    throw new Error('Date required');
  }

  // Validate format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD');
  }

  return `${inputDate}T00:00:00Z`;
}

/**
 * Get current timestamp in ISO 8601 format.
 * Returns the current UTC time as an ISO 8601 string.
 *
 * @returns Current timestamp (e.g., "2026-02-16T14:30:00Z")
 * @task T4552
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Validate that a string is a valid ISO 8601 date.
 * @task T4552
 */
export function isValidIsoDate(dateStr: string): boolean {
  const date = new Date(dateStr);
  return !isNaN(date.getTime()) && date.toISOString().startsWith(dateStr.slice(0, 10));
}

/**
 * Format a Date object to a YYYY-MM-DD string.
 * @task T4552
 */
export function formatDateYMD(date: Date): string {
  return date.toISOString().split('T')[0]!;
}
