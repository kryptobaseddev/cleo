/**
 * Instruction template management
 *
 * Generates injection content based on provider capabilities.
 * Includes structured InjectionTemplate API for project-level customization.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { InstructionDelivery } from '@cleocode/contracts/caamp-markers';
import type { Provider } from '../../types.js';

// ── InjectionTemplate API ───────────────────────────────────────────

/**
 * Structured template for injection content.
 *
 * @remarks
 * Projects use this to define what goes between CAAMP markers in
 * instruction files, rather than passing ad-hoc strings.
 *
 * @public
 */
export interface InjectionTemplate {
  /** References to include (e.g. `"\@AGENTS.md"`, `"\@.cleo/project-context.json"`). */
  references: string[];
  /** Inline content blocks (raw markdown/text). @defaultValue `undefined` */
  content?: string[];
}

/**
 * Build injection content from a structured template.
 *
 * Produces a string suitable for injection between CAAMP markers.
 * References are output as `@` lines, content blocks are appended as-is.
 *
 * @param template - Template defining references and content
 * @returns Formatted injection content string
 *
 * @remarks
 * References are output one per line. Content blocks are appended after a
 * blank separator line when references are present.
 *
 * @example
 * ```typescript
 * const content = buildInjectionContent({
 *   references: ["\@AGENTS.md"],
 * });
 * ```
 *
 * @public
 */
export function buildInjectionContent(template: InjectionTemplate): string {
  const lines: string[] = [];

  for (const ref of template.references) {
    lines.push(ref);
  }

  if (template.content && template.content.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(...template.content);
  }

  return lines.join('\n');
}

/**
 * Parse injection content back into template form.
 *
 * Lines starting with `@` are treated as references.
 * All other non-empty lines are treated as content blocks.
 *
 * @param content - Raw injection content string
 * @returns Parsed InjectionTemplate
 *
 * @remarks
 * Inverse of {@link buildInjectionContent}. Empty lines are ignored.
 *
 * @example
 * ```typescript
 * const template = parseInjectionContent("\@AGENTS.md\n\@.cleo/config.json");
 * ```
 *
 * @public
 */
export function parseInjectionContent(content: string): InjectionTemplate {
  const references: string[] = [];
  const contentLines: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('@')) {
      references.push(trimmed);
    } else {
      contentLines.push(line);
    }
  }

  return {
    references,
    content: contentLines.length > 0 ? contentLines : undefined,
  };
}

// ── Legacy API (preserved) ──────────────────────────────────────────

/**
 * Generate a standard CAAMP injection block for instruction files.
 *
 * Produces markdown content suitable for injection between CAAMP markers.
 * Optionally includes MCP server and custom content sections.
 *
 * @remarks
 * This is the legacy API preserved for backward compatibility. New code
 * should prefer {@link buildInjectionContent} with an `InjectionTemplate`.
 *
 * @param options - Optional configuration for the generated content
 * @returns Generated markdown string
 *
 * @example
 * ```typescript
 * const content = generateInjectionContent({ mcpServerName: "filesystem" });
 * ```
 *
 * @public
 */
export function generateInjectionContent(options?: {
  mcpServerName?: string;
  customContent?: string;
}): string {
  const lines: string[] = [];

  lines.push('## CAAMP Managed Configuration');
  lines.push('');
  lines.push('This section is managed by [CAAMP](https://github.com/caamp/caamp).');
  lines.push('Do not edit between the CAAMP markers manually.');

  if (options?.mcpServerName) {
    lines.push('');
    lines.push(`### MCP Server: ${options.mcpServerName}`);
    lines.push(`Configured via \`caamp mcp install\`.`);
  }

  if (options?.customContent) {
    lines.push('');
    lines.push(options.customContent);
  }

  return lines.join('\n');
}

/**
 * Generate a skills discovery section for instruction files.
 *
 * @remarks
 * Produces a markdown list of installed skill names. Returns an empty string
 * when no skills are provided.
 *
 * @param skillNames - Array of skill names to list
 * @returns Markdown string listing installed skills
 *
 * @example
 * ```typescript
 * const section = generateSkillsSection(["code-review", "testing"]);
 * ```
 *
 * @public
 */
export function generateSkillsSection(skillNames: string[]): string {
  if (skillNames.length === 0) return '';

  const lines: string[] = [];
  lines.push('### Installed Skills');
  lines.push('');

  for (const name of skillNames) {
    lines.push(`- \`${name}\` - Available via SKILL.md`);
  }

  return lines.join('\n');
}

/**
 * Get the correct instruction file name for a provider.
 *
 * @remarks
 * Simple accessor that returns the `instructFile` property from the provider
 * registry entry (e.g. `"CLAUDE.md"`, `"AGENTS.md"`, `"GEMINI.md"`).
 *
 * @param provider - Provider registry entry
 * @returns Instruction file name
 *
 * @example
 * ```typescript
 * const fileName = getInstructFile(provider);
 * // "CLAUDE.md"
 * ```
 *
 * @public
 */
export function getInstructFile(provider: Provider): string {
  return provider.instructFile;
}

