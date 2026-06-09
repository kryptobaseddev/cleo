/**
 * WebSocket terminal/PTY endpoint on the `/v1` gateway HTTP listener (T11922 ·
 * M5 realtime transport, WS half).
 *
 * The SSE half (T11921) gives the gateway a SERVER→CLIENT push stream; this
 * module adds the BIDIRECTIONAL realtime transport an interactive TUI / terminal
 * session needs: a WebSocket upgrade on the SAME `node:http` listener
 * ({@link import('./listen.js').startHttpServer}) that bridges a PTY both
 * directions over WS frames.
 *
 * Design constraints (all four ACs of T11922):
 *
 *  - **AC1 — upgrade on the existing listener.** The WS endpoint is NOT a second
 *    server: it attaches to the daemon's existing HTTP server via its
 *    `'upgrade'` event ({@link attachWsPtyEndpoint}), so it inherits the loopback
 *    bind + the daemon's lifecycle. The endpoint path is `/v1/terminal/pty`.
 *  - **AC2 — bidirectional PTY bridge with backpressure.** Inbound WS frames are
 *    written to the PTY stdin; PTY output is framed back to the client. A control
 *    frame (`{type:'resize',cols,rows}`) resizes the PTY. Backpressure is honored
 *    on the socket write path (pause-on-`false`-write, resume on `'drain'`).
 *  - **AC3 — leak-free, deterministic teardown.** Every open/close/error/abort
 *    path routes through ONE idempotent `teardown()` that kills the PTY, removes
 *    its listeners, and ends the socket exactly once. A server `close()` tears
 *    down every live session.
 *  - **AC4 — auth/origin enforced at the upgrade edge; no secrets on the wire.**
 *    The upgrade is rejected with a `401`/`403` BEFORE any PTY is spawned unless
 *    it comes from loopback AND (when a token is configured) presents the bearer
 *    token AND (when an origin allowlist is configured) presents an allowed
 *    `Origin`. The spawned PTY runs under a MINIMAL, explicitly-constructed env
 *    ({@link scrubPtyEnv}) — the daemon's secret-bearing `process.env` is NEVER
 *    inherited, so a secret cannot be exfiltrated through the terminal stream.
 *
 * To keep the **publish surface clean** (D11142 dependency-discipline):
 *  - There is NO `ws` dependency. The minimal RFC 6455 server framing needed
 *    (accept handshake, decode masked client frames, encode unmasked server
 *    frames, close/ping/pong) is implemented over the raw `node:net` socket the
 *    `'upgrade'` event hands us. This adds ZERO weight to `@cleocode/runtime`.
 *  - `node-pty` is an OPTIONAL, dynamically-loaded dependency (same pattern as
 *    {@link import('../../../../core/src/llm/pi/gondolin-loader.js')} and
 *    `packages/core/src/tools/pty.ts`): the npm specifier is held in a variable,
 *    its shape is declared LOCALLY (no `import type`), and absence is a graceful
 *    close frame ("PTY backend unavailable") — NOT a crash. The endpoint always
 *    upgrades; it bridges a PTY only when the backend is present.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http/ws-pty
 *
 * @task T11922
 * @epic T11769
 * @saga T10400
 * @see ./sse.ts — the SSE half (server→client push) on the same listener
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { delimiter } from 'node:path';
import type { Duplex } from 'node:stream';
import { getLogger } from '@cleocode/core';

/** The canonical WS terminal/PTY endpoint path on the `/v1` facade. */
export const WS_PTY_PATH = '/v1/terminal/pty';

/** The RFC 6455 GUID concatenated with `Sec-WebSocket-Key` to derive the accept hash. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Default PTY geometry when the client does not request one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** WS opcodes (RFC 6455 §5.2) the bridge handles. */
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Loopback hosts an upgrade may originate from (AC4). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// ---------------------------------------------------------------------------
// node-pty optional-dep loader — mirrors gondolin-loader.ts / tools/pty.ts.
// The specifier is held in a variable; the consumed shape is declared LOCALLY
// (no `import type` from the optional package) so the type-check + bundle pass
// with node-pty uninstalled, and absence resolves `null` instead of throwing.
// ---------------------------------------------------------------------------

