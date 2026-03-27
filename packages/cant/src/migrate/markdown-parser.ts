/**
 * Heuristic markdown section parser for CANT migration.
 *
 * Splits markdown content into sections by headings and classifies
 * each section by matching against known agent/hook/skill/permission patterns.
 * This is intentionally conservative -- unknown patterns are left as-is.
 */

import type {
  ExtractedPermission,
  ExtractedProperty,
  MarkdownSection,
  SectionClassification,
} from './types';

/**
 * Known CAAMP hook event names (PascalCase).
 * Used to identify hook sections from headings like "On Session Start".
 */
const CAAMP_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'PromptSubmit',
  'ResponseComplete',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'PreModel',
  'PostModel',
  'PreCompact',
  'PostCompact',
  'Notification',
  'ConfigChange',
]);

/**
 * Heading patterns that suggest a hook definition section.
 * Case-insensitive matching against heading text.
 */
const HOOK_HEADING_PATTERNS = [
  /^on\s+session\s*start/i,
  /^on\s+session\s*end/i,
  /^on\s+prompt\s*submit/i,
  /^on\s+response\s*complete/i,
  /^on\s+pre\s*tool\s*use/i,
  /^on\s+post\s*tool\s*use/i,
  /^on\s+post\s*tool\s*use\s*failure/i,
  /^on\s+permission\s*request/i,
  /^on\s+subagent\s*start/i,
  /^on\s+subagent\s*stop/i,
  /^on\s+pre\s*model/i,
  /^on\s+post\s*model/i,
  /^on\s+pre\s*compact/i,
  /^on\s+post\s*compact/i,
  /^on\s+notification/i,
  /^on\s+config\s*change/i,
  /^when\s+.*\s+start/i,
  /^when\s+.*\s+end/i,
  /^hooks?\b/i,
];

/**
 * Parse markdown content into classified sections.
 *
 * Splits on `##` and `###` headings, classifies each section by
 * heuristic pattern matching, and returns structured section data
 * with line numbers for source mapping.
 *
 * @param content - Raw markdown content
 * @returns Array of parsed and classified sections
 */
export function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];
  let currentSection: Partial<MarkdownSection> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);

    if (headingMatch) {
      // Finalize previous section
      if (currentSection?.heading) {
        finalizeSection(currentSection as MarkdownSection, i, sections);
      }

      const level = (headingMatch[1] ?? '').length;
      const heading = (headingMatch[2] ?? '').trim();

      currentSection = {
        heading,
        level,
        lineStart: i + 1, // 1-based
        bodyLines: [],
        classification: 'unknown',
      };
    } else if (currentSection) {
      currentSection.bodyLines = currentSection.bodyLines ?? [];
      currentSection.bodyLines.push(line);
    }
  }

  // Finalize last section
  if (currentSection?.heading) {
    finalizeSection(currentSection as MarkdownSection, lines.length, sections);
  }

  return sections;
}

/**
 * Finalize a section: set lineEnd, trim trailing blank lines, classify.
 */
function finalizeSection(
  section: MarkdownSection,
  nextLineIndex: number,
  sections: MarkdownSection[],
): void {
  section.lineEnd = nextLineIndex; // 1-based exclusive becomes the end

  // Trim trailing blank lines from body
  while (
    section.bodyLines.length > 0 &&
    (section.bodyLines[section.bodyLines.length - 1] ?? '').trim() === ''
  ) {
    section.bodyLines.pop();
  }

  section.classification = classifySection(section);
  sections.push(section);
}

/**
 * Classify a markdown section based on its heading and content.
 *
 * Uses heuristic matching against known patterns. Returns 'unknown'
 * for sections that cannot be confidently classified.
 *
 * @param section - The section to classify
 * @returns The classification type
 */
export function classifySection(section: MarkdownSection): SectionClassification {
  const heading = section.heading;

  // Agent patterns: "## Agent: X", "## X Agent", "## Code Review Agent"
  if (/\bagent\b/i.test(heading)) {
    return 'agent';
  }

  // Permission patterns: "## Permissions", "### Permissions"
  if (/^permissions?\b/i.test(heading)) {
    return 'permissions';
  }

  // Hook patterns
  for (const pattern of HOOK_HEADING_PATTERNS) {
    if (pattern.test(heading)) {
      return 'hook';
    }
  }

  // Skill patterns: "## Skills", "## Skill: X"
  if (/\bskills?\b/i.test(heading)) {
    return 'skill';
  }

  // Workflow/procedure patterns
  if (/\b(workflow|procedure|deploy|pipeline)\b/i.test(heading)) {
    return 'workflow';
  }

  // Try content-based classification for agent-like sections
  if (hasAgentProperties(section.bodyLines)) {
    return 'agent';
  }

  return 'unknown';
}

/**
 * Check if body lines contain agent-like property patterns.
 *
 * Looks for key-value bullet lists with keys like "Model", "Prompt",
 * "Persistence", "Skills", etc.
 */
