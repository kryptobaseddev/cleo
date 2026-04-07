/**
 * Source URL/path classifier
 *
 * Classifies inputs as remote URLs, npm packages, GitHub shorthand,
 * GitLab URLs, local paths, or shell commands.
 */

import type { ParsedSource, SourceType } from '../../types.js';

const GITHUB_SHORTHAND = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\/(.+))?$/;
const GITHUB_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?/;
const GITLAB_URL =
  /^https?:\/\/(?:www\.)?gitlab\.com\/([^/]+)\/([^/]+)(?:\/-\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?/;
const HTTP_URL = /^https?:\/\//;
const NPM_SCOPED = /^@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const NPM_PACKAGE = /^[a-zA-Z0-9_.-]+$/;
const LIBRARY_SKILL = /^(@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+|[a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)$/;

/** Infer a display name from a source */
function inferName(source: string, type: SourceType): string {
  if (type === 'library') {
    const match = source.match(LIBRARY_SKILL);
    return match?.[2] ?? source;
  }

  if (type === 'remote') {
    try {
      const url = new URL(source);
      // Extract brand from hostname: mcp.neon.tech -> neon
      const parts = url.hostname.split('.');
      if (parts.length >= 2) {
        const fallback = parts[0] ?? source;
        const secondLevel = parts[parts.length - 2] ?? fallback;
        const brand = parts.length === 3 ? secondLevel : fallback;
        if (brand !== 'www' && brand !== 'api' && brand !== 'mcp') {
          return brand;
        }
        // Fall back to second-level domain
        return secondLevel;
      }
      return parts[0] ?? source;
    } catch {
      return source;
    }
  }

  if (type === 'package') {
    // Strip common MCP prefixes/suffixes
    let name = source.replace(/^@[^/]+\//, ''); // Remove scope
    name = name.replace(/^mcp-server-/, '');
    name = name.replace(/^server-/, '');
    name = name.replace(/-mcp$/, '');
    name = name.replace(/-server$/, '');
    return name;
  }

  if (type === 'github' || type === 'gitlab') {
    // Use repo name
    const match = source.match(/\/([^/]+?)(?:\.git)?$/);
    return match?.[1] ?? source;
  }

  if (type === 'local') {
    // Extract directory basename from local path
    const normalized = source.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSegment = normalized.split('/').pop();
    return lastSegment ?? source;
  }

  if (type === 'command') {
    // Extract first meaningful word
    const parts = source.split(/\s+/);
    const command = parts.find(
      (p) => !p.startsWith('-') && p !== 'npx' && p !== 'node' && p !== 'python' && p !== 'python3',
    );
    return command ?? parts[0] ?? source;
  }

  return source;
}

/**
 * Parse and classify a source string into a typed {@link ParsedSource}.
 *
 * @remarks
 * Supports GitHub URLs, GitLab URLs, GitHub shorthand (`owner/repo`),
 * HTTP URLs (remote MCP servers), npm package names, local paths, and
 * shell commands as a fallback.
 *
 * @param input - Raw source string to classify
 * @returns Parsed source with type, value, and inferred name
 *
 * @example
 * ```typescript
 * parseSource("owner/repo");
 * // { type: "github", value: "https://github.com/owner/repo", inferredName: "repo", ... }
 *
 * parseSource("https://mcp.example.com/sse");
 * // { type: "remote", value: "https://mcp.example.com/sse", inferredName: "example" }
 *
 * parseSource("@modelcontextprotocol/server-filesystem");
 * // { type: "package", value: "@modelcontextprotocol/server-filesystem", inferredName: "filesystem" }
 * ```
 *
 * @public
 */
export function parseSource(input: string): ParsedSource {
  // GitHub URL
  const ghUrlMatch = input.match(GITHUB_URL);
  if (ghUrlMatch) {
    const owner = ghUrlMatch[1];
    const repo = ghUrlMatch[2];
    const path = ghUrlMatch[4];
    if (!owner || !repo) {
      return { type: 'command', value: input, inferredName: inferName(input, 'command') };
    }
    // Use last path segment as name if subpath provided, otherwise use repo name
    const inferredName = path ? (path.split('/').pop() ?? repo) : repo;
    return {
      type: 'github',
      value: input,
      inferredName,
      owner,
      repo,
      ref: ghUrlMatch[3],
      path,
    };
  }

  // GitLab URL
  const glUrlMatch = input.match(GITLAB_URL);
  if (glUrlMatch) {
    const owner = glUrlMatch[1];
    const repo = glUrlMatch[2];
    const path = glUrlMatch[4];
    if (!owner || !repo) {
      return { type: 'command', value: input, inferredName: inferName(input, 'command') };
    }
    // Use last path segment as name if subpath provided, otherwise use repo name
    const inferredName = path ? (path.split('/').pop() ?? repo) : repo;
    return {
      type: 'gitlab',
      value: input,
      inferredName,
      owner,
      repo,
      ref: glUrlMatch[3],
      path,
    };
  }

  // HTTP URL (non-GitHub/GitLab = remote MCP server)
  if (HTTP_URL.test(input)) {
    return {
      type: 'remote',
      value: input,
      inferredName: inferName(input, 'remote'),
    };
  }

  // Local path (check before GitHub shorthand since ./ and ../ match shorthand regex)
  if (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('~')
  ) {
    return {
      type: 'local',
      value: input,
      inferredName: inferName(input, 'local'),
    };
  }

  // GitHub shorthand: owner/repo or owner/repo/path
  const ghShorthand = input.match(GITHUB_SHORTHAND);
  if (ghShorthand && !NPM_SCOPED.test(input)) {
    const owner = ghShorthand[1];
    const repo = ghShorthand[2];
    const path = ghShorthand[3];
    if (!owner || !repo) {
      return { type: 'command', value: input, inferredName: inferName(input, 'command') };
    }
    // Use last path segment as name if subpath provided, otherwise use repo name
    const inferredName = path ? (path.split('/').pop() ?? repo) : repo;
    return {
      type: 'github',
      value: `https://github.com/${owner}/${repo}`,
      inferredName,
      owner,
      repo,
      path,
    };
  }

  // Library skill: package:skill or @scope/package:skill
  const libraryMatch = input.match(LIBRARY_SKILL);
  if (libraryMatch) {
    return {
      type: 'library',
      value: input,
      inferredName: inferName(input, 'library'),
      owner: libraryMatch[1], // This will be the package name, e.g. @cleocode/skills
      repo: libraryMatch[2], // This will be the skill name, e.g. ct-research-agent
    };
  }

  // Scoped npm package: @scope/name
  if (NPM_SCOPED.test(input)) {
    return {
      type: 'package',
      value: input,
      inferredName: inferName(input, 'package'),
    };
  }

  // Simple npm package name (no spaces, no slashes)
  if (NPM_PACKAGE.test(input) && !input.includes(' ')) {
    return {
      type: 'package',
      value: input,
      inferredName: inferName(input, 'package'),
    };
  }

  // Default: treat as command
  return {
    type: 'command',
    value: input,
    inferredName: inferName(input, 'command'),
  };
}

/**
 * Check if a source string looks like a marketplace scoped name (`@author/name`).
 *
 * @remarks
 * Matches strings in the `@scope/name` format commonly used by npm packages
 * and marketplace skill identifiers.
 *
 * @param input - Source string to check
 * @returns `true` if the input matches the `@scope/name` pattern
 *
 * @example
 * ```typescript
 * isMarketplaceScoped("@anthropic/my-skill"); // true
 * isMarketplaceScoped("my-skill");             // false
 * isMarketplaceScoped("owner/repo");           // false
 * ```
 *
 * @public
 */
export function isMarketplaceScoped(input: string): boolean {
  return /^@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input);
}
