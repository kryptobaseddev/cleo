/**
 * Every agent cloud-messaging request goes through `conduitFetch` (T13169).
 *
 * The behavioural tests prove that `conduitFetch`, the transports and the
 * process-wide fetch guard refuse a retired SignalDock host. This scan proves
 * nothing walks around them: a source file that handles an agent's
 * `apiBaseUrl`/`sseEndpoint` or anything SignalDock may not make a network
 * call except through the gate. Each allowed site is matched line by line.
 *
 * @task T13169
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCANNED = ['core', 'cleo', 'runtime', 'cleo-os', 'studio', 'adapters', 'brain', 'playbooks'];
const EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs', '.svelte'];

/**
 * A permitted direct call: the line itself, optionally the line before it,
 * and optionally something in the three lines before it that pins the site.
 */
interface AllowedSite {
  line: RegExp;
  previous?: RegExp;
  context?: RegExp;
}

const ALLOWED: Record<string, AllowedSite[]> = {
  // The gate itself: the first-check pass-through and the per-hop request.
  'core/src/conduit/cloud-endpoint.ts': [
    { line: /return fetch\(url, init\);$/ },
    { line: /const response = await fetch\(current\.href, request\);$/ },
  ],
  // The EventSource opens only after the URL passed the gate on the line above.
  'core/src/conduit/sse-transport.ts': [
    { line: /const es = new EventSource\(url\);$/, previous: /assertCloudUrlAllowed\(url\);$/ },
  ],
  // LLM-provider and Pi-harness health probes: not agent cloud URLs (the
  // SignalDock probe in this file goes through conduitFetch).
  'core/src/setup/sections/verification.ts': [
    { line: /^fetch\(probeUrl, \{$/, previous: /await withTimeout\($/ },
    {
      line: /^fetch\(healthUrl, \{ signal: AbortSignal\.timeout\(3_000\) \}\),$/,
      previous: /await withTimeout\($/,
      context: /const healthUrl = piUrl\./,
    },
  ],
  // The GitHub releases fallback of self-update.
  'cleo/src/cli/commands/self-update.ts': [{ line: /await execAsync\('curl', \[$/ }],
  // Studio's own same-origin health route.
  'studio/src/routes/+page.svelte': [{ line: /await fetch\('\/api\/health'\);$/ }],
};

/** Files that touch an agent cloud URL or SignalDock. */
const RELEVANT = /\bapiBaseUrl\b|\bsseEndpoint\b|signaldock/i;

/** Ways to reach the network directly. */
const DIRECT_CALL = [
  /(?:^|[^.\w$])fetch\(/,
  /\b(?:globalThis|window|self)\.fetch\(/,
  /new EventSource\(/,
  /\bhttps?\.(?:request|get)\(/,
  /['"]undici['"]/,
  /['"`]curl\b/,
];

function sourceFiles(pkg: string): string[] {
  const root = join(PACKAGES, pkg, 'src');
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: 'utf-8' });
  } catch {
    return [];
  }
  return entries
    .filter((rel) => {
      const parts = rel.split(/[\\/]/);
      return (
        EXTENSIONS.some((ext) => rel.endsWith(ext)) &&
        !rel.endsWith('.d.ts') &&
        !/\.(?:test|spec)\.[a-z]+$/.test(rel) &&
        !parts.includes('__tests__') &&
        !parts.includes('generated')
      );
    })
    .map((rel) => join(root, rel));
}

function isAllowed(rel: string, lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? '';
  const previous = lines[index - 1]?.trim() ?? '';
  const context = lines.slice(Math.max(0, index - 3), index).join('\n');
  return (ALLOWED[rel] ?? []).some(
    (site) =>
      site.line.test(line) &&
      (site.previous === undefined || site.previous.test(previous)) &&
      (site.context === undefined || site.context.test(context)),
  );
}

describe('agent cloud requests use conduitFetch (T13169)', () => {
  it('no file that touches an agent cloud URL or SignalDock reaches the network directly', () => {
    const offenders: string[] = [];
    const scanned: string[] = [];
    for (const pkg of SCANNED) {
      for (const file of sourceFiles(pkg)) {
        const text = readFileSync(file, 'utf-8');
        if (!RELEVANT.test(text)) continue;
        const rel = relative(PACKAGES, file).split('\\').join('/');
        scanned.push(rel);
        const lines = text.split('\n');
        lines.forEach((raw, i) => {
          const code = raw.replace(/\/\/.*$/, '');
          if (/^\s*\*/.test(code)) return;
          if (!DIRECT_CALL.some((pattern) => pattern.test(code))) return;
          if (isAllowed(rel, lines, i)) return;
          offenders.push(`${rel}:${i + 1}: ${raw.trim()}`);
        });
      }
    }
    // The scan must have reached the call sites it guards.
    for (const required of [
      'core/src/conduit/http-transport.ts',
      'core/src/setup/sections/verification.ts',
      'runtime/src/services/heartbeat.ts',
      'cleo/src/cli/commands/agent.ts',
      'cleo/src/dispatch/domains/conduit.ts',
    ]) {
      expect(scanned).toContain(required);
    }
    expect(offenders.join('\n')).toBe('');
  });
});
