/**
 * RFC 8615 well-known skills discovery
 *
 * Checks /.well-known/skills/ on websites for skill definitions.
 */

import { fetchWithTimeout } from "../network/fetch.js";

/**
 * A skill entry discovered via the RFC 8615 well-known endpoint.
 *
 * @public
 */
export interface WellKnownSkill {
  /** Skill name. */
  name: string;
  /** Human-readable description of the skill. */
  description: string;
  /** URL where the skill content can be fetched. */
  url: string;
}

/**
 * Discover skills from a well-known URL.
 *
 * @remarks
 * Fetches `https://{domain}/.well-known/skills/index.json` and parses
 * the response as an array of skill definitions. Returns an empty array
 * if the endpoint is unreachable or returns an error.
 *
 * @param domain - Domain name to query (e.g. `"example.com"`)
 * @returns Array of discovered skill entries
 *
 * @example
 * ```typescript
 * const skills = await discoverWellKnown("example.com");
 * for (const skill of skills) {
 *   console.log(`${skill.name}: ${skill.url}`);
 * }
 * ```
 *
 * @public
 */
export async function discoverWellKnown(domain: string): Promise<WellKnownSkill[]> {
  const url = `https://${domain}/.well-known/skills/index.json`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return [];

    const data = (await response.json()) as { skills?: WellKnownSkill[] };
    return data.skills ?? [];
  } catch {
    return [];
  }
}
