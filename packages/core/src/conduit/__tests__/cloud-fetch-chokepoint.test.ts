/**
 * Every network call site in packages/* is known, and agent cloud requests go
 * through `conduitFetch` (T13169).
 *
 * The behavioural tests prove that `conduitFetch`, the transports and the
 * CLI's process-wide fetch guard refuse a retired SignalDock host. This scan
 * proves nothing walks around them. It finds every direct network primitive
 * (`fetch`, `globalThis.fetch`, `http`/`https` `request`/`get`,
 * `EventSource`, `WebSocket`, `undici`) in every package's source and
 * compares the call sites, one by one, with the reviewed list in
 * `fixtures/network-call-sites.json`. A new site fails until it is reviewed
 * and listed. A site that is gone fails until it is removed from the list.
 * Agent cloud URLs must never appear as a new direct call: use `conduitFetch`.
 *
 * @task T13169
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '..', '..', '..', '..');
const EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs', '.svelte'];

/** Direct network primitives. */
const NETWORK_PRIMITIVES: readonly RegExp[] = [
  /(?:^|[^.\w$])fetch\(/,
  /\b(?:globalThis|window|self)\.fetch\(/,
  /\bnew (?:EventSource|WebSocket)\(/,
  /\bhttps?\.(?:request|get)\(/,
  /['"]undici['"]/,
];

/**
 * The direct network call sites in one source file, as
 * `<package path> :: <trimmed line>`. Comment lines are ignored.
 */
function findNetworkCalls(rel: string, text: string): string[] {
  const sites: string[] = [];
  for (const raw of text.split('\n')) {
    const code = raw.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code) || /^\s*\/\*/.test(code)) continue;
    if (NETWORK_PRIMITIVES.some((pattern) => pattern.test(code))) {
      sites.push(`${rel} :: ${raw.trim()}`);
    }
  }
  return sites;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const root = join(PACKAGES, pkg, 'src');
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: 'utf-8' });
    } catch {
      continue;
    }
    for (const rel of entries) {
      const parts = rel.split(/[\\/]/);
      if (
        EXTENSIONS.some((ext) => rel.endsWith(ext)) &&
        !rel.endsWith('.d.ts') &&
        !/\.(?:test|spec)\.[a-z]+$/.test(rel) &&
        !parts.includes('__tests__') &&
        !parts.includes('generated')
      ) {
        files.push(join(root, rel));
      }
    }
  }
  return files;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('network call sites (T13169)', () => {
  it('every direct network call site in packages/*/src is reviewed and listed', () => {
    const actual: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(PACKAGES, file).split('\\').join('/');
      actual.push(...findNetworkCalls(rel, readFileSync(file, 'utf-8')));
    }
    const listed: string[] = JSON.parse(
      readFileSync(join(HERE, 'fixtures', 'network-call-sites.json'), 'utf-8'),
    );
    const remaining = [...listed];
    const unlisted: string[] = [];
    for (const site of actual) {
      const at = remaining.indexOf(site);
      if (at === -1) unlisted.push(site);
      else remaining.splice(at, 1);
    }
    expect({ unlisted: sorted(unlisted), gone: sorted(remaining) }).toEqual({
      unlisted: [],
      gone: [],
    });
  });

  it('the SSE EventSource opens only after the URL passed the gate', () => {
    const text = readFileSync(join(PACKAGES, 'core/src/conduit/sse-transport.ts'), 'utf-8');
    expect(text).toMatch(/assertCloudUrlAllowed\(url\);\s*const es = new EventSource\(url\);/);
  });

  it.each([
    ['fetch', 'const r = await fetch(credential.apiBaseUrl + "/agents/x/status", {'],
    ['globalThis.fetch', 'await globalThis.fetch(url);'],
    ['EventSource', 'const es = new EventSource(endpoint);'],
    ['WebSocket', 'const ws = new WebSocket(config.wsUrl);'],
    ['https.request', 'const req = https.request(options, onResponse);'],
    ['http.get', 'http.get(url, (res) => res.resume());'],
    ['undici', "import { request } from 'undici';"],
  ])('a planted %s call is found', (_name, line) => {
    expect(findNetworkCalls('planted.ts', `const a = 1;\n${line}\n`)).toEqual([
      `planted.ts :: ${line}`,
    ]);
  });

  it('a call through conduitFetch, a method named fetch, or a comment is not a direct call', () => {
    const text = [
      'await conduitFetch(url, init);',
      'await this.fetch(path);',
      '// fetch(url) would be wrong here',
      ' * fetch(url) in TSDoc',
    ].join('\n');
    expect(findNetworkCalls('ok.ts', text)).toEqual([]);
  });
});
