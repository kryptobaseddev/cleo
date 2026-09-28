/**
 * T12494 — the observation-type and owner-decision sites must let the process
 * EXIT promptly when System One is configured but unreachable.
 *
 * Mirrors `memory/__tests__/decision-contradiction-exit.test.ts` (T12493).
 * Each case spawns a Node process that imports the COMPILED core and runs one
 * site once — the real credentials file, config cascade (default mode:
 * `shadow`), transport and audit sink, with nothing stubbed in-process —
 * against providers that never answer:
 *
 * - a TLS black hole: a local TCP listener that accepts and never speaks;
 * - an unroutable address (`10.255.255.1`), where the SYN goes nowhere;
 * - slow DNS: a hostname whose resolution is sent to a local UDP socket that
 *   never replies (a `--import` preload points every resolver at it).
 *
 * The assertion is on process EXIT, relative to an unconfigured run of the
 * same site: the configured run may cost at most the decision budget plus
 * slack more.
 *
 * @task T12494
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
const DIST = resolve(__dirname, '..', '..', '..', 'dist');
const OBSERVATION_DIST = join(DIST, 'memory', 'observation-type-decision.js');
const READINESS_DIST = join(DIST, 'orchestration', 'owner-decision-readiness.js');
const DIST_AVAILABLE = existsSync(OBSERVATION_DIST) && existsSync(READINESS_DIST);

/** Decision budget (mirrors `OBSERVATION_TYPE_BUDGET_MS` / `OWNER_DECISION_BUDGET_MS`). */
const DECISION_BUDGET_MS = 300;
/** Slack over the unconfigured baseline for scheduling noise. */
const SLACK_MS = 600;

type Site = 'observe' | 'readiness';
const SITE_IDS: Record<Site, string> = {
  observe: 'memory.observation-type',
  readiness: 'orchestration.owner-decision',
};

