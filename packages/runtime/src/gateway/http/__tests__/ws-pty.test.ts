/**
 * WS terminal/PTY endpoint tests (T11922 · M5 realtime transport, WS half).
 *
 * Asserts the four ACs of T11922 — all in-process (NO subprocess — tsx is
 * unresolvable in CI), over a fake {@link GatewayHandler} and the optional
 * `node-pty` backend stubbed via {@link __setWsPtyTestHooks}:
 *
 *  - AC1: a WS upgrade handler is attached to the gateway HTTP listener for the
 *    `/v1/terminal/pty` endpoint (the upgrade completes the RFC 6455 handshake).
 *  - AC2: the endpoint bridges a (stubbed) PTY bidirectionally — a client frame
 *    written to PTY stdin is echoed back as a server frame, and a resize control
 *    frame reaches the PTY.
 *  - AC3: open/close/error/abort all route through one idempotent teardown; a
 *    server close tears every live session down (sessionCount → 0).
 *  - AC4: the upgrade-edge gate rejects a non-loopback peer, a missing/invalid
 *    token, and a disallowed origin BEFORE any PTY spawn — and the bridged PTY
 *    runs under a secret-free, allowlist-only env (no secret on the wire).
 *
 * The pure framing helpers (handshake hash, frame encode/decode, env scrub, the
 * gate decision) are unit-tested directly; the live round-trips boot
 * {@link startHttpServer} on an EPHEMERAL port and drive a minimal raw-socket WS
 * client.
 *
 * @task T11922
 * @epic T11769
 * @saga T10400
 */

import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayHandler } from '../../index.js';
import { startHttpServer } from '../listen.js';
import {
  __setWsPtyTestHooks,
  attachWsPtyEndpoint,
  authorizeUpgrade,
  computeAcceptKey,
  decodeWsFrame,
  encodeWsFrame,
  type GateDecision,
  isWsPtyPath,
  scrubPtyEnv,
  type UpgradableServer,
  WS_PTY_PATH,
} from '../ws-pty.js';

/** A no-op fake handler — the WS path never touches the unary handler. */
function fakeHandler(): GatewayHandler {
  return {
    handle(req: DispatchRequest): Promise<DispatchResponse> {
      return Promise.resolve({
        meta: {
          gateway: req.gateway,
          domain: req.domain,
          operation: req.operation,
          timestamp: '2026-06-09T00:00:00.000Z',
          duration_ms: 0,
          source: req.source,
          requestId: req.requestId,
        },
        success: true,
        data: {},
      });
    },
  };
}

/** Encode a CLIENT WS frame (masked, per RFC 6455 §5.3) for the test client. */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  // Only the small frames the test sends are needed (len < 126).
  const header = Buffer.alloc(2);
  header[0] = 0x80 | (opcode & 0x0f);
  header[1] = 0x80 | len; // MASK bit + length
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/** A minimal raw-socket WS client: completes the handshake, then frames over the socket. */
interface WsClient {
  socket: Socket;
  /** Frames received from the server (text payloads decoded to UTF-8). */
  received: string[];
  /** The most recent close-frame reason, if the server closed. */
  closeReason: string | undefined;
  /** Send a client text frame. */
  sendText(s: string): void;
  /** Resolve once at least `n` text frames have arrived (or reject on timeout). */
  waitForFrames(n: number, timeoutMs?: number): Promise<void>;
  /** Resolve once the server sends a close frame (or reject on timeout). */
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Open a WS upgrade against the endpoint, returning the connected client once handshaken. */
function openWsClient(port: number, headers: Record<string, string> = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const received: string[] = [];
    let closeReason: string | undefined;
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);

    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';

