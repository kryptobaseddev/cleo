/**
 * Gateway-as-daemon-subsystem tests (R3-T7 · T11451).
 *
 * Asserts the gateway is expressible as a supervised {@link Subsystem} that the
 * R2 `SubsystemRegistry` drives end-to-end:
 *  1. `defineGatewaySubsystem` produces a frozen, registrable subsystem named
 *     per-scope (`gateway-<scope>`).
 *  2. Registered + started, it binds the configured transports (RPC unix socket
 *     + HTTP server) and a real client can dispatch through each.
 *  3. `aggregateHealth()` reports the gateway as a `running` row that projects
 *     onto the FROZEN supervisor `MonitorResponse`.
 *  4. `shutdownAll()` closes every bound listener (socket file removed, port
 *     freed).
 *  5. Two scopes register as two distinct, non-colliding subsystems → one
 *     external-facing process surface per scope.
 *  6. A config with no transport is rejected; a mid-start bind failure rolls
 *     back the already-bound listener (no half-open socket).
 *
 * @task T11451
 * @epic T11254
 * @saga T11243
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DispatchRequest,
  type DispatchResponse,
  MonitorResponseSchema,
  toMonitorChildren,
} from '@cleocode/contracts';
import { GATEWAY_RPC_PROTOCOL_VERSION } from '@cleocode/contracts/gateway/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { SubsystemRegistry } from '../../daemon/index.js';
import { defineGatewaySubsystem, gatewaySubsystemName } from '../daemon-subsystem.js';
import type { GatewayHandler } from '../index.js';

/** A success-echoing gateway handler that records every request it routed. */
function fakeHandler(): { handler: GatewayHandler; calls: DispatchRequest[] } {
  const calls: DispatchRequest[] = [];
  const handler: GatewayHandler = {
    handle(req: DispatchRequest): Promise<DispatchResponse> {
      calls.push(req);
      return Promise.resolve({
        meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: '2026-05-31T00:00:00.000Z',
          duration_ms: 1,
          source: req.source,
          requestId: req.requestId,
        },
        success: true,
        data: { ok: true },
      });
    },
  };
  return { handler, calls };
}

/** Unique socket path under the OS tmpdir for an isolated test run. */
function tmpSocket(): string {
  return join(tmpdir(), `cleo-gw-${randomUUID()}.sock`);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn().catch(() => undefined);
  }
});

describe('defineGatewaySubsystem (R3-T7 · T11451)', () => {
  it('produces a frozen, registrable subsystem named per-scope', () => {
    const { handler } = fakeHandler();
    const sub = defineGatewaySubsystem({
      scope: 'project',
      handler,
      rpc: { socketPath: tmpSocket() },
    });
    expect(sub.name).toBe('gateway-project');
    expect(gatewaySubsystemName('global')).toBe('gateway-global');
    expect(Object.isFrozen(sub)).toBe(true);
  });

  it('rejects a config with no transport configured', () => {
    const { handler } = fakeHandler();
    expect(() => defineGatewaySubsystem({ scope: 'project', handler })).toThrow(TypeError);
  });
});

