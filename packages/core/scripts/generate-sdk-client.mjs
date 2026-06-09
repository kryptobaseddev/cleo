#!/usr/bin/env node
/**
 * Build-time generator: projects the canonical CLEO OPERATIONS registry into an
 * OpenAPI 3.1 document (via {@link generateOpenApi}) and runs
 * `@hey-api/openapi-ts` over it to emit the ONE shared, typed SDK client that
 * every surface (CLI / TUI / Studio) consumes — written into
 * `packages/core/src/gateway-client/generated/`.
 *
 * Why core (not a `@cleocode/sdk` package)
 * ----------------------------------------
 * North-Star ratified decision: `@cleocode/core` IS the SDK. There is NO
 * separate `@cleocode/sdk` package. The generated client therefore lands as a
 * core subpath (`@cleocode/core/gateway-client`), a thin generated artifact over
 * the contracts-derived OpenAPI spec.
 *
 * Drift-safety
 * ------------
 * The spec is DERIVED from the registry (not hand-authored), so it can never
 * drift from the operations surface. The committed output is regenerable with
 * `pnpm --filter @cleocode/core run gen:sdk`. A `--check` mode regenerates into
 * a temp dir and diffs against the committed output, failing non-zero on any
 * delta — this is the seam a CI drift gate hangs off.
 *
 * Zero runtime dependency
 * -----------------------
 * The `@hey-api/client-fetch` plugin INLINES the entire client implementation
 * (it uses the platform `fetch`), so the committed output imports nothing
 * external. `@hey-api/openapi-ts` is a pure devDependency — consumers never run
 * codegen at install and `@cleocode/core` gains no new runtime dependency.
 *
 * No secret material (AC5)
 * ------------------------
 * Generation reads ONLY the structural OpenAPI doc. No credentials, tokens, or
 * env values are read or embedded. `createCleoClient({ baseUrl })` carries auth
 * exclusively at call time via caller-supplied headers.
 *
 * @task T11920 — M5/AC2: generate the single SDK client over the gateway
 * @epic T11769 — E-API-STANDARD-FOUNDATION
 * @saga T10400
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const CORE_DIST = join(PKG_ROOT, 'dist', 'index.js');
const GATEWAY_CLIENT_DIR = join(PKG_ROOT, 'src', 'gateway-client');
const GENERATED_DIR = join(GATEWAY_CLIENT_DIR, 'generated');
const NAMESPACES_FILE = join(GENERATED_DIR, 'namespaces.gen.ts');

const CHECK = process.argv.includes('--check');

/**
 * Resolve the OpenAPI 3.1 document by importing the registry-projection builder
 * from the BUILT core dist. The builder depends only on the OPERATIONS registry
 * and the input/output contracts — a cheap, side-effect-free import (no DB).
 */
async function resolveOpenApiDoc() {
  if (!fileExists(CORE_DIST)) {
    throw new Error(
      `[gen:sdk] core is not built — expected ${rel(CORE_DIST)}. Run the core build first ` +
        '(pnpm --filter @cleocode/core run build), then re-run gen:sdk.',
    );
  }
  const mod = await import(`file://${CORE_DIST}`);
  if (typeof mod.generateOpenApi !== 'function') {
    throw new Error('[gen:sdk] @cleocode/core dist does not export generateOpenApi.');
  }
  return mod.generateOpenApi();
}

/**
 * Run `@hey-api/openapi-ts` over a spec file, emitting the typed client + types
 * + flat SDK into `outDir`. Uses the bundled fetch client + typescript + sdk
 * plugins. `postProcess: []` keeps the generator from invoking any external
 * formatter/linter — the output is excluded from biome (see biome.json).
 */
async function runHeyApi(specPath, outDir) {
  const { createClient } = await import('@hey-api/openapi-ts');
  await createClient({
    input: specPath,
    output: { path: outDir, postProcess: [] },
    plugins: [
      // client-fetch INLINES the full fetch-based client into the output, so the
      // committed code imports nothing external (AC5: no runtime dep, no secrets).
      { name: '@hey-api/client-fetch' },
      // typescript emits per-operation Data/Response types from the schemas.
      { name: '@hey-api/typescript' },
      // sdk (default flat strategy) emits one exported function per operation,
      // typed against its Data/Response — the surface the namespace map binds.
      { name: '@hey-api/sdk' },
    ],
  });
}

