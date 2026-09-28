/**
 * T12493 — a validated ADR decision write must EXIT promptly when System One
 * is configured but unreachable.
 *
 * Mirrors `packages/cleo/src/cli/__tests__/decide-duplicate-exit.test.ts`
 * (T12492). No `cleo` verb requests model validation today (`validateWithLlm`
 * has no CLI flag), so each case spawns a Node process that imports the
 * COMPILED core and calls `storeDecision(..., { validateWithLlm: true })` — the
 * real credentials file, config cascade, transport and audit sink, with
 * nothing stubbed in-process. Providers that never answer:
 *
 * - a TLS black hole: a local TCP listener that accepts and never speaks;
 * - an unroutable address (`10.255.255.1`), where the SYN goes nowhere;
 * - slow DNS: a hostname whose resolution is sent to a local UDP socket that
 *   never replies (a `--import` preload points every resolver at it).
 *
 * The assertion is on process EXIT, relative to an unconfigured write in the
 * same project: the configured write may cost at most the decision budget
 * plus slack more.
 *
 * @task T12493
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECISIONS_DIST = resolve(__dirname, '..', '..', '..', 'dist', 'memory', 'decisions.js');
const DIST_AVAILABLE = existsSync(DECISIONS_DIST);

/** Decision budget (mirrors `DECISION_CONTRADICTION_BUDGET_MS`). */
const DECISION_BUDGET_MS = 300;
/** Slack over the unconfigured baseline for scheduling noise. */
const SLACK_MS = 600;

/** One decision write, then a natural exit (no `process.exit`): lingering handles show up as time. */
const WRITER = `
const { storeDecision } = await import(process.env.CLEO_TEST_DECISIONS_MODULE);
const [mode, n] = process.argv.slice(1);
const row = await storeDecision(process.env.CLEO_TEST_PROJECT, mode === 'seed'
  ? {
      type: 'architecture',
      decision: 'Use SQLite as the primary datastore for brain memory',
      rationale: 'Single file, zero configuration, embedded in every agent',
      confidence: 'high',
    }
  : {
      type: 'architecture',
      // Twenty tokens unique to this write keep it below the 0.65 collision
      // threshold against earlier writes, so no write is rejected.
      decision:
        'Use PostgreSQL as the primary datastore for brain memory ' +
        Array.from({ length: 20 }, (_, i) => 'word' + n + 'x' + i).join(' '),
      rationale: 'Concurrent writers need row-level locking across agents',
      confidence: 'high',
      adrPath: 'docs/adr/ADR-900.md',
      validateWithLlm: true,
    });
process.stdout.write(JSON.stringify({ id: row.id }) + '\\n');
`;

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
 * A provider that answers at once with `unrelated` for every choice question.
 * It runs in its OWN process: `spawnSync` blocks this test's event loop.
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
      answers[name] = {
        type: 'choice',
        choice: 'unrelated',
        probabilities: { contradicts: 0.02, supersedes: 0.03, refines: 0.05, unrelated: 0.9 },
        confidence: 0.9,
      };
    }
    res.writeHead(Number(process.argv[1] ?? 200), { 'content-type': 'application/json' });
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
let tlsHole: Server;
let tlsHolePort = 0;
const heldSockets: Socket[] = [];
let silentDns: UdpSocket;
let silentDnsPort = 0;
const providers = new Map<number, { child: ChildProcess; port: number }>();