describe('gateway subsystem lifecycle through the daemon registry (AC1)', () => {
  it('starts, hosts RPC + HTTP, reports running health, then shuts down', async () => {
    const { handler, calls } = fakeHandler();
    const socketPath = tmpSocket();
    const registry = new SubsystemRegistry();
    registry.register(
      defineGatewaySubsystem({
        scope: 'project',
        handler,
        rpc: { socketPath },
        http: { port: 0 }, // ephemeral port
      }),
    );

    await registry.startAll();
    cleanups.push(() => registry.shutdownAll());

    // The RPC unix socket is bound and a client can dispatch through it.
    expect(existsSync(socketPath)).toBe(true);
    const rpcResponse = await rpcRoundTrip(socketPath);
    expect(rpcResponse.direction).toBe('response');
    expect(calls.some((c) => c.source === 'rpc')).toBe(true);

    // Health: the gateway reports a single running row that projects onto the
    // FROZEN supervisor MonitorResponse (AC: lifecycle/health integration).
    const health = await registry.aggregateHealth();
    expect(health.subsystems).toHaveLength(1);
    expect(health.allHealthy).toBe(true);
    const row = health.subsystems[0];
    expect(row.child_id).toBe('gateway-project');
    expect(row.state).toBe('running');
    expect(row.detail).toContain('rpc=');
    expect(row.detail).toContain('http=');
    const monitor = MonitorResponseSchema.safeParse({
      kind: 'monitor',
      children: toMonitorChildren(health),
    });
    expect(monitor.success).toBe(true);

    // Shutdown closes the RPC listener — the stale socket node is removed.
    await registry.shutdownAll();
    cleanups.length = 0;
    expect(existsSync(socketPath)).toBe(false);
  });

  it('hosts the HTTP transport and routes POST /<gateway>/<domain>/<op> (AC: external clients)', async () => {
    const { handler, calls } = fakeHandler();
    const registry = new SubsystemRegistry();
    const sub = defineGatewaySubsystem({ scope: 'global', handler, http: { port: 0 } });
    registry.register(sub);

    const started = await sub.start();
    cleanups.push(() => sub.shutdown(started));
    const port = started.http?.port;
    expect(typeof port).toBe('number');

    const body = await httpRoundTrip(port as number, '/query/tasks/show', { id: 'T1' });
    expect(body.success).toBe(true);
    const httpCall = calls.find((c) => c.source === 'http');
    expect(httpCall?.domain).toBe('tasks');
    expect(httpCall?.operation).toBe('show');
    expect(httpCall?.params).toEqual({ id: 'T1' });
  });
});

describe('one external-facing process per scope (AC1)', () => {
  it('registers project + global as two distinct, non-colliding subsystems', async () => {
    const { handler } = fakeHandler();
    const registry = new SubsystemRegistry();
    registry.register(
      defineGatewaySubsystem({ scope: 'project', handler, rpc: { socketPath: tmpSocket() } }),
    );
    registry.register(
      defineGatewaySubsystem({ scope: 'global', handler, rpc: { socketPath: tmpSocket() } }),
    );
    expect(registry.names).toEqual(['gateway-project', 'gateway-global']);

    await registry.startAll();
    cleanups.push(() => registry.shutdownAll());
    const health = await registry.aggregateHealth();
    expect(health.subsystems.map((r) => r.child_id)).toEqual(['gateway-project', 'gateway-global']);
    expect(health.allHealthy).toBe(true);
  });
});

describe('mid-start rollback (no half-open listener)', () => {
  it('closes the already-bound RPC socket when the HTTP bind fails', async () => {
    const { handler } = fakeHandler();
    const socketPath = tmpSocket();
    // Bind a port, then ask the gateway to bind the SAME port for HTTP → EADDRINUSE.
    const occupied = await occupyPort();
    cleanups.push(() => occupied.close());

    const sub = defineGatewaySubsystem({
      scope: 'project',
      handler,
      rpc: { socketPath },
      http: { port: occupied.port, host: '127.0.0.1' },
    });

    await expect(sub.start()).rejects.toBeDefined();
    // The RPC socket bound first must have been rolled back — no half-open node.
    expect(existsSync(socketPath)).toBe(false);
  });
});

// ───────────────────────── test wire helpers ─────────────────────────

/** Open the RPC socket, send one request frame, resolve the first reply frame. */
function rpcRoundTrip(socketPath: string): Promise<{ direction: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      const frame = {
        protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
        id: 'f1',
        direction: 'request' as const,
        request: {
          gateway: 'query',
          domain: 'tasks',
          operation: 'show',
          params: { id: 'T1' },
          source: 'rpc',
          requestId: 'r1',
        },
      };
      sock.write(`${JSON.stringify(frame)}\n`);
    });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        sock.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    });
    sock.on('error', reject);
  });
}

/** POST a JSON body to the HTTP gateway and resolve the parsed LAFS envelope. */
function httpRoundTrip(
  port: number,
  path: string,
  payload: Record<string, unknown>,
): Promise<DispatchResponse> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Bind an ephemeral TCP port and return it + an idempotent closer. */
function occupyPort(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
