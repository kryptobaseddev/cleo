/**
 * T12492 — `cleo add` must EXIT promptly when System One is configured but
 * unreachable.
 *
 * The duplicate-detection decision is bounded at 300 ms, and the envelope did
 * arrive on time. But an aborted request that is still connecting (TCP SYN
 * unanswered, TLS handshake stalled, DNS query unanswered) left its
 * connect-phase handle — `TCPConnectWrap` / `GetAddrInfoReqWrap` / a c-ares
 * query — holding the event loop, so the process lived on until the teardown
 * backstop fired ("event loop still alive … after teardown").
 *
 * Each case spawns the COMPILED CLI against a provider that never answers:
 *
 * - a TLS black hole: a local TCP listener that accepts and never speaks;
 * - an unroutable address (`10.255.255.1`), where the SYN goes nowhere;
 * - slow DNS: a hostname whose resolution is sent to a local UDP socket that
 *   never replies (installed by a `--import` preload that points every
 *   resolver in the child at it).
 *
 * The assertion is on process EXIT, relative to an unconfigured `cleo add` in
 * the same project: the configured add may cost at most the decision budget
 * plus slack more, and stderr must not carry the backstop message.
 *
 * @task T12492
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIST = resolve(__dirname, '..', '..', '..', 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

/** Decision budget (mirrors `DUPLICATE_DECISION_BUDGET_MS`). */
const DECISION_BUDGET_MS = 300;
/** Slack over the unconfigured baseline for scheduling noise. */
const SLACK_MS = 600;
/** The teardown backstop's stderr signature. */
const BACKSTOP = /event loop still alive/;

/** Preload for the slow-DNS case: every resolver in the child asks a silent UDP socket. */
const PRELOAD = `
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const server = process.env.CLEO_TEST_SILENT_DNS;
const Base = dns.Resolver;
class SilentResolver extends Base {
  constructor(options) {
    super(options);
    this.setServers([server]);
  }
}
dns.Resolver = SilentResolver;
dns.lookup = function lookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const all = typeof options === 'object' && options !== null && options.all === true;
  new SilentResolver().resolve4(hostname, (err, addresses) => {
    if (err) return cb(err);
    if (all) return cb(null, addresses.map((address) => ({ address, family: 4 })));
    return cb(null, addresses[0], 4);
  });
  return {};
};
syncBuiltinESMExports();
`;

/**
 * A provider that answers at once. It runs in its OWN process: `spawnSync`
 * blocks this test's event loop, so an in-process HTTP server could not reply.
 */
const FAST_PROVIDER = `
import { createServer } from 'node:http';
createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const answers = {};
    for (const name of Object.keys(body.questions ?? {})) {
      answers[name] = { type: 'noul', noul: 0.1, confidence: 0.9 };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, answers, meta: { request_id: 'fast' } }));
  });
}).listen(0, '127.0.0.1', function () {
  process.stdout.write(String(this.address().port) + '\\n');
});
`;