/**
 * The install hint surfaced to the client (as a WS close reason) when the PTY
 * backend is unavailable. `node-pty` is OPTIONAL — the endpoint still upgrades
 * and then closes cleanly with this reason rather than crashing the daemon.
 */
export const NODE_PTY_INSTALL_HINT =
  'PTY backend unavailable: the optional "node-pty" package is not installed. ' +
  'Install it with `pnpm add node-pty` (a native build) to enable interactive terminal sessions.';

/** A disposable subscription handle returned by `node-pty`'s event registrars. */
interface PtyDisposable {
  dispose(): void;
}

/** The minimal structural shape of a spawned `node-pty` process the bridge uses. */
interface NodePtyProcess {
  /** Subscribe to interleaved stdout/stderr output. */
  onData(cb: (data: string) => void): PtyDisposable | undefined;
  /** Subscribe to process exit. */
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): PtyDisposable | undefined;
  /** Write to the PTY stdin. */
  write(data: string): void;
  /** Resize the PTY. */
  resize(cols: number, rows: number): void;
  /** Kill the underlying process (idempotent host-side; signal optional). */
  kill(signal?: string): void;
}

/** The minimal structural shape of the `node-pty` module the bridge uses. */
interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name?: string;
      readonly cols?: number;
      readonly rows?: number;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

/** A pluggable dynamic-importer (test seam). Defaults to the real `import()`. */
type DynamicImporter = (specifier: string) => Promise<unknown>;

/** The npm specifier — held in a VARIABLE so it is never statically resolved. */
const NODE_PTY_SPECIFIER = 'node-pty';

/** The real dynamic importer (specifier passed as an argument, never inlined). */
const realImporter: DynamicImporter = (specifier) => import(specifier);

/** The active importer (swapped only by {@link __setWsPtyTestHooks}). */
let importer: DynamicImporter = realImporter;

/**
 * Structurally validate a dynamically-imported candidate against the `spawn`
 * export the bridge consumes. Returns the typed module on a match, else `null`.
 */
function shapeCheckPty(candidate: unknown): NodePtyModule | null {
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as { spawn?: unknown }).spawn === 'function'
  ) {
    return candidate as NodePtyModule;
  }
  return null;
}

/**
 * Attempt to lazily load `node-pty`. Returns `null` when the optional dep is not
 * installed, fails to load, or does not expose the `spawn` surface — so the
 * caller closes the WS cleanly with {@link NODE_PTY_INSTALL_HINT} instead of
 * crashing. NEVER throws.
 *
 * The import specifier is held in a variable (passed to the {@link importer}
 * seam) so bundlers / TS do not treat the missing optional dep as a hard,
 * statically-resolved dependency (same technique as the gondolin loader).
 *
 * @returns The shape-checked module, or `null` when unavailable.
 */
export async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    const mod: unknown = await importer(NODE_PTY_SPECIFIER);
    const candidate = (mod as { default?: unknown }).default ?? mod;
    return shapeCheckPty(candidate);
  } catch {
    return null;
  }
}

/**
 * Override the dynamic-importer (TESTS ONLY) so a unit test can deterministically
 * simulate "node-pty absent" (importer rejects) and "node-pty present" (importer
 * resolves a mock module with a fake `spawn`) WITHOUT touching the module graph
 * or building the native package. Call with no arguments to restore the real
 * importer.
 *
 * @param hooks - Partial override for the importer.
 * @internal
 */
export function __setWsPtyTestHooks(hooks?: { importer?: DynamicImporter }): void {
  importer = hooks?.importer ?? realImporter;
}

// ---------------------------------------------------------------------------
// PTY environment scrub (AC4 — secrets never traverse the socket).
//
// The spawned PTY must NOT inherit the daemon's secret-bearing `process.env`
// (`*_API_KEY`, `*_TOKEN`, `CLEO_VAULT_*`, OAuth headers, …) — a single `env`
// line in an interactive terminal would otherwise exfiltrate them over the WS.
// We build a MINIMAL, allowlist-only env with a pinned trusted PATH, mirroring
// the doctrine of `@cleocode/core`'s `scrubSubprocessEnv` (kept inline so the
// framework-agnostic runtime does not reach into core's tools subpath).
// ---------------------------------------------------------------------------