/**
 * Derive the domain-namespaced surface from the OpenAPI doc. Every operation is
 * grouped by its canonical domain (tag) into a namespace; the method name is the
 * camelCased operation segment. The 8 ops that appear under BOTH the query and
 * mutate gateways within one domain are disambiguated with a `Query` / `Mutate`
 * suffix so the surface stays collision-free and deterministic.
 *
 * @returns {Map<string, Array<{ method: string, fn: string }>>}
 */
function deriveNamespaces(doc) {
  /** @type {Map<string, Array<{ method: string, fn: string, gateway: string }>>} */
  const byDomain = new Map();

  for (const item of Object.values(doc.paths)) {
    const op = item.post;
    const domain = op.tags[0];
    const gateway = op['x-cleo-gateway'];
    const operationId = op.operationId; // <gateway>.<domain>.<operation...>
    const prefix = `${gateway}.${domain}.`;
    const opSegment = operationId.startsWith(prefix)
      ? operationId.slice(prefix.length)
      : operationId;
    const method = camelCase(opSegment);
    const fn = sdkFnName(operationId);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ method, fn, gateway });
  }

  // Disambiguate within-namespace method collisions across gateways.
  /** @type {Map<string, Array<{ method: string, fn: string }>>} */
  const out = new Map();
  for (const [domain, entries] of byDomain) {
    const counts = new Map();
    for (const e of entries) counts.set(e.method, (counts.get(e.method) ?? 0) + 1);
    const resolved = entries.map((e) => {
      const method =
        (counts.get(e.method) ?? 0) > 1
          ? `${e.method}${capitalize(e.gateway)}`
          : e.method;
      return { method, fn: e.fn };
    });
    resolved.sort((a, b) => a.method.localeCompare(b.method));
    out.set(domain, resolved);
  }
  return out;
}

/**
 * Reproduce `@hey-api/sdk`'s exported function name for an operationId.
 * hey-api camelCases the dot/dash/slash-delimited operationId into a single
 * identifier (e.g. `query.tasks.show` → `queryTasksShow`,
 * `mutate.tasks.projection.repair` → `mutateTasksProjectionRepair`).
 */
function sdkFnName(operationId) {
  return camelCase(operationId);
}

/** camelCase a `.`/`-`/`/`/`_`/space-delimited identifier. */
function camelCase(raw) {
  const parts = raw.split(/[.\-/_ ]+/).filter(Boolean);
  if (parts.length === 0) return raw;
  return (
    parts[0].charAt(0).toLowerCase() +
    parts[0].slice(1) +
    parts
      .slice(1)
      .map((p) => capitalize(p))
      .join('')
  );
}