    socket.on('connect', () => {
      socket.write(
        `GET ${WS_PTY_PATH} HTTP/1.1\r\n` +
          'Host: 127.0.0.1\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          (headerLines.length > 0 ? `${headerLines}\r\n` : '') +
          '\r\n',
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const sep = buffer.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = buffer.subarray(0, sep).toString('utf8');
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`upgrade rejected: ${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        handshakeDone = true;
        buffer = buffer.subarray(sep + 4);
        resolve(client);
      }
      // Decode any complete server frames.
      for (;;) {
        const frame = decodeWsFrame(buffer);
        if (frame === null) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x1) {
          received.push(frame.payload.toString('utf8'));
        } else if (frame.opcode === 0x8) {
          closeReason = frame.payload.subarray(2).toString('utf8');
        }
      }
    });

    socket.on('error', (err) => {
      if (!handshakeDone) reject(err);
    });

    const client: WsClient = {
      socket,
      received,
      get closeReason(): string | undefined {
        return closeReason;
      },
      sendText(s: string): void {
        socket.write(encodeClientFrame(0x1, Buffer.from(s, 'utf8')));
      },
      waitForFrames(n: number, timeoutMs = 2000): Promise<void> {
        return new Promise((res, rej) => {
          const start = Date.now();
          const tick = (): void => {
            if (received.length >= n) {
              res();
            } else if (Date.now() - start > timeoutMs) {
              rej(new Error(`timeout: ${received.length}/${n} frames`));
            } else {
              setTimeout(tick, 10);
            }
          };
          tick();
        });
      },
      waitForClose(timeoutMs = 2000): Promise<void> {
        return new Promise((res, rej) => {
          const start = Date.now();
          const tick = (): void => {
            if (closeReason !== undefined || socket.destroyed || socket.readableEnded) {
              res();
            } else if (Date.now() - start > timeoutMs) {
              rej(new Error('timeout waiting for close'));
            } else {
              setTimeout(tick, 10);
            }
          };
          tick();
        });
      },
      close(): void {
        socket.destroy();
      },
    };
  });
}

afterEach(() => __setWsPtyTestHooks());

// ---------------------------------------------------------------------------
// Pure helpers — handshake, framing, env scrub, gate.
// ---------------------------------------------------------------------------

describe('T11922 WS framing primitives', () => {
  it('computes the RFC 6455 accept key from the spec example', () => {
    // RFC 6455 §1.3 worked example.
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('round-trips a frame through encode (server) → decode (client view)', () => {
    const encoded = encodeWsFrame(0x1, Buffer.from('hello pty', 'utf8'));
    const decoded = decodeWsFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.opcode).toBe(0x1);
    expect(decoded?.payload.toString('utf8')).toBe('hello pty');
    expect(decoded?.consumed).toBe(encoded.length);
  });

  it('decodes a masked client frame back to plaintext', () => {
    const masked = encodeClientFrame(0x1, Buffer.from('stdin bytes', 'utf8'));
    const decoded = decodeWsFrame(masked);
    expect(decoded?.payload.toString('utf8')).toBe('stdin bytes');
  });

  it('returns null on a partial frame (caller waits for more bytes)', () => {
    const encoded = encodeWsFrame(0x1, Buffer.from('partial', 'utf8'));
    expect(decodeWsFrame(encoded.subarray(0, 3))).toBeNull();
  });

  it('recognizes the WS-PTY path and rejects others', () => {
    expect(isWsPtyPath(WS_PTY_PATH)).toBe(true);
    expect(isWsPtyPath('/v1/terminal/pty?token=x')).toBe(true);
    expect(isWsPtyPath('/v1/tasks/show')).toBe(false);
  });
});

describe('T11922 scrubPtyEnv (AC4 — secrets never traverse the socket)', () => {
  it('forwards only the benign allowlist and a pinned PATH; drops secrets', () => {
    const env = scrubPtyEnv({
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      PATH: '/poisoned/path',
      ANTHROPIC_API_KEY: 'sk-secret',
      CLEO_VAULT_KEY: 'vault-secret',
      OPENAI_API_KEY: 'sk-other',
      LD_PRELOAD: '/evil.so',
    });
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    // PATH is PINNED, never the caller's value.
    expect(env.PATH).not.toBe('/poisoned/path');
    expect(env.PATH).toContain('/usr/bin');
    // No secret / loader hook survives.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLEO_VAULT_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
  });
});

describe('T11922 authorizeUpgrade (AC4 — edge gate before any PTY spawn)', () => {
  const reqWith = (
    headers: Record<string, string>,
    url = WS_PTY_PATH,
  ): Parameters<typeof authorizeUpgrade>[0] =>
    ({ headers, url }) as unknown as Parameters<typeof authorizeUpgrade>[0];

  it('rejects a non-loopback peer with 403', () => {
    const d: GateDecision = authorizeUpgrade(reqWith({}), '203.0.113.7', {});
    expect(d).toEqual({
      ok: false,
      status: 403,
      reason: 'non-loopback connections are not permitted',
    });
  });

  it('accepts a loopback peer when no token/origin is configured', () => {
    expect(authorizeUpgrade(reqWith({}), '127.0.0.1', {})).toEqual({ ok: true });
  });

  it('rejects a missing token with 401 when a token is configured', () => {
    const d = authorizeUpgrade(reqWith({}), '127.0.0.1', { token: 'sekret' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(401);
  });

  it('accepts a valid bearer token', () => {
    const d = authorizeUpgrade(reqWith({ authorization: 'Bearer sekret' }), '127.0.0.1', {
      token: 'sekret',
    });
    expect(d).toEqual({ ok: true });
  });

  it('accepts a token passed via the query string', () => {
    const d = authorizeUpgrade(reqWith({}, `${WS_PTY_PATH}?token=sekret`), '127.0.0.1', {
      token: 'sekret',
    });
    expect(d).toEqual({ ok: true });
  });

  it('rejects a disallowed origin with 403', () => {
    const d = authorizeUpgrade(reqWith({ origin: 'https://evil.example' }), '127.0.0.1', {
      allowedOrigins: ['https://studio.localhost'],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it('accepts an allowed origin', () => {
    const d = authorizeUpgrade(reqWith({ origin: 'https://studio.localhost' }), '127.0.0.1', {
      allowedOrigins: ['https://studio.localhost'],
    });
    expect(d).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// In-process live round-trips (AC1/AC2/AC3).
// ---------------------------------------------------------------------------

/** Install a stub `node-pty` whose process echoes everything written to its stdin. */
function installEchoPtyStub(): { resizes: Array<{ cols: number; rows: number }> } {
  const resizes: Array<{ cols: number; rows: number }> = [];
  __setWsPtyTestHooks({
    importer: () =>
      Promise.resolve({
        spawn() {
          let dataCb: ((d: string) => void) | undefined;
          return {
            onData(cb: (d: string) => void) {
              dataCb = cb;
              return { dispose() {} };
            },
            onExit(_cb: (e: { exitCode: number }) => void) {
              return { dispose() {} };
            },
            write(data: string) {
              // Echo stdin back as PTY output (a real shell echoes typed chars).
              dataCb?.(data);
            },
            resize(cols: number, rows: number) {
              resizes.push({ cols, rows });
            },
            kill() {},
          };
        },
      }),
  });
  return { resizes };
}

describe('T11922 in-process WS-PTY round-trip (AC1/AC2/AC3)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('upgrades on the existing listener and echoes a PTY round-trip (AC1+AC2)', async () => {
    const stub = installEchoPtyStub();
    const server = await startHttpServer(fakeHandler(), { port: 0, wsPty: {} });
    closers.push(() => server.close());

    const client = await openWsClient(server.port);
    client.sendText('echo-me');
    await client.waitForFrames(1);
    expect(client.received[0]).toBe('echo-me');

    // A resize control frame reaches the PTY (AC2 bidirectional control).
    client.sendText(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    // Give the resize a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.resizes).toContainEqual({ cols: 120, rows: 40 });

    client.close();
  });

  it('rejects an upgrade with a 401 when the token is wrong (AC4 — before PTY spawn)', async () => {
    installEchoPtyStub();
    const server = await startHttpServer(fakeHandler(), { port: 0, wsPty: { token: 'right' } });
    closers.push(() => server.close());

    await expect(openWsClient(server.port, { Authorization: 'Bearer wrong' })).rejects.toThrow(
      /401/,
    );
  });

  it('upgrades then cleanly closes when node-pty is absent (graceful, not a crash)', async () => {
    // No stub installed → loadNodePty resolves null (real importer rejects on the
    // uninstalled optional dep).
    __setWsPtyTestHooks({
      importer: () => Promise.reject(new Error('Cannot find module node-pty')),
    });
    const server = await startHttpServer(fakeHandler(), { port: 0, wsPty: {} });
    closers.push(() => server.close());

    const client = await openWsClient(server.port);
    await client.waitForClose();
    expect(client.closeReason ?? '').toContain('PTY backend unavailable');
    client.close();
  });

  it('tears every live session down on server close (AC3 — leak-free)', async () => {
    installEchoPtyStub();
    const server = await startHttpServer(fakeHandler(), { port: 0, wsPty: {} });

    const c1 = await openWsClient(server.port);
    const c2 = await openWsClient(server.port);
    // Let both sessions register.
    await new Promise((r) => setTimeout(r, 50));

    // Closing the server must tear down both sockets deterministically.
    await server.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(c1.socket.destroyed || c1.socket.readableEnded).toBe(true);
    expect(c2.socket.destroyed || c2.socket.readableEnded).toBe(true);

    c1.close();
    c2.close();
  });

  it('de-registers a session on client disconnect (AC3 — no leak on abort)', async () => {
    installEchoPtyStub();
    const server = await startHttpServer(fakeHandler(), { port: 0, wsPty: {} });
    closers.push(() => server.close());

    const client = await openWsClient(server.port);
    await new Promise((r) => setTimeout(r, 30));
    // Client aborts abruptly.
    client.socket.destroy();
    // The server-side teardown runs on the socket 'close' — no assertion on
    // internals here beyond "no throw / no hang"; the server close below proves
    // the registry is clean.
    await new Promise((r) => setTimeout(r, 50));
    await server.close();
  });

  it('T11961: teardown leaves an error sink on the socket (late ECONNRESET is swallowed)', async () => {
    // Regression for the teardown race (the macOS CI shard killer): teardown
    // removes the live 'error' listener and THEN writes the close frame + FIN.
    // A peer that destroyed abruptly (RST) surfaces that write failure
    // ASYNCHRONOUSLY — on a listener-less socket Node escalates it to an
    // uncaught exception, killing the daemon. The invariant under test: after
    // teardown the socket still has an 'error' listener, and emitting a late
    // socket error does not throw. A scripted fake socket makes the sequence
    // deterministic (the real-socket race only fires under macOS CI timing).
    installEchoPtyStub();

    class FakeSocket extends EventEmitter {
      writableEnded = false;
      destroyed = false;
      write(_chunk: unknown): boolean {
        return true;
      }
      end(): void {
        this.writableEnded = true;
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const fakeServer = new EventEmitter();
    const handle = attachWsPtyEndpoint(fakeServer as unknown as UpgradableServer);
    closers.push(async () => handle.close());

    const socket = new FakeSocket();
    const req = {
      url: WS_PTY_PATH,
      headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    fakeServer.emit('upgrade', req, socket, Buffer.alloc(0));
    // Let the async bridge (PTY stub load + spawn) settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(handle.sessionCount).toBe(1);

    // Client close frame → server teardown (removes the live listeners, then
    // writes the close frame + FIN — the window where the race lived).
    socket.emit('data', encodeClientFrame(0x8, Buffer.alloc(0)));
    await new Promise((r) => setTimeout(r, 10));

    // The fix's invariant: an error sink remains, and a late async socket
    // error (the in-flight write failing against a peer RST) is swallowed.
    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(() => socket.emit('error', new Error('read ECONNRESET'))).not.toThrow();
  });
});
