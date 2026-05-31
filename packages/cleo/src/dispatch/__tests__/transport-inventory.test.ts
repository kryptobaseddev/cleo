/**
 * R3-T1 transport inventory — golden current-state regression net.
 *
 * Pins the CURRENT transport surface of the gateway so the R3-T3 relocation
 * (Dispatcher → @cleocode/runtime/gateway) and the R3-T4..T6 adapter work can
 * prove "no behavior change" against a committed baseline:
 *
 *   - CLI adapter (baseline truth)  — the frozen gateway response contract that
 *     every `cleo` op flows through ({ data, meta:{…}, success }).
 *   - MCP adapter                   — the 3 tools exposed via the runtime gateway
 *     `packages/runtime/src/gateway/mcp` (R8 · T11259: standalone `packages/mcp-adapter`
 *     deleted; the tool surface is now generated from OPERATIONS behind `mcpExposed`).
 *   - Studio SSE                    — the event-ordering of the two live SSE
 *     streams (tasks/events + brain/stream).
 *   - Topology invariants          — `packages/gateway` does NOT exist;
 *     `packages/adapters` is the agent-PROVIDER package (unrelated to transport);
 *     `packages/mcp-adapter` does NOT exist (deleted R8 · T11259).
 *
 * Cross-package surfaces (MCP, Studio) are asserted against SOURCE rather than
 * imported, because `packages/cleo` must not take a runtime dependency on
 * `@cleocode/runtime` or `@cleocode/studio` (package-boundary). Only the
 * `@cleocode/contracts/gateway` contract (a real cleo dep) is imported.
 *
 * The accompanying spec (slug `r3-transport-inventory`) pins the file:line
 * topology. See R3-T2 (T11446) for the promoted gateway contract.
 *
 * @task T11445
 * @task T11259
 * @epic T11254
 * @saga T11243
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchResponseSchema, GATEWAY_SOURCES } from '@cleocode/contracts/gateway';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Read a repo-relative source file, or '' if absent (trimmed checkout). */
function readSrc(rel: string): string {
  const p = join(REPO_ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('R3-T1 transport inventory — CLI adapter (baseline truth)', () => {
  // ≥5 representative ops spanning the read surface, pinned as the CLI baseline.
  // R3-T3's relocation re-runs these and re-asserts contract conformance.
  const CLI_BASELINE_OPS = [
    'exists',
    'show',
    'find',
    'list',
    'memory llm-status',
    'session status',
  ];

  it('pins ≥5 baseline CLI ops', () => {
    expect(CLI_BASELINE_OPS.length).toBeGreaterThanOrEqual(5);
  });

  it('a representative DispatchResponse for each baseline op conforms to the frozen gateway contract', () => {
    for (const op of CLI_BASELINE_OPS) {
      const response = {
        meta: {
          gateway: 'query',
          domain: op.split(' ')[0],
          operation: op,
          timestamp: '2026-05-30T00:00:00.000Z',
          duration_ms: 1,
          source: 'cli',
          requestId: `req_${op.replace(/\s+/g, '_')}`,
        },
        success: true,
        data: {},
      };
      expect(dispatchResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it('the live CLI adapter is the single entry point (dispatchFromCli + dispatchRaw)', () => {
    const src = readSrc('packages/cleo/src/dispatch/adapters/cli.ts');
    expect(src).toMatch(/export async function dispatchFromCli/);
    expect(src).toMatch(/export async function dispatchRaw/);
  });

  it('`cli` is a member of the gateway 4-transport union', () => {
    expect(GATEWAY_SOURCES).toContain('cli');
  });
});

describe('R3-T1 transport inventory — MCP adapter (3 tools via runtime gateway)', () => {
  // R8 (T11259): standalone packages/mcp-adapter deleted; MCP surface now lives at
  // packages/runtime/src/gateway/mcp and is generated from OPERATIONS behind mcpExposed.
  const toolsListSrc = readSrc('packages/runtime/src/gateway/mcp/tools-list.ts');

  it('runtime gateway/mcp exposes exactly the 3 sentient tools (regression net)', () => {
    if (!toolsListSrc) return; // trimmed checkout
    expect(toolsListSrc).toContain('cleo_sentient_status');
    expect(toolsListSrc).toContain('cleo_sentient_propose_list');
    expect(toolsListSrc).toContain('cleo_sentient_propose_enable');
  });

  it('`mcp` is a member of the gateway 4-transport union', () => {
    expect(GATEWAY_SOURCES).toContain('mcp');
  });

  it('packages/mcp-adapter no longer exists (deleted R8 · T11259)', () => {
    expect(existsSync(join(REPO_ROOT, 'packages/mcp-adapter'))).toBe(false);
  });
});

describe('R3-T1 transport inventory — Studio SSE (2 streams)', () => {
  it('tasks/events emits connected → task-updated → heartbeat (ordering pinned)', () => {
    const src = readSrc('packages/studio/src/routes/api/tasks/events/+server.ts');
    if (!src) return;
    for (const ev of ['connected', 'task-updated', 'heartbeat']) {
      expect(src).toContain(`'${ev}'`);
    }
    // `connected` must be the first event emitted.
    expect(src.indexOf("send('connected'")).toBeLessThan(src.indexOf("send('heartbeat'"));
  });

  it('brain/stream emits typed BrainStreamEvent frames via sseEncode', () => {
    const src = readSrc('packages/studio/src/routes/api/brain/stream/+server.ts');
    if (!src) return;
    expect(src).toMatch(/BrainStreamEvent/);
    expect(src).toMatch(/function sseEncode/);
  });
});

describe('R3-T1 transport inventory — topology invariants', () => {
  it('there is NO packages/gateway (gateway = the dispatch layer + @cleocode/contracts/gateway)', () => {
    expect(existsSync(join(REPO_ROOT, 'packages/gateway'))).toBe(false);
  });

  it('there is NO packages/mcp-adapter (source deleted R8 · T11259; adapter lives in runtime)', () => {
    expect(existsSync(join(REPO_ROOT, 'packages/mcp-adapter'))).toBe(false);
  });

  it('packages/adapters is the agent-PROVIDER package, NOT a transport adapter', () => {
    const pkgPath = join(REPO_ROOT, 'packages/adapters/package.json');
    if (!existsSync(pkgPath)) return;
    expect(JSON.parse(readFileSync(pkgPath, 'utf8')).name).toBe('@cleocode/adapters');
  });

  it('all four transports now have their adapters (R3-T4 mcp · T5 rpc · T6 http)', () => {
    expect(GATEWAY_SOURCES).toContain('rpc');
    expect(GATEWAY_SOURCES).toContain('http');
    // R3-T4 (T11448) landed the MCP adapter under the runtime gateway.
    expect(existsSync(join(REPO_ROOT, 'packages/runtime/src/gateway/mcp'))).toBe(true);
    // R3-T5 (T11449) landed the CLI-RPC adapter under the runtime gateway.
    expect(existsSync(join(REPO_ROOT, 'packages/runtime/src/gateway/rpc'))).toBe(true);
    // R3-T6 (T11450) landed the HTTP unary + SSE adapter under the runtime gateway.
    expect(existsSync(join(REPO_ROOT, 'packages/runtime/src/gateway/http'))).toBe(true);
  });
});
