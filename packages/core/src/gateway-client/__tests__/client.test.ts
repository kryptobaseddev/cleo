/**
 * `createCleoClient` SDK-client tests (T11920 · M5 · AC2+AC4+AC5).
 *
 * Asserts the single generated SDK client that every surface (CLI/TUI/Studio)
 * shares:
 *
 *  1. (AC2) The namespaced surface exposes `client.{tasks,session,memory,llm,
 *     nexus,docs,…}` over the registry-projected domains, with method names
 *     derived from the operations (e.g. `tasks.show`, `tasks.add`).
 *  2. (AC4) An in-process HTTP gateway round-trips one QUERY op (`tasks.show`)
 *     and one MUTATE op (`tasks.add`): the client posts to
 *     `/v1/<domain>/<operation>` with the JSON body and parses the LAFS envelope.
 *  3. (AC5) No secret material is embedded in the generated client — the client
 *     carries auth only via caller-supplied headers, and a header passed to
 *     `createCleoClient` is forwarded on the wire.
 *
 * The gateway is a tiny in-process `node:http` server (NO subprocess — tsx is
 * unresolvable in CI; and core cannot depend on `@cleocode/runtime` without a
 * dependency cycle), mimicking the `/v1` facade: it parses
 * `POST /v1/<domain>/<operation>`, reads the JSON body, and echoes a LAFS
 * response envelope. This exercises the generated client end-to-end over a real
 * socket without standing up the full daemon.
 *
 * @task T11920
 * @epic T11769
 * @saga T10400
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CLEO_CLIENT_NAMESPACES, type CleoClient, createCleoClient } from '../index.js';

/** One recorded inbound request the fake gateway saw. */
interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/** A live fake `/v1` gateway + the requests it recorded. */
interface FakeGateway {
  baseUrl: string;
  calls: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * Boot a minimal in-process `/v1` gateway on an ephemeral port. It parses
 * `POST /v1/<domain>/<operation>`, records the request, and echoes a LAFS
 * success envelope whose `data` reflects the routed `(domain, operation)` and
 * the received params — enough to assert the round-trip wired correctly.
 */
function startFakeGateway(): Promise<FakeGateway> {
  const calls: RecordedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });

      const segments = (req.url ?? '').split('/').filter(Boolean); // ['v1', domain, operation]
      const domain = segments[1] ?? '';
      const operation = segments[2] ?? '';

      const envelope = {
        success: true,
        data: { routedDomain: domain, routedOperation: operation, params: body ?? null },
        meta: {
          gateway: 'query',
          domain,
          operation,
          timestamp: '2026-06-09T00:00:00.000Z',
          duration_ms: 1,
          source: 'http',
          requestId: 'req-test',
        },
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    });
  });

  return new Promise<FakeGateway>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('failed to bind ephemeral port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

describe('T11920 createCleoClient — namespaced surface (AC2)', () => {
  it('exposes the registry-projected domains as namespaces', () => {
    const client = createCleoClient({ baseUrl: 'http://127.0.0.1:1' });
    // The AC2-named domains that ARE registered as gateway domains today.
    for (const ns of ['tasks', 'session', 'memory', 'llm', 'nexus', 'docs'] as const) {
      expect(client[ns], `namespace ${ns} missing`).toBeDefined();
      expect(typeof client[ns]).toBe('object');
    }
  });

  it('exposes representative ops as callable methods (tasks.show, tasks.add)', () => {
    const client = createCleoClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(typeof client.tasks.show).toBe('function');
    expect(typeof client.tasks.add).toBe('function');
    expect(typeof client.session.status).toBe('function');
    expect(typeof client.memory.find).toBe('function');
  });

  it('CLEO_CLIENT_NAMESPACES lists every namespace and is sorted', () => {
    expect(CLEO_CLIENT_NAMESPACES).toContain('tasks');
    expect(CLEO_CLIENT_NAMESPACES).toContain('docs');
    expect([...CLEO_CLIENT_NAMESPACES]).toEqual([...CLEO_CLIENT_NAMESPACES].sort());
    // 24 canonical gateway domains in the projected registry.
    expect(CLEO_CLIENT_NAMESPACES.length).toBeGreaterThanOrEqual(20);
  });
});

describe('T11920 createCleoClient — in-process round-trip (AC4)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('round-trips a QUERY op (tasks.show) to POST /v1/tasks/show with the JSON body', async () => {
    const gateway = await startFakeGateway();
    closers.push(gateway.close);

    const client: CleoClient = createCleoClient({ baseUrl: gateway.baseUrl });
    const res = await client.tasks.show({ body: { taskId: 'T1' } });

    // The fetch client returns { data, request, response }; `data` IS the full
    // LAFS envelope `{ success, data, meta }` for the operation.
    expect(res.data).toBeDefined();
    const envelope = res.data as {
      success: boolean;
      data: { routedDomain: string; routedOperation: string; params: unknown };
      meta: { domain: string; operation: string };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.meta.domain).toBe('tasks');
    expect(envelope.meta.operation).toBe('show');
    expect(envelope.data.routedDomain).toBe('tasks');
    expect(envelope.data.routedOperation).toBe('show');
    expect(envelope.data.params).toEqual({ taskId: 'T1' });

    const call = gateway.calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/tasks/show');
    expect(call?.body).toEqual({ taskId: 'T1' });
  });

  it('round-trips a MUTATE op (tasks.add) to POST /v1/tasks/add with the JSON body', async () => {
    const gateway = await startFakeGateway();
    closers.push(gateway.close);

    const client = createCleoClient({ baseUrl: gateway.baseUrl });
    const res = await client.tasks.add({ body: { title: 'New task', acceptance: ['ac'] } });

    const envelope = res.data as {
      data: { routedDomain: string; routedOperation: string };
    };
    expect(envelope.data.routedDomain).toBe('tasks');
    expect(envelope.data.routedOperation).toBe('add');

    const call = gateway.calls.at(-1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/tasks/add');
    expect(call?.body).toEqual({ title: 'New task', acceptance: ['ac'] });
  });

  it('two clients pointed at different baseUrls do not share routing state', async () => {
    const gatewayA = await startFakeGateway();
    const gatewayB = await startFakeGateway();
    closers.push(gatewayA.close, gatewayB.close);

    const clientA = createCleoClient({ baseUrl: gatewayA.baseUrl });
    const clientB = createCleoClient({ baseUrl: gatewayB.baseUrl });

    await clientA.tasks.show({ body: { taskId: 'A' } });
    await clientB.tasks.show({ body: { taskId: 'B' } });

    expect(gatewayA.calls).toHaveLength(1);
    expect(gatewayB.calls).toHaveLength(1);
    expect(gatewayA.calls[0]?.body).toEqual({ taskId: 'A' });
    expect(gatewayB.calls[0]?.body).toEqual({ taskId: 'B' });
  });
});

describe('T11920 createCleoClient — auth + secrets (AC5)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('forwards caller-supplied headers (auth carried at call time, not embedded)', async () => {
    const gateway = await startFakeGateway();
    closers.push(gateway.close);

    const client = createCleoClient({
      baseUrl: gateway.baseUrl,
      headers: { authorization: 'Bearer test-token' },
    });
    await client.tasks.show({ body: { taskId: 'T1' } });

    const call = gateway.calls.at(-1);
    expect(call?.headers.authorization).toBe('Bearer test-token');
  });

  it('embeds no secret material in the generated client source', async () => {
    // Sanity scan: the generated SDK + namespace map must carry no literal
    // credentials. (Structural projection only — AC5.)
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const genDir = join(here, '..', 'generated');
    const files = ['sdk.gen.ts', 'namespaces.gen.ts', 'client.gen.ts'];
    const secretPattern =
      /sk-ant-|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
    for (const f of files) {
      const text = readFileSync(join(genDir, f), 'utf8');
      expect(secretPattern.test(text), `${f} contains secret-like material`).toBe(false);
    }
  });
});
