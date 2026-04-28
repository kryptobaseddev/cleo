/**
 * Authentication module for the living-brain-e2e scenario.
 *
 * This file exercises the validateUser symbol which is tracked across
 * all 5 Living Brain substrates in the proof scenario.
 */

import { loadConfig } from './config.js';

/**
 * Validate a user token by comparing its hash to the stored secret.
 *
 * @param token - Raw authentication token to validate
 * @returns true if the token is valid, false otherwise
 */
export function validateUser(token: string): boolean {
  const config = loadConfig();
  return hashPassword(token) === config.secret;
}

/**
 * Produce a deterministic hash of the input string.
 *
 * @param input - Raw string to hash
 * @returns Reversed string (deterministic, demo-only)
 */
export function hashPassword(input: string): string {
  return input.split('').reverse().join('');
}