async function startProvider(status: number): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn('node', ['--input-type=module', '-e', FAST_PROVIDER, String(status)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((r) =>
    child.stdout?.once('data', (d: Buffer) => r(Number(d.toString().trim()))),
  );
  return { child, port };
}

let writeCounter = 0;
function write(mode: 'seed' | 'validate', extraEnv: Record<string, string> = {}): Run {
  writeCounter += 1;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLEO_HOME: home,
    CLEO_ROOT: project,
    CLEO_PROJECT_ROOT: project,
    CLEO_DIR: join(project, '.cleo'),
    CLEO_TEST_PROJECT: project,
    CLEO_TEST_DECISIONS_MODULE: pathToFileURL(DECISIONS_DIST).href,
    ...extraEnv,
  };
  // The validator returns early under CLEO_ENV=test.
  delete env['CLEO_ENV'];
  delete env['CLEO_SESSION_ID'];
  const started = performance.now();
  const r = spawnSync('node', ['--input-type=module', '-e', WRITER, mode, String(writeCounter)], {
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

function configure(baseUrl: string): void {
  writeFileSync(
    join(home, 'decide-credentials.json'),
    JSON.stringify({ version: 1, baseUrl, apiKey: 'sk-exit-test-0000', model: 'stub-model' }),
    { mode: 0o600 },
  );
}

describe.skipIf(!DIST_AVAILABLE)(
  'T12493 — a validated decision write exits promptly with an unreachable System One',
  () => {
    let baselineMs = 0;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'cleo-T12493-exit-'));
      project = join(root, 'project');
      home = join(root, 'home');
      for (const dir of [project, home, join(project, '.cleo')])
        mkdirSync(dir, { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: project });
      // Keep the unconfigured baseline off the generative-LLM path, so it
      // measures process startup and store work only.
      writeFileSync(
        join(project, '.cleo', 'config.json'),
        JSON.stringify({ decide: { generativeFallback: { decisionContradiction: false } } }),
      );
      preloadPath = join(root, 'silent-dns-preload.mjs');
      writeFileSync(preloadPath, PRELOAD);

      tlsHole = createServer((socket) => heldSockets.push(socket));
      await new Promise<void>((r) => tlsHole.listen(0, '127.0.0.1', r));
      tlsHolePort = (tlsHole.address() as { port: number }).port;
      for (const status of [200, 999]) providers.set(status, await startProvider(status));

      silentDns = createSocket('udp4');
      silentDns.on('message', () => undefined);
      await new Promise<void>((r) => silentDns.bind(0, '127.0.0.1', r));
      silentDnsPort = silentDns.address().port;

      const seeded = write('seed');
      expect(seeded.status, seeded.stderr).toBe(0);

      const samples = [write('validate'), write('validate')];
      for (const s of samples) expect(s.status, s.stderr).toBe(0);
      baselineMs = Math.min(...samples.map((s) => s.ms));
      // Unconfigured: no decision was asked, so nothing was audited.
      expect(existsSync(join(project, '.cleo', 'audit', 'decisions.jsonl'))).toBe(false);
    }, 120_000);

    afterAll(async () => {
      for (const s of heldSockets) s.destroy();
      await new Promise<void>((r) => tlsHole?.close(() => r()));
      silentDns?.close();
      for (const { child } of providers.values()) child.kill();
      rmSync(root, { recursive: true, force: true });
    });

    /** The newest decision audit line — proves the case reached the decision. */
    function lastAudit(): { site?: string; fallbackReason?: string } {
      const lines = readFileSync(join(project, '.cleo', 'audit', 'decisions.jsonl'), 'utf-8')
        .trim()
        .split('\n');
      return JSON.parse(lines[lines.length - 1] ?? '{}') as {
        site?: string;
        fallbackReason?: string;
      };
    }

    function expectPromptExit(run: Run, label: string): void {
      const context = `${label}: ${Math.round(run.ms)} ms (baseline ${Math.round(baselineMs)} ms)\nstderr:\n${run.stderr}`;
      expect(run.signal, context).toBeNull();
      expect(run.status, context).toBe(0);
      expect(run.stdout, context).toMatch(/"id":"D\d+"/);
      expect(run.ms - baselineMs, context).toBeLessThan(DECISION_BUDGET_MS + SLACK_MS);
      expect(lastAudit().site).toBe('memory.decision-contradiction');
    }

    it('TLS black hole (accepts, never speaks)', () => {
      configure(`https://127.0.0.1:${tlsHolePort}`);
      expectPromptExit(write('validate'), 'tls-black-hole');
      expect(lastAudit().fallbackReason).toBe('timeout');
    }, 60_000);

    it('unroutable address (SYN goes nowhere)', () => {
      configure('https://10.255.255.1');
      expectPromptExit(write('validate'), 'unroutable');
      expect(['timeout', 'network']).toContain(lastAudit().fallbackReason);
    }, 60_000);

    it('fast provider (answered: the response socket is released too)', () => {
      configure(`http://127.0.0.1:${providers.get(200)?.port}`);
      expectPromptExit(write('validate'), 'fast-provider');
      expect(lastAudit().fallbackReason).toBeUndefined();
    }, 60_000);

    it('provider answers HTTP 999: fallback, decision stored, prompt exit', () => {
      configure(`http://127.0.0.1:${providers.get(999)?.port}`);
      expectPromptExit(write('validate'), 'status-999');
      expect(lastAudit().fallbackReason).toBeDefined();
    }, 60_000);

    it('slow DNS (resolver query never answered)', () => {
      configure('https://decide.slow-dns.invalid');
      expectPromptExit(
        write('validate', {
          CLEO_TEST_SILENT_DNS: `127.0.0.1:${silentDnsPort}`,
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        }),
        'slow-dns',
      );
      expect(lastAudit().fallbackReason).toBe('timeout');
    }, 60_000);
  },
);