/** Capitalize the first letter. */
function capitalize(s) {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Emit the namespace map module (`namespaces.gen.ts`).
 *
 * The module re-exports the flat hey-api SDK functions grouped by domain into a
 * single `GENERATED_NAMESPACES` object. Crucially it holds the REAL function
 * references (no `as`-coercion), so `createCleoClient` can derive each bound
 * method's signature — and thus the full per-operation input/output types —
 * straight from the source function via a mapped type. This is what gives the
 * client end-to-end type safety with zero hand-maintained per-op types.
 */
function emitNamespaces(namespaces) {
  const domains = [...namespaces.keys()].sort();
  const importNames = [...new Set([...namespaces.values()].flat().map((e) => e.fn))].sort();

  const header = `// This file is auto-generated by packages/core/scripts/generate-sdk-client.mjs.
// DO NOT EDIT MANUALLY — regenerate via \`pnpm --filter @cleocode/core run gen:sdk\`.
//
// It groups the flat hey-api SDK functions into a domain-namespaced map, derived
// from the CLEO operations registry. \`createCleoClient\` (../client.ts) binds each
// entry to a per-client instance so every method targets the configured baseUrl,
// while preserving the per-operation request/response types from \`sdk.gen.ts\`.
//
// @task T11920 — M5/AC2
// @epic T11769
`;

  const imports = `import {\n${importNames.map((n) => `  ${n},`).join('\n')}\n} from './sdk.gen.js';\n`;

  const mapBody = domains
    .map((domain) => {
      const entries = namespaces.get(domain) ?? [];
      const lines = entries.map((e) => `    ${tsKey(e.method)}: ${e.fn},`).join('\n');
      return `  ${tsKey(domain)}: {\n${lines}\n  },`;
    })
    .join('\n');

  const map = `/**
 * The single generated namespace map consumed by \`createCleoClient\`. Each value
 * is the corresponding flat hey-api SDK function (with its full per-operation
 * types intact), grouped under its canonical domain.
 *
 * \`as const\` preserves the exact function-reference types so the bound client's
 * method signatures can be inferred from them.
 */
export const GENERATED_NAMESPACES = {\n${mapBody}\n} as const;\n`;

  const typeExport = `/** The structural type of {@link GENERATED_NAMESPACES} (domain → method → SDK fn). */
export type GeneratedNamespaces = typeof GENERATED_NAMESPACES;
`;

  return `${header}\n${imports}\n${map}\n${typeExport}`;
}

/**
 * A small set of generated method names collide with reserved words or are not
 * valid bare identifiers; quote those object keys. Everything else stays a bare
 * identifier so the output reads cleanly.
 */
function tsKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function rel(p) {
  return relative(process.cwd(), p);
}

/** Recursively read every file in a dir into a sorted `{ relPath → content }`. */
function snapshotDir(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!fileExists(dir)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const doc = await resolveOpenApiDoc();
  const pathCount = Object.keys(doc.paths).length;
  const namespaces = deriveNamespaces(doc);

  // 1. Write the spec to a temp file for the hey-api input.
  const work = mkdtempSync(join(tmpdir(), 'cleo-sdk-gen-'));
  const specPath = join(work, 'openapi.json');
  writeFileSync(specPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

  // 2. Generate hey-api output into a temp dir, then assemble the final tree.
  const heyOut = join(work, 'hey-out');
  await runHeyApi(specPath, heyOut);

  const stagedNamespaces = emitNamespaces(namespaces);

  if (CHECK) {
    const expected = { ...snapshotDir(heyOut), 'namespaces.gen.ts': stagedNamespaces };
    const actual = snapshotDir(GENERATED_DIR);
    const drift = diffSnapshots(expected, actual);
    rmSync(work, { recursive: true, force: true });
    if (drift.length > 0) {
      process.stderr.write(
        `[gen:sdk --check] generated SDK client is STALE (${drift.length} file(s) differ):\n` +
          drift.map((d) => `  - ${d}`).join('\n') +
          '\n\nRegenerate with: pnpm --filter @cleocode/core run gen:sdk\n',
      );
      process.exit(1);
    }
    process.stdout.write(`[gen:sdk --check] OK — generated client in sync (${pathCount} ops).\n`);
    return;
  }

  // 3. Replace the committed generated dir atomically-ish.
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  mkdirSync(GENERATED_DIR, { recursive: true });
  cpSync(heyOut, GENERATED_DIR, { recursive: true });
  writeFileSync(NAMESPACES_FILE, stagedNamespaces, 'utf8');

  rmSync(work, { recursive: true, force: true });
  process.stdout.write(
    `[gen:sdk] wrote ${rel(GENERATED_DIR)} (${pathCount} ops, ${namespaces.size} namespaces).\n`,
  );
}

/** Compute the list of relative paths that differ between two dir snapshots. */
function diffSnapshots(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const drift = [];
  for (const k of [...keys].sort()) {
    if (expected[k] !== actual[k]) drift.push(k);
  }
  return drift;
}

main().catch((err) => {
  process.stderr.write(`[gen:sdk] FAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
