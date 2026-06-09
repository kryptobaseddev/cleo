/**
 * `cleo gateway` — REST gateway introspection surface.
 *
 * Currently exposes a single subverb:
 *
 *   - `cleo gateway openapi [--out <file>]` — project the canonical OPERATIONS
 *     registry into an OpenAPI 3.1 document (one `POST /v1/<domain>/<operation>`
 *     path per operation, requestBody from the input schema, `200` response from
 *     the resolved output schema). Prints the spec as a LAFS envelope, or writes
 *     it to `--out` and emits a summary envelope.
 *
 * This is the projection source for the generated SDK client (T11920) — the
 * spec is derived from the registry, NOT hand-authored, so it never drifts.
 *
 * @task T11918 — M5/AC2: zod→OpenAPI 3.1 bridge + `cleo gateway openapi`
 * @epic T11769 — E-API-STANDARD-FOUNDATION
 */

import { resolve } from 'node:path';
import { generateOpenApi, getProjectRoot } from '@cleocode/core';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo gateway openapi [--out <file>]` — emit the OpenAPI 3.1 spec.
 *
 * With no `--out`, the full spec is the envelope `data`. With `--out`, the spec
 * is written to disk (path resolved against the project root for relative
 * targets) and the envelope `data` is a summary `{ out, pathCount, version }`.
 *
 * @task T11918 — AC3
 */
export const gatewayOpenapiSubCommand = defineCommand({
  meta: {
    name: 'openapi',
    description: 'Emit the OpenAPI 3.1 spec projected from the OPERATIONS registry',
  },
  args: {
    out: {
      type: 'string',
      description: 'Write the spec to this file (JSON). When omitted, prints the spec.',
      alias: 'o',
    },
    version: {
      type: 'string',
      description: "API-surface version stamped into info.version (default '1.0.0')",
    },
  },
  async run({ args }) {
    const doc = generateOpenApi(
      typeof args.version === 'string' && args.version.length > 0
        ? { version: args.version }
        : undefined,
    );
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    const pathCount = Object.keys(doc.paths).length;

    if (typeof args.out === 'string' && args.out.length > 0) {
      const { writeFileSync } = await import('node:fs');
      const target = resolve(getProjectRoot(), args.out);
      writeFileSync(target, json, 'utf8');
      cliOutput(
        { out: target, pathCount, version: doc.info.version, openapi: doc.openapi },
        { command: 'gateway', operation: 'gateway.openapi' },
      );
      return;
    }

    cliOutput(doc, { command: 'gateway', operation: 'gateway.openapi' });
  },
});

/**
 * `cleo gateway` — parent command grouping the gateway introspection subverbs.
 *
 * @task T11918
 */
export const gatewayCommand = defineCommand({
  meta: {
    name: 'gateway',
    description: 'REST gateway introspection (openapi spec projection)',
  },
  subCommands: {
    openapi: gatewayOpenapiSubCommand,
  },
});