function hasAgentProperties(bodyLines: string[]): boolean {
  const agentKeys = /\b(model|prompt|persist(ence)?|skills?)\b/i;
  let matchCount = 0;

  for (const line of bodyLines) {
    if (/^[-*]\s+\*?\*?/.test(line) && agentKeys.test(line)) {
      matchCount++;
    }
  }

  // Need at least 2 agent-like properties to classify
  return matchCount >= 2;
}

/**
 * Extract key-value properties from markdown bullet lists.
 *
 * Matches patterns like:
 * - `- **Key**: value`
 * - `- **Key**: value`
 * - `- Key: value`
 *
 * @param lines - Body lines of a section
 * @returns Array of extracted properties
 */
export function extractProperties(lines: string[]): ExtractedProperty[] {
  const properties: ExtractedProperty[] = [];

  for (const line of lines) {
    // Match: - **Key**: value  or  - Key: value
    const match = line.match(/^[-*]\s+\*{0,2}([A-Za-z][A-Za-z0-9 _-]*?)\*{0,2}\s*:\s*(.+)$/);
    if (match) {
      const key = (match[1] ?? '').trim().toLowerCase();
      const value = (match[2] ?? '').trim();
      properties.push({ key, value });
    }
  }

  return properties;
}

/**
 * Extract permission entries from markdown content.
 *
 * Handles two formats:
 * 1. Structured: `- Tasks: read, write`
 * 2. Prose: `- Read and write tasks`
 *
 * @param lines - Body lines of a permissions section
 * @returns Array of extracted permissions
 */
export function extractPermissions(lines: string[]): ExtractedPermission[] {
  const permissions: ExtractedPermission[] = [];

  for (const line of lines) {
    // Format 1: "- Tasks: read, write"
    const structuredMatch = line.match(/^[-*]\s+([A-Za-z]+)\s*:\s*(.+)$/);
    if (structuredMatch) {
      const domain = (structuredMatch[1] ?? '').trim().toLowerCase();
      const rawValues = (structuredMatch[2] ?? '').trim();
      const values = rawValues
        .split(/[,\s]+/)
        .map((v) => v.trim().toLowerCase())
        .filter((v) => ['read', 'write', 'execute'].includes(v));

      if (values.length > 0) {
        permissions.push({ domain, values });
        continue;
      }
    }

    // Format 2: "- Read and write tasks"
    const proseMatch = line.match(
      /^[-*]\s+(read|write|execute)(?:\s+and\s+(read|write|execute))?\s+(\w+)/i,
    );
    if (proseMatch) {
      const values = [(proseMatch[1] ?? '').toLowerCase()];
      if (proseMatch[2]) {
        values.push(proseMatch[2].toLowerCase());
      }
      const domain = (proseMatch[3] ?? '').toLowerCase();
      permissions.push({ domain, values });
    }
  }

  return permissions;
}

/**
 * Normalize a heading into a valid CANT identifier.
 *
 * Converts "Code Review Agent" to "code-review-agent", strips
 * common suffixes like " Agent", lowercases, and replaces
 * non-alphanumeric chars with hyphens.
 *
 * @param heading - The raw heading text
 * @returns A valid CANT identifier
 */
export function headingToIdentifier(heading: string): string {
  return heading
    .replace(/\bagent\b/gi, '')
    .replace(/^[:]\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Map a hook heading to a CAAMP event name.
 *
 * Converts headings like "On Session Start" to "SessionStart".
 * Returns null if the heading does not match a known event.
 *
 * @param heading - The raw heading text
 * @returns The CAAMP PascalCase event name, or null
 */
export function headingToEventName(heading: string): string | null {
  // Direct "On EventName" pattern
  const onMatch = heading.match(/^on\s+(.+)$/i);
  if (onMatch) {
    const eventCandidate = (onMatch[1] ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^(\w)/, (_, c: string) => c.toUpperCase());

    if (CAAMP_EVENTS.has(eventCandidate)) {
      return eventCandidate;
    }
  }

  // "When session starts" -> "SessionStart" (common prose variant)
  const whenMatch = heading.match(/^when\s+(?:a\s+)?(\w+)\s+starts?$/i);
  if (whenMatch) {
    const noun = (whenMatch[1] ?? '').trim();
    const candidate = `${noun.charAt(0).toUpperCase()}${noun.slice(1).toLowerCase()}Start`;
    if (CAAMP_EVENTS.has(candidate)) {
      return candidate;
    }
  }

  const whenEndMatch = heading.match(/^when\s+(?:a\s+)?(\w+)\s+ends?$/i);
  if (whenEndMatch) {
    const noun = (whenEndMatch[1] ?? '').trim();
    const candidate = `${noun.charAt(0).toUpperCase()}${noun.slice(1).toLowerCase()}End`;
    if (CAAMP_EVENTS.has(candidate)) {
      return candidate;
    }
  }

  // Generic "Hooks" heading -> null (contains multiple hooks, not a single event)
  return null;
}

/**
 * Get the full set of CAAMP event names.
 *
 * @returns A read-only set of the 16 canonical CAAMP events
 */
export function getCaampEvents(): ReadonlySet<string> {
  return CAAMP_EVENTS;
}