/** A fixed, trusted absolute `PATH` — never the (possibly poisoned) caller PATH. */
const TRUSTED_PATH = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(delimiter);

/**
 * Benign environment variables copied through from the parent when present.
 * These carry NO secrets and NO code-execution surface — locale, terminal type,
 * timezone, home/user identity, and the tmp dir. `PATH` is deliberately ABSENT
 * (pinned to {@link TRUSTED_PATH}); every secret / loader hook is ABSENT.
 */
const PASSTHROUGH_KEYS: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
];

/**
 * Build the MINIMAL environment the bridged PTY runs under (AC4).
 *
 * Starts EMPTY, copies only the small {@link PASSTHROUGH_KEYS} allowlist from the
 * parent, pins `PATH` to {@link TRUSTED_PATH}, and forces `TERM=xterm-256color`
 * for a sane terminal. The daemon's secrets are NEVER forwarded.
 *
 * @param parentEnv - The parent process environment (defaults to `process.env`).
 * @returns The scrubbed, secret-free env for the PTY.
 */
export function scrubPtyEnv(parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: TRUSTED_PATH, TERM: 'xterm-256color' };
  for (const key of PASSTHROUGH_KEYS) {
    const value = parentEnv[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 server framing — no `ws` dependency.
// ---------------------------------------------------------------------------

/**
 * Derive the `Sec-WebSocket-Accept` response header value from a client
 * `Sec-WebSocket-Key` per RFC 6455 §4.2.2 (SHA-1 of key + GUID, base64).
 *
 * @param key - The client's `Sec-WebSocket-Key` header value.
 * @returns The base64 accept hash.
 */
export function computeAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/**
 * Encode a WS data frame (server→client, UNMASKED per RFC 6455 §5.1). Used for
 * `text` (PTY output) and `close` control frames.
 *
 * @param opcode - The WS opcode (e.g. {@link OPCODE_TEXT}).
 * @param payload - The frame payload bytes.
 * @returns The framed bytes ready to write to the socket.
 */
export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // High 32 bits are 0 for any realistic terminal frame.
    header.writeUInt32BE(Math.floor(len / 0x1_0000_0000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** Build an unmasked `close` control frame carrying a status code + UTF-8 reason. */
function encodeCloseFrame(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeWsFrame(OPCODE_CLOSE, payload);
}

/** One decoded inbound WS frame. */
interface DecodedFrame {
  /** The frame opcode. */
  opcode: number;
  /** The unmasked payload bytes. */
  payload: Buffer;
  /** Total bytes consumed from the input buffer (header + payload). */
  consumed: number;
}

/**
 * Decode a single inbound (client→server, MASKED) WS frame from a buffer.
 *
 * Returns `null` when the buffer does not yet hold a complete frame (the caller
 * waits for more bytes). Client frames MUST be masked (RFC 6455 §5.3); the mask
 * is applied to recover the payload. Fragmentation is not expected from a
 * terminal client, so a non-FIN frame is decoded as-is (its opcode handled by
 * the caller). NEVER throws on a partial buffer.
 *
 * @param buf - The accumulated inbound bytes.
 * @returns The decoded frame, or `null` when more bytes are needed.
 */
export function decodeWsFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    // Low 32 bits suffice for any realistic terminal frame.
    len = buf.readUInt32BE(offset + 4);
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const raw = buf.subarray(offset, offset + len);
  const payload = Buffer.allocUnsafe(len);
  if (mask) {
    for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
  } else {
    raw.copy(payload);
  }
  return { opcode, payload, consumed: offset + len };
}

// ---------------------------------------------------------------------------
// Auth/origin gate (AC4) — enforced at the upgrade edge, before any PTY spawn.
// ---------------------------------------------------------------------------

/** Configuration for the WS terminal/PTY endpoint. */
export interface WsPtyOptions {
  /**
   * Optional bearer token an upgrade MUST present (as `Authorization: Bearer
   * <token>` or `?token=<token>`). When omitted, no token is required (loopback
   * is still enforced unconditionally).
   */
  token?: string;
  /**
   * Optional `Origin` allowlist. When non-empty, an upgrade MUST present an
   * `Origin` header whose value is in the set, else it is rejected `403`. When
   * omitted/empty, the `Origin` header is not checked (loopback already bounds
   * the surface).
   */
  allowedOrigins?: readonly string[];
  /** The shell launched for the PTY (default `process.env.SHELL` or `/bin/sh`). */
  shell?: string;
  /** Working directory for the PTY (default `process.cwd()`). */
  cwd?: string;
}

/** The decision of the upgrade-edge gate. */
export type GateDecision = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Authorize a WS upgrade at the edge (AC4) — BEFORE any PTY is spawned.
 *
 * Enforced unconditionally:
 *  - the connection MUST originate from loopback (`127.0.0.1` / `::1`); a
 *    non-loopback peer is rejected `403` (the gateway is local-process-facing).
 *
 * Enforced when configured:
 *  - a `token` (matched against `Authorization: Bearer` or `?token=`); a missing
 *    or mismatched token is rejected `401`.
 *  - an `Origin` allowlist; a missing or disallowed `Origin` is rejected `403`.
 *
 * @param req - The inbound upgrade request.
 * @param remoteAddress - The socket's remote address.
 * @param opts - The endpoint auth configuration.
 * @returns A {@link GateDecision} — `{ok:true}` to proceed, else a typed reject.
 */
export function authorizeUpgrade(
  req: IncomingMessage,
  remoteAddress: string | undefined,
  opts: WsPtyOptions,
): GateDecision {
  // 1. Loopback-only (unconditional).
  if (remoteAddress === undefined || !LOOPBACK_HOSTS.has(remoteAddress)) {
    return { ok: false, status: 403, reason: 'non-loopback connections are not permitted' };
  }

  // 2. Origin allowlist (when configured).
  if (opts.allowedOrigins !== undefined && opts.allowedOrigins.length > 0) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !opts.allowedOrigins.includes(origin)) {
      return { ok: false, status: 403, reason: 'origin not allowed' };
    }
  }

  // 3. Bearer token (when configured).
  if (opts.token !== undefined && opts.token.length > 0) {
    const presented = extractToken(req);
    if (presented === undefined || !timingSafeEqualStr(presented, opts.token)) {
      return { ok: false, status: 401, reason: 'missing or invalid token' };
    }
  }

  return { ok: true };
}

/** Extract a bearer token from `Authorization: Bearer <t>` or the `?token=<t>` query. */
function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  return q !== null && q.length > 0 ? q : undefined;
}