/** One site call, then a natural exit (no `process.exit`): lingering handles show up as time. */
const RUNNER = `
const [site] = process.argv.slice(1);
const projectRoot = process.env.CLEO_TEST_PROJECT;
let out;
if (site === 'observe') {
  const { chooseObservationType } = await import(process.env.CLEO_TEST_OBSERVATION_MODULE);
  out = await chooseObservationType('Update the address book importer', undefined, { projectRoot });
} else {
  const { classifyReadinessWithDecision } = await import(process.env.CLEO_TEST_READINESS_MODULE);
  out = await classifyReadinessWithDecision({
    id: 'T900', title: 'Vendor integration', description: '', status: 'pending',
    priority: 'medium', type: 'task', acceptance: ['merged'], labels: [],
    blockedBy: 'waiting on legal to choose a vendor', createdAt: '2026-09-28T00:00:00.000Z',
  }, {}, { projectRoot });
}
process.stdout.write(JSON.stringify(out) + '\\n');
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
 * A provider that answers at once: `change` for the type choice, 0.2 for the
 * owner noul. It runs in its OWN process: `spawnSync` blocks this test's event loop.
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
      answers[name] = name === 'owner'
        ? { type: 'noul', noul: 0.2, confidence: 0.9 }
        : { type: 'choice', choice: 'change', probabilities: { change: 0.9, feature: 0.1 }, confidence: 0.9 };
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
const baselineMs: Record<Site, number> = { observe: 0, readiness: 0 };

async function startProvider(status: number): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn('node', ['--input-type=module', '-e', FAST_PROVIDER, String(status)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((r) =>
    child.stdout?.once('data', (d: Buffer) => r(Number(d.toString().trim()))),
  );
  return { child, port };
}

function runSite(site: Site, extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLEO_HOME: home,
    CLEO_ROOT: project,
    CLEO_PROJECT_ROOT: project,
    CLEO_DIR: join(project, '.cleo'),
    CLEO_TEST_PROJECT: project,
    CLEO_TEST_OBSERVATION_MODULE: pathToFileURL(OBSERVATION_DIST).href,
    CLEO_TEST_READINESS_MODULE: pathToFileURL(READINESS_DIST).href,
    ...extraEnv,
  };
  delete env['CLEO_SESSION_ID'];
  const started = performance.now();
  const r = spawnSync('node', ['--input-type=module', '-e', RUNNER, site], {
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

/** The newest decision audit line — proves the case reached the decision. */
function lastAudit(): { site?: string; fallbackReason?: string; shadow?: { acted?: string } } {
  const lines = readFileSync(join(project, '.cleo', 'audit', 'decisions.jsonl'), 'utf-8')
    .trim()
    .split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}') as {
    site?: string;
    fallbackReason?: string;
    shadow?: { acted?: string };
  };
}

function expectPromptExit(site: Site, run: Run, label: string): void {
  const context = `${site}/${label}: ${Math.round(run.ms)} ms (baseline ${Math.round(baselineMs[site])} ms)\nstderr:\n${run.stderr}`;
  expect(run.signal, context).toBeNull();
  expect(run.status, context).toBe(0);
  // Default mode once configured is shadow: the result is the heuristic's.
  if (site === 'observe') expect(run.stdout, context).toContain('"source":"keyword"');
  else expect(run.stdout, context).toContain('"verdict":"proceed"');
  expect(run.ms - baselineMs[site], context).toBeLessThan(DECISION_BUDGET_MS + SLACK_MS);
  const audit = lastAudit();
  expect(audit.site).toBe(SITE_IDS[site]);
  expect(audit.shadow?.acted).toBe('heuristic');
}

describe.skipIf(!DIST_AVAILABLE)(
  'T12494 — observation-type and owner-decision sites exit promptly with an unreachable System One',
  () => {
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'cleo-T12494-exit-'));
      project = join(root, 'project');
      home = join(root, 'home');
      for (const dir of [project, home, join(project, '.cleo')])
        mkdirSync(dir, { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: project });
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

      for (const site of ['observe', 'readiness'] as const) {
        const samples = [runSite(site), runSite(site)];
        for (const s of samples) expect(s.status, s.stderr).toBe(0);
        baselineMs[site] = Math.min(...samples.map((s) => s.ms));
      }
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

    const SITES = ['observe', 'readiness'] as const;

    it.each(SITES)('%s: TLS black hole (accepts, never speaks)', (site) => {
      configure(`https://127.0.0.1:${tlsHolePort}`);
      expectPromptExit(site, runSite(site), 'tls-black-hole');
      expect(lastAudit().fallbackReason).toBe('timeout');
    }, 60_000);

    it.each(SITES)('%s: unroutable address (SYN goes nowhere)', (site) => {
      configure('https://10.255.255.1');
      expectPromptExit(site, runSite(site), 'unroutable');
      expect(['timeout', 'network']).toContain(lastAudit().fallbackReason);
    }, 60_000);

    it.each(SITES)('%s: fast provider (answered: the response socket is released too)', (site) => {
      configure(`http://127.0.0.1:${providers.get(200)?.port}`);
      expectPromptExit(site, runSite(site), 'fast-provider');
      expect(lastAudit().fallbackReason).toBeUndefined();
    }, 60_000);

    it.each(SITES)('%s: provider answers HTTP 999 — fallback, prompt exit', (site) => {
      configure(`http://127.0.0.1:${providers.get(999)?.port}`);
      expectPromptExit(site, runSite(site), 'status-999');
      expect(lastAudit().fallbackReason).toBeDefined();
    }, 60_000);

    it.each(SITES)('%s: slow DNS (resolver query never answered)', (site) => {
      configure('https://decide.slow-dns.invalid');
      expectPromptExit(
        site,
        runSite(site, {
          CLEO_TEST_SILENT_DNS: `127.0.0.1:${silentDnsPort}`,
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        }),
        'slow-dns',
      );
      expect(lastAudit().fallbackReason).toBe('timeout');
    }, 60_000);
  },
);