interface Run {
  readonly ms: number;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let root: string;
let project: string;
let home: string;
let preloadPath: string;
let sessionId = '';
let epicId = '';
let tlsHole: Server;
let tlsHolePort = 0;
const heldSockets: Socket[] = [];
let silentDns: UdpSocket;
let silentDnsPort = 0;
let fastProvider: ChildProcess | undefined;
let fastProviderPort = 0;

function cli(args: readonly string[], extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLEO_HOME: home,
    CLEO_ROOT: project,
    CLEO_PROJECT_ROOT: project,
    CLEO_DIR: join(project, '.cleo'),
    ...extraEnv,
  };
  delete env['CLEO_SESSION_ID'];
  delete env['CLEO_WORKTREE_ROOT'];
  delete env['CLEO_AGENT_ID'];
  if (sessionId) env['CLEO_SESSION_ID'] = sessionId;
  const started = performance.now();
  const r = spawnSync('node', [CLI_DIST, ...args], {
    cwd: project,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    ms: performance.now() - started,
    status: r.status,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function field(run: Run, pointer: string): string {
  const env = JSON.parse(run.stdout) as Record<string, unknown>;
  let node: unknown = env;
  for (const key of pointer.split('/').filter(Boolean)) {
    node = (node as Record<string, unknown>)[key];
  }
  return String(node);
}

function configure(baseUrl: string): void {
  writeFileSync(
    join(home, 'decide-credentials.json'),
    JSON.stringify({ version: 1, baseUrl, apiKey: 'sk-exit-test-0000', model: 'stub-model' }),
    { mode: 0o600 },
  );
}

let addCounter = 0;
/** A `cleo add` whose title lands in the Tier-3 zone against the seeded candidates. */
function ambiguousAdd(extraEnv: Record<string, string> = {}): Run {
  addCounter += 1;
  return cli(
    [
      'add',
      `Add retry logic to the webhook sender ${addCounter}`,
      '--description',
      'Retry failed webhook deliveries with exponential backoff',
      '--acceptance',
      'works',
      '--parent',
      epicId,
    ],
    extraEnv,
  );
}

describe.skipIf(!CLI_DIST_AVAILABLE)(
  'T12492 — cleo add exits promptly with an unreachable System One',
  () => {
    let baselineMs = 0;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'cleo-T12492-exit-'));
      project = join(root, 'project');
      home = join(root, 'home');
      for (const dir of [project, home]) rmSync(dir, { recursive: true, force: true });
      spawnSync('mkdir', ['-p', project, home]);
      spawnSync('git', ['init', '-q'], { cwd: project });
      preloadPath = join(root, 'silent-dns-preload.mjs');
      writeFileSync(preloadPath, PRELOAD);

      tlsHole = createServer((socket) => heldSockets.push(socket));
      await new Promise<void>((r) => tlsHole.listen(0, '127.0.0.1', r));
      tlsHolePort = (tlsHole.address() as { port: number }).port;

      fastProvider = spawn('node', ['--input-type=module', '-e', FAST_PROVIDER], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      fastProviderPort = await new Promise<number>((r) =>
        fastProvider?.stdout?.once('data', (d: Buffer) => r(Number(d.toString().trim()))),
      );

      silentDns = createSocket('udp4');
      silentDns.on('message', () => undefined);
      await new Promise<void>((r) => silentDns.bind(0, '127.0.0.1', r));
      silentDnsPort = silentDns.address().port;

      expect(cli(['init', '--name', 'exit-test']).status).toBe(0);
      sessionId = field(
        cli(['session', 'start', '--scope', 'global', '--name', 'exit']),
        '/data/id',
      );
      const saga = field(
        cli([
          'saga',
          'create',
          '--title',
          'Exit test saga theme',
          '--description',
          'exit test',
          '--acceptance',
          'a1|a2|a3|a4|a5',
        ]),
        '/data/created/0',
      );
      epicId = field(
        cli([
          'add',
          'Exit test epic container',
          '--type',
          'epic',
          '--parent',
          saga,
          '--description',
          'exit test epic',
          '--acceptance',
          'a1|a2|a3|a4|a5',
        ]),
        '/data/created/0',
      );
      for (const [title, description] of [
        [
          'Add retry logic to the webhook delivery',
          'Retry failed webhook deliveries with backoff and jitter',
        ],
        [
          'Retry logic for the webhook sender',
          'Failed webhook deliveries retry with exponential backoff',
        ],
      ] as const) {
        const seeded = cli([
          'add',
          title,
          '--description',
          description,
          '--acceptance',
          'works',
          '--parent',
          epicId,
        ]);
        expect(seeded.status).toBe(0);
      }

      // Unconfigured reference: same process startup and store work, no decision.
      const samples = [ambiguousAdd(), ambiguousAdd()];
      for (const s of samples) expect(s.status, s.stderr).toBe(0);
      baselineMs = Math.min(...samples.map((s) => s.ms));
    }, 120_000);

    afterAll(async () => {
      for (const s of heldSockets) s.destroy();
      await new Promise<void>((r) => tlsHole?.close(() => r()));
      silentDns?.close();
      fastProvider?.kill();
      rmSync(root, { recursive: true, force: true });
    });

    /** Fallback reason of the newest decision audit line — proves the case hit the stalled phase. */
    function lastFallbackReason(): string | undefined {
      const lines = readFileSync(join(project, '.cleo', 'audit', 'decisions.jsonl'), 'utf-8')
        .trim()
        .split('\n');
      const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { fallbackReason?: string };
      return last.fallbackReason;
    }

    function expectPromptExit(run: Run, label: string): void {
      const context = `${label}: ${Math.round(run.ms)} ms (baseline ${Math.round(baselineMs)} ms)\nstderr:\n${run.stderr}`;
      expect(run.signal, context).toBeNull();
      expect(run.status, context).toBe(0);
      expect(run.stdout, context).toContain('"success":true');
      expect(run.stderr, context).not.toMatch(BACKSTOP);
      expect(run.ms - baselineMs, context).toBeLessThan(DECISION_BUDGET_MS + SLACK_MS);
    }

    it('TLS black hole (accepts, never speaks)', () => {
      configure(`https://127.0.0.1:${tlsHolePort}`);
      expectPromptExit(ambiguousAdd(), 'tls-black-hole');
      expect(lastFallbackReason()).toBe('timeout');
    }, 60_000);

    it('unroutable address (SYN goes nowhere)', () => {
      configure('https://10.255.255.1');
      expectPromptExit(ambiguousAdd(), 'unroutable');
      // A network that rejects the route outright answers fast ('network'); one
      // that drops the SYN is the hang this case exists for ('timeout').
      expect(['timeout', 'network']).toContain(lastFallbackReason());
    }, 60_000);

    it('fast provider (answered: the response socket is released too)', () => {
      configure(`http://127.0.0.1:${fastProviderPort}`);
      expectPromptExit(ambiguousAdd(), 'fast-provider');
      expect(lastFallbackReason()).toBeUndefined();
    }, 60_000);

    it('slow DNS (resolver query never answered)', () => {
      configure('https://decide.slow-dns.invalid');
      expectPromptExit(
        ambiguousAdd({
          CLEO_TEST_SILENT_DNS: `127.0.0.1:${silentDnsPort}`,
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        }),
        'slow-dns',
      );
      expect(lastFallbackReason()).toBe('timeout');
    }, 60_000);
  },
);