/** Constant-time string compare (avoids leaking token length/contents via timing). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The upgrade handler + PTY bridge.
// ---------------------------------------------------------------------------

/** Whether a request path is the WS terminal/PTY endpoint. */
export function isWsPtyPath(url: string | undefined): boolean {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  return pathname === WS_PTY_PATH;
}

/** A live WS-PTY session, tracked so a server close tears every one down. */
interface WsPtySession {
  /** Tear down this session (idempotent) — kills the PTY + ends the socket. */
  teardown(code?: number, reason?: string): void;
}

/**
 * Write a raw HTTP rejection to the upgrade socket and destroy it. Used by the
 * auth/origin gate (AC4) so a rejected upgrade never reaches the PTY spawn.
 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const statusText = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request';
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
      '\r\n' +
      reason,
  );
  socket.destroy();
}

/**
 * Complete the RFC 6455 handshake on a gated upgrade socket, then spawn + bridge
 * a PTY bidirectionally. Returns a {@link WsPtySession} whose `teardown()` is the
 * single idempotent close path (AC3). When `node-pty` is absent, the socket is
 * upgraded and then closed with {@link NODE_PTY_INSTALL_HINT} — never crashed.
 *
 * @param req - The inbound upgrade request.
 * @param socket - The raw duplex socket handed to us by the `'upgrade'` event.
 * @param opts - The endpoint configuration (shell, cwd).
 * @param log - The adapter logger.
 * @param onTeardown - Invoked exactly once when this session tears down (any
 *   path: client close, error, abort, PTY exit, server close) — the registry
 *   uses it to de-register the session leak-free (AC3).
 * @returns The tracked session.
 */