/**
 * Group providers by their instruction file name.
 *
 * Useful for determining which providers share the same instruction file
 * (e.g. multiple providers using `AGENTS.md`).
 *
 * @param providers - Array of providers to group
 * @returns Map from instruction file name to array of providers using that file
 *
 * @remarks
 * Useful for determining which providers share the same instruction file
 * to avoid duplicate file operations.
 *
 * @example
 * ```typescript
 * const groups = groupByInstructFile(getAllProviders());
 * for (const [file, providers] of groups) {
 *   console.log(`${file}: ${providers.map(p => p.id).join(", ")}`);
 * }
 * ```
 *
 * @public
 */
export function groupByInstructFile(providers: Provider[]): Map<string, Provider[]> {
  const groups = new Map<string, Provider[]>();

  for (const provider of providers) {
    const existing = groups.get(provider.instructFile) ?? [];
    existing.push(provider);
    groups.set(provider.instructFile, existing);
  }

  return groups;
}

/**
 * Expand instruction references into bounded, self-contained managed content.
 *
 * Code placed in `packages/caamp/` per Package-Boundary Check — verified against AGENTS.md.
 * Missing files and cycles are explicit findings; callers must refuse incomplete writes.
 * Marker lines are removed from embedded files so nested managed blocks cannot corrupt
 * the destination. References inside fenced examples are preserved as examples.
 *
 * @param content - Managed content containing standalone reference lines.
 * @param baseDir - Directory against which the first references resolve.
 * @returns Resolved bootstrap and deterministic delivery diagnostics.
 * @example
 * ```typescript
 * const delivery = await resolveInstructionDelivery('@AGENTS.md', '/project');
 * ```
 * @public
 */
export async function resolveInstructionDelivery(
  content: string,
  baseDir: string,
): Promise<InstructionDelivery> {
  const result: InstructionDelivery = {
    content: '',
    sources: [],
    findings: [],
    liveEvaluation: 'unverified',
  };
  const visited = new Set<string>();
  let bytes = 0;
  async function expand(text: string, directory: string, ancestors: string[]): Promise<string> {
    const lines: string[] = [];
    let fence: string | null = null;
    for (const line of text.split('\n')) {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch?.[1]) {
        if (!fence) fence = fenceMatch[1];
        else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length)
          fence = null;
        lines.push(line);
        continue;
      }
      const stamp = !fence ? /^<!-- CAAMP:SOURCE (\S+) ([a-f0-9]{64}) -->$/.exec(line) : null;
      if (stamp?.[1] && stamp[2]) {
        let sourcePath = stamp[1];
        try {
          sourcePath = decodeURIComponent(sourcePath);
          const sourceSize = (await stat(sourcePath)).size;
          bytes += sourceSize;
          if (bytes > 524288) {
            result.findings.push({
              kind: 'limit',
              path: sourcePath,
              reason: 'Instruction byte budget exceeded.',
            });
          } else {
            const digest = createHash('sha256')
              .update(await readFile(sourcePath))
              .digest('hex');
            if (digest !== stamp[2])
              result.findings.push({
                kind: 'stale',
                path: sourcePath,
                reason: 'Embedded source changed after delivery.',
              });
          }
        } catch (error) {
          result.findings.push({
            kind: 'missing-reference',
            path: sourcePath,
            reason: String(error),
          });
        }
        lines.push(line);
        continue;
      }
      const ref = !fence ? /^\s*@([^\s]+)\s*$/.exec(line)?.[1] : undefined;
      if (!ref) {
        if (!/^\s*<!-- CAAMP:(START|END) -->\s*$/.test(line)) lines.push(line);
        continue;
      }
      let path = resolve(directory, ref.startsWith('~/') ? resolve(homedir(), ref.slice(2)) : ref);
      try {
        path = await realpath(path);
      } catch (error) {
        result.findings.push({ kind: 'missing-reference', path, reason: String(error) });
        continue;
      }
      if (ancestors.includes(path)) {
        result.findings.push({ kind: 'cycle', path, reason: 'Reference repeats an ancestor.' });
        continue;
      }
      if (visited.has(path)) {
        result.findings.push({ kind: 'duplicate', path, reason: 'Source already embedded once.' });
        continue;
      }
      if (ancestors.length >= 16 || visited.size >= 64 || bytes >= 524288) {
        result.findings.push({
          kind: 'limit',
          path,
          reason: 'Instruction expansion budget exceeded.',
        });
        continue;
      }
      try {
        bytes += (await stat(path)).size;
        if (bytes > 524288) {
          result.findings.push({
            kind: 'limit',
            path,
            reason: 'Instruction byte budget exceeded.',
          });
          continue;
        }
        const source = await readFile(path, 'utf8');
        visited.add(path);
        result.sources.push(path);
        lines.push(
          `<!-- CAAMP:SOURCE ${encodeURIComponent(path)} ${createHash('sha256').update(source).digest('hex')} -->`,
        );
        lines.push(await expand(source, dirname(path), [...ancestors, path]));
      } catch (error) {
        result.findings.push({ kind: 'missing-reference', path, reason: String(error) });
      }
    }
    return lines.join('\n');
  }
  result.content = await expand(content, baseDir, []);
  return result;
}