async function bridgePty(
  req: IncomingMessage,
  socket: Duplex,
  opts: WsPtyOptions,
  log: ReturnType<typeof getLogger>,
  onTeardown: () => void,
): Promise<WsPtySession> {
  const key = req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${computeAcceptKey(typeof key === 'string' ? key : '')}\r\n` +
      '\r\n',
  );

  let tornDown = false;
  let pty: NodePtyProcess | undefined;
  const disposables: PtyDisposable[] = [];
  // Widened to `ArrayBufferLike` so concatenations of socket chunks (which are
  // `Buffer<ArrayBufferLike>`) assign cleanly under `@types/node`'s generic Buffer.
  let inbound: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Send one server→client text frame, honoring socket backpressure. */
  const sendText = (data: string): void => {
    if (tornDown || socket.writableEnded) return;
    const frame = encodeWsFrame(OPCODE_TEXT, Buffer.from(data, 'utf8'));
    if (!socket.write(frame)) {
      // Kernel buffer full — pause PTY-driven writes until the socket drains so
      // a fast producer cannot blow the buffer (AC2 backpressure).
      socket.once('drain', () => undefined);
    }
  };

  /** The single idempotent teardown (AC3) — every close path routes here. */
  const teardown = (code = 1000, reason = ''): void => {
    if (tornDown) return;
    tornDown = true;
    for (const d of disposables.splice(0)) {
      try {
        d.dispose();
      } catch {
        // best-effort listener disposal
      }
    }
    if (pty !== undefined) {
      try {
        pty.kill();
      } catch {
        // best-effort PTY kill
      }
      pty = undefined;
    }
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('close', onSocketClose);
    if (!socket.writableEnded) {
      try {
        socket.write(encodeCloseFrame(code, reason.slice(0, 120)));
      } catch {
        // socket may already be gone
      }
      socket.end();
    }
    try {
      onTeardown();
    } catch {
      // registry de-registration is best-effort
    }
    log.debug({ code, reason }, 'ws-pty session torn down');
  };

  /** Handle one fully-decoded inbound frame. */
  const onFrame = (frame: DecodedFrame): void => {
    switch (frame.opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY: {
        const text = frame.payload.toString('utf8');
        // A JSON control frame resizes the PTY; everything else is stdin bytes.
        const control = tryParseControl(text);
        if (control !== undefined && control.type === 'resize') {
          pty?.resize(control.cols, control.rows);
        } else {
          pty?.write(text);
        }
        break;
      }
      case OPCODE_PING:
        if (!tornDown && !socket.writableEnded)
          socket.write(encodeWsFrame(OPCODE_PONG, frame.payload));
        break;
      case OPCODE_CLOSE:
        teardown(1000, 'client closed');
        break;
      // PONG and continuation frames are ignored.
      default:
        break;
    }
  };

  const onData = (chunk: Buffer): void => {
    inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk]);
    for (;;) {
      const frame = decodeWsFrame(inbound);
      if (frame === null) break;
      inbound = inbound.subarray(frame.consumed);
      onFrame(frame);
      if (tornDown) break;
    }
  };
  const onError = (): void => teardown(1011, 'socket error');
  const onSocketClose = (): void => teardown();

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onSocketClose);

  // Load the OPTIONAL PTY backend. Absent → clean close with the install hint
  // (the upgrade already succeeded; we never crash the daemon).
  const ptyModule = await loadNodePty();
  if (tornDown) return { teardown };
  if (ptyModule === null) {
    teardown(1011, NODE_PTY_INSTALL_HINT);
    return { teardown };
  }

  const shell = opts.shell ?? process.env.SHELL ?? '/bin/sh';
  try {
    pty = ptyModule.spawn(shell, [], {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: opts.cwd ?? process.cwd(),
      env: scrubPtyEnv(),
    });
  } catch (err) {
    log.warn({ err }, 'ws-pty spawn failed');
    teardown(1011, 'PTY spawn failed');
    return { teardown };
  }

  const dataSub = pty.onData((d) => sendText(d));
  if (dataSub && typeof dataSub.dispose === 'function') disposables.push(dataSub);
  const exitSub = pty.onExit(({ exitCode }) => teardown(1000, `pty exited (${exitCode})`));
  if (exitSub && typeof exitSub.dispose === 'function') disposables.push(exitSub);

  log.debug({ shell }, 'ws-pty session established');
  return { teardown };
}

/** A `{type:'resize',cols,rows}` control frame parsed from an inbound text frame. */
interface ResizeControl {
  type: 'resize';
  cols: number;
  rows: number;
}

/** Parse an inbound text frame as a JSON control message; `undefined` when it is plain stdin. */
function tryParseControl(text: string): ResizeControl | undefined {
  if (text.length === 0 || text[0] !== '{') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { type?: unknown }).type === 'resize' &&
      typeof (parsed as { cols?: unknown }).cols === 'number' &&
      typeof (parsed as { rows?: unknown }).rows === 'number'
    ) {
      const p = parsed as { cols: number; rows: number };
      return { type: 'resize', cols: p.cols, rows: p.rows };
    }
  } catch {
    // Not JSON — treat as plain stdin bytes.
  }
  return undefined;
}

/**
 * A handle returned by {@link attachWsPtyEndpoint} so the caller can detach the
 * `'upgrade'` listener and tear down every live session on server close (AC3).
 */
export interface WsPtyEndpointHandle {
  /** The number of live WS-PTY sessions (for tests / health). */
  readonly sessionCount: number;
  /** Detach the listener and tear down every live session. Idempotent. */
  close(): void;
}

/**
 * The shape of the HTTP server's `'upgrade'` event surface this module needs.
 * Declared structurally so the module does not couple to a concrete `Server`.
 */
export interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void;
  removeListener(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void;
}

/**
 * Attach the WS terminal/PTY endpoint (AC1) to an existing HTTP server's
 * `'upgrade'` event.
 *
 * Every upgrade to {@link WS_PTY_PATH} is gated ({@link authorizeUpgrade}, AC4)
 * BEFORE any PTY is spawned; a rejected upgrade gets a raw `401`/`403` and the
 * socket is destroyed. An accepted upgrade completes the RFC 6455 handshake and
 * bridges a PTY bidirectionally ({@link bridgePty}, AC2). An upgrade to any OTHER
 * path is left for other upgrade handlers (this listener only claims its own
 * path and never destroys a foreign socket).
 *
 * Each live session is tracked so {@link WsPtyEndpointHandle.close} tears every
 * one down deterministically on server close (AC3).
 *
 * @param server - The HTTP server whose `'upgrade'` event to attach to.
 * @param opts - The endpoint auth + PTY configuration.
 * @returns A handle to detach + tear down on server close.
 */
export function attachWsPtyEndpoint(
  server: UpgradableServer,
  opts: WsPtyOptions = {},
): WsPtyEndpointHandle {
  const log = getLogger('gateway-ws-pty');
  const sessions = new Set<WsPtySession>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, _head: Buffer): void => {
    // Only claim our own path — leave every other upgrade for other handlers.
    if (!isWsPtyPath(req.url)) return;

    const decision = authorizeUpgrade(req, req.socket.remoteAddress, opts);
    if (!decision.ok) {
      log.debug({ status: decision.status, reason: decision.reason }, 'ws-pty upgrade rejected');
      rejectUpgrade(socket, decision.status, decision.reason);
      return;
    }

    // A box the bridge's teardown callback closes over to de-register itself —
    // the session is added to the registry below, but teardown may fire (PTY
    // absent → immediate close) before the promise resolves, so the callback
    // removes whatever was registered for this socket once it is known.
    let session: WsPtySession | undefined;
    let deregistered = false;
    const deregister = (): void => {
      if (deregistered) return;
      deregistered = true;
      if (session !== undefined) sessions.delete(session);
    };

    bridgePty(req, socket, opts, log, deregister)
      .then((s) => {
        session = s;
        // If teardown already ran (e.g. PTY absent), do not re-register a dead
        // session; otherwise track it for the server-close sweep.
        if (!deregistered) sessions.add(s);
      })
      .catch((err: unknown) => {
        log.warn({ err }, 'ws-pty bridge failed');
        deregister();
        if (!socket.destroyed) socket.destroy();
      });
  };

  server.on('upgrade', onUpgrade);

  let closed = false;
  return {
    get sessionCount(): number {
      return sessions.size;
    },
    close(): void {
      if (closed) return;
      closed = true;
      server.removeListener('upgrade', onUpgrade);
      for (const session of [...sessions]) session.teardown(1001, 'server closing');
      sessions.clear();
    },
  };
}
