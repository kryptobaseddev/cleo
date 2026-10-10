/**
 * Tests for `cleo doctor system` (T13435): the pure assessment over macOS and
 * Linux fixtures shaped like the 2026-10-10 incident, plus the parsers.
 *
 * @task T13435
 */

import { describe, expect, it } from 'vitest';
import { DarwinResourceBackend } from '../../resources/darwin-backend.js';
import { LinuxResourceBackend } from '../../resources/linux-backend.js';
import type { MemoryGuardAudit } from '../../resources/memory-guard.js';
import {
  assessSystemHealth,
  commandWords,
  gitRootOf,
  mcpServerName,
  parseDockerCreatedAt,
  parseDockerSize,
  parseEtime,
  parseLinuxSwap,
  parseLsofCwd,
  parsePs,
  runReadOnly,
  type SystemSnapshot,
} from '../system-health.js';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-10-10T17:00:00Z');

/** The incident machine: kernel warning, 24 of 25 GB swap. */
const DARWIN_SYSCTL = [
  'kern.memorystatus_vm_pressure_level: 2',
  'kern.memorystatus_level: 38',
  'vm.swapusage: total = 25600.00M  used = 24576.00M  free = 1024.00M  (encrypted)',
  'vm.loadavg: { 24.10 22.00 20.00 }',
  'hw.ncpu: 16',
  '',
].join('\n');

const NODE = '/Users/u/.local/share/mise/installs/node/lts/bin/node';
const BIN = '/Users/u/.local/share/mise/installs/node/24.21.0/bin';

/** `ps -A -o pid=,ppid=,pgid=,rss=,pcpu=,etime=,args=` rows (rss in KiB). */
function psRow(
  pid: number,
  ppid: number,
  rssKib: number,
  pcpu: number,
  etime: string,
  args: string,
  pgid = pid,
  tty = '??',
): string {
  return `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${String(pgid).padStart(6)} ${String(rssKib).padStart(8)} ${pcpu.toFixed(1).padStart(5)} ${etime.padStart(11)} ${tty.padEnd(8)} ${args}`;
}

function incidentPs(): string {
  const rows: string[] = [psRow(1, 0, 10_000, 0, '2-20:00:00', '/sbin/launchd')];
  // 8 claude sessions, 6 idle; each runs playwright-mcp, mcpvault and agentmbx.
  for (let i = 0; i < 8; i++) {
    const s = 1000 + i * 10;
    rows.push(
      psRow(s, 1, 600_000, i < 2 ? 25 : 0.2, '1-02:00:00', 'claude --dangerously-skip-permissions'),
    );
    rows.push(psRow(s + 1, s, 120_000, 0, '1-02:00:00', `${NODE} ${BIN}/playwright-mcp`));
    rows.push(
      psRow(s + 2, s, 90_000, 0, '1-02:00:00', `${NODE} ${BIN}/mcpvault /Users/u/Documents/Vault`),
    );
    rows.push(psRow(s + 3, s, 80_000, 0, '1-02:00:00', `node ${BIN}/agentmbx mcp`));
    // A shim and the server it starts count once.
    rows.push(
      psRow(
        s + 7,
        s + 3,
        40_000,
        0,
        '1-02:00:00',
        `${NODE} /x/lib/node_modules/agentmbx/bin/agentmbx.js mcp`,
      ),
    );
    rows.push(psRow(s + 4, s, 50_000, 0, '1-02:00:00', 'npm exec @canva/cli@latest'));
    rows.push(
      psRow(
        s + 5,
        s + 4,
        70_000,
        0,
        '1-02:00:00',
        'node /Users/u/.npm/_npx/x/node_modules/.bin/canva mcp',
      ),
    );
    // Two different servers started through npx, each with its node child.
    rows.push(psRow(s + 8, s, 30_000, 0, '1-02:00:00', 'npm exec -y @playwright/mcp@latest'));
    rows.push(
      psRow(
        s + 9,
        s + 8,
        70_000,
        0,
        '1-02:00:00',
        `${NODE} /Users/u/.npm/_npx/a/node_modules/.bin/mcp-server-playwright`,
      ),
    );
    rows.push(psRow(s + 10, s, 30_000, 0, '1-02:00:00', 'npx -y @upstash/context7-mcp@1.0.17'));
    rows.push(
      psRow(
        s + 11,
        s + 10,
        60_000,
        0,
        '1-02:00:00',
        `${NODE} /Users/u/.npm/_npx/b/node_modules/.bin/context7-mcp`,
      ),
    );
    rows.push(
      psRow(s + 6, s, 60_000, 0, '1-02:00:00', `${NODE} /w/tools/axiom-qa-mcp/dist/server.js`),
    );
  }
  // An MCP server left behind by a closed session.
  rows.push(
    psRow(950, 1, 100_000, 0, '3-00:00:00', `${NODE} ${BIN}/mcpvault /Users/u/Documents/Vault`),
  );
  // Harness helpers are not sessions.
  rows.push(
    psRow(
      900,
      1,
      20_000,
      0,
      '2-00:00:00',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec-server --remote https://x',
    ),
  );
  rows.push(
    psRow(901, 1, 20_000, 0, '2-00:00:00', '/Users/u/.local/bin/claude --chrome-native-host'),
  );
  // Ungoverned typecheck in another project, with a worker child.
  rows.push(psRow(5000, 1000, 2_000, 0, '00:10:00', '/bin/zsh -c pnpm run typecheck'));
  rows.push(psRow(5001, 5000, 90_000, 30, '00:10:00', 'pnpm run typecheck', 5001));
  rows.push(
    psRow(
      5002,
      5001,
      5_000_000,
      99,
      '00:09:58',
      `${NODE} /p/node_modules/typescript/bin/tsc -b`,
      5001,
    ),
  );
  // Governed: under `cleo run`.
  rows.push(
    psRow(
      6000,
      1010,
      80_000,
      1,
      '00:03:00',
      `${NODE} /p/bin/cleo run --wait --class test -- pnpm vitest run a.test.ts`,
    ),
  );
  rows.push(psRow(6001, 6000, 900_000, 80, '00:02:59', 'pnpm vitest run a.test.ts', 6001));
  // Governed by the ledger's tool group (detached).
  rows.push(
    psRow(6100, 1, 700_000, 70, '00:01:00', `${NODE} /p/node_modules/vitest/vitest.mjs run`, 6100),
  );
  // Long-lived servers are not heavy jobs.
  rows.push(
    psRow(
      7000,
      1020,
      200_000,
      0,
      '1-00:00:00',
      '/p/node_modules/@biomejs/cli-darwin-arm64/biome lsp-proxy',
    ),
  );
  rows.push(
    psRow(7001, 1, 300_000, 0, '1-00:00:00', `${NODE} /p/node_modules/vite/bin/vite.js dev`),
  );
  rows.push(
    psRow(
      7002,
      1,
      38_000,
      0,
      '05:00:00',
      '/p/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.28.2 --ping',
    ),
  );
  // Indexer churning.
  rows.push(
    psRow(
      8000,
      1,
      400_000,
      140,
      '2-00:00:00',
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores',
    ),
  );
  return `${rows.join('\n')}\n`;
}

const DOCKER: SystemSnapshot['docker'] = {
  danglingVolumes: Array.from({ length: 475 }, (_, i) => `${'a'.repeat(60)}${i}`).join('\n'),
  systemDf: [
    '{"Active":"2","Reclaimable":"11.89GB (55%)","Size":"21.51GB","TotalCount":"29","Type":"Images"}',
    '{"Active":"13","Reclaimable":"52.3GB (97%)","Size":"54GB","TotalCount":"488","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"9.119GB","Size":"9.119GB","TotalCount":"71","Type":"Build Cache"}',
  ].join('\n'),
  containers: [
    'eec1f21d56fa\trv1732c-pg17\tpostgres:17\t2026-10-10 09:23:54 -0700 PDT\t',
    '53997b1d6797\tcredit-t1716-full-pg17\tpostgres:17\t2026-10-08 20:43:56 -0700 PDT\t',
    '9e75769f4fde\tlead-t1013-native\tpostgres:17\t2026-10-09 01:39:59 -0700 PDT\t',
    'a1\tapp-db-1\tpostgres:16\t2026-10-01 01:00:00 -0700 PDT\tcom.docker.compose.project=app,x=y',
    'b2\tweb\tnginx:latest\t2026-10-01 01:00:00 -0700 PDT\t',
  ].join('\n'),
};

async function darwinSnapshot(over: Partial<SystemSnapshot> = {}): Promise<SystemSnapshot> {
  const sample = await new DarwinResourceBackend({
    sysctlFn: async () => DARWIN_SYSCTL,
    totalMemBytes: 64 * GIB,
    now: () => NOW,
  }).sample();
  return {
    platform: 'darwin',
    sampledAtMs: NOW,
    totalMemBytes: 64 * GIB,
    cpuCount: 16,
    loadAvg1: 24.1,
    sample,
    linuxSwap: null,
    ps: incidentPs(),
    governedPgids: [6100],
    governedPids: [],
    docker: DOCKER,
    indexing: {
      projectRoot: '/Users/u/p',
      timeMachine: '[Included]  /Users/u/p/node_modules\n',
      spotlightCount: '1234\n',
    },
    memoryGuard: null,
    ...over,
  };
}

const MEMINFO = [
  'MemTotal:       65536000 kB',
  'MemAvailable:    2048000 kB',
  'SwapTotal:      16777216 kB',
  'SwapFree:        1048576 kB',
  '',
].join('\n');

const UNGUARDED: MemoryGuardAudit = {
  supported: true,
  totalRamGib: 62.5,
  memoryHighGib: null,
  memoryMaxGib: null,
  recommendedHighGib: 45,
  recommendedMaxGib: 56.3,
  findings: [
    { id: 'memory-high-unset', severity: 'fail', summary: 'MemoryHigh unset', evidence: 'max' },
  ],
  guarded: false,
};

async function linuxSnapshot(over: Partial<SystemSnapshot> = {}): Promise<SystemSnapshot> {
  const files: Record<string, string> = {
    '/proc/pressure/memory':
      'some avg10=40.00 avg60=35.00 avg300=20.00 total=1\nfull avg10=20.00 avg60=15.00 avg300=5.00 total=1\n',
    '/proc/meminfo': MEMINFO,
  };
  const sample = await new LinuxResourceBackend({
    readFileFn: async (p) => {
      const body = files[p];
      if (body === undefined) throw new Error(`ENOENT ${p}`);
      return body;
    },
  }).sample();
  return {
    platform: 'linux',
    sampledAtMs: NOW,
    totalMemBytes: 62.5 * GIB,
    cpuCount: 16,
    loadAvg1: 4,
    sample,
    linuxSwap: parseLinuxSwap(MEMINFO),
    ps: incidentPs().replaceAll('/Users/u', '/home/u'),
    governedPgids: [6100],
    governedPids: [],
    docker: null,
    indexing: null,
    memoryGuard: UNGUARDED,
    ...over,
  };
}

describe('parsers', () => {
  it('parses BSD and procps etime', () => {
    expect(parseEtime('05:03')).toBe(303);
    expect(parseEtime('01:00:00')).toBe(3600);
    expect(parseEtime('2-20:00:00')).toBe(2 * 86400 + 20 * 3600);
  });

  it('parses ps rows and keeps the whole command line', () => {
    const [row] = parsePs(
      psRow(42, 1, 1024, 3.5, '10:00', '/bin/zsh -c echo hi there', 42, 'pts/3'),
    );
    expect(parsePs(psRow(43, 1, 1, 0, '00:01', 'x'))[0]?.tty).toBeNull();
    expect(row).toMatchObject({
      tty: 'pts/3',
      pid: 42,
      ppid: 1,
      pgid: 42,
      rssBytes: 1024 * 1024,
      pcpu: 3.5,
      elapsedSec: 600,
    });
    expect(row?.args).toBe('/bin/zsh -c echo hi there');
  });

  it('drops the interpreter and the script extension', () => {
    expect(commandWords([NODE, '/p/node_modules/typescript/bin/tsc', '-b'])).toEqual(['tsc', '-b']);
    expect(commandWords(['node', '/p/node_modules/vitest/vitest.mjs', 'run'])).toEqual([
      'vitest',
      'run',
    ]);
    expect(commandWords(['/usr/local/bin/claude'])).toEqual(['claude']);
  });

  it('names MCP servers, using the package directory for generic entry files', () => {
    const name = (args: string): string | null => {
      const [row] = parsePs(psRow(9, 1, 1, 0, '00:01', args));
      return row ? mcpServerName(row) : null;
    };
    expect(name(`${NODE} ${BIN}/playwright-mcp`)).toBe('playwright-mcp');
    expect(name(`${NODE} ${BIN}/mcpvault /vault`)).toBe('mcpvault');
    expect(name('node /x/bin/agentmbx mcp')).toBe('agentmbx');
    expect(name('railway mcp')).toBe('railway');
    expect(name(`${NODE} /w/tools/axiom-qa-mcp/dist/server.js`)).toBe('axiom-qa-mcp');
    expect(name(`${NODE} ./mcp/server.mjs`)).toBe('mcp');
    expect(name('claude mcp serve')).toBeNull();
    expect(name('npx -y @playwright/mcp@latest')).toBe('@playwright/mcp');
    expect(name('pnpm dlx @upstash/context7-mcp@1.0.17 --api-key x')).toBe('@upstash/context7-mcp');
    expect(name('uvx mcp-server-fetch==0.6.2')).toBe('mcp-server-fetch');
    expect(name('bunx --bun mcp-remote https://x')).toBe('mcp-remote');
    // a launcher running something that is not an MCP server
    expect(name('npx -y tsx scripts/mcp-check.ts')).toBeNull();
    expect(name('npx -y agentmbx@0.5.23 mcp')).toBe('agentmbx');
    expect(name('pnpm vitest run')).toBeNull();
  });

  it('parses docker sizes, timestamps and Linux swap', () => {
    expect(parseDockerSize('52.3GB (97%)')).toBe(52.3e9);
    expect(parseDockerSize('16.38kB')).toBe(16380);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerCreatedAt('2026-10-10 10:23:54 -0700 PDT')).toBe(
      Date.parse('2026-10-10T17:23:54Z'),
    );
    expect(Number.isNaN(parseDockerCreatedAt('yesterday'))).toBe(true);
    expect(parseLinuxSwap(MEMINFO)).toEqual({ usedBytes: 15 * GIB, totalBytes: 16 * GIB });
  });
});

describe('session context parsers (T13438)', () => {
  it('parses lsof cwd output and finds the git root', () => {
    expect(parseLsofCwd('p4112\nfcwd\nn/Users/u/p/app\np5058\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [4112, '/Users/u/p/app'],
        [5058, '/tmp'],
      ]),
    );
    const has = new Set(['/Users/u/p/.git']);
    expect(gitRootOf('/Users/u/p/app/src', (x) => has.has(x))).toBe('/Users/u/p');
    expect(gitRootOf('/tmp/x', (x) => has.has(x))).toBeNull();
  });
});

describe('runReadOnly', () => {
  it('keeps stdout of a non-zero exit only when asked (lsof with a vanished pid)', async () => {
    const script = ['-c', 'printf "p1\\nn/a\\n"; exit 1'];
    expect(await runReadOnly('sh', script, { keepStdoutOnExit: true })).toBe('p1\nn/a\n');
    expect(await runReadOnly('sh', script)).toBeNull();
    expect(await runReadOnly('sh', ['-c', 'exit 1'], { keepStdoutOnExit: true })).toBeNull();
    expect(await runReadOnly('/nonexistent/cmd', [], { keepStdoutOnExit: true })).toBeNull();
  });
});

describe('assessSystemHealth on macOS (the 2026-10-10 incident)', () => {
  it('ranks critical first and covers every check', async () => {
    const r = assessSystemHealth(await darwinSnapshot());
    expect(r.platform).toBe('darwin');
    expect(r.findings[0]?.severity).toBe('critical');
    const order = r.findings.map((f) => ({ critical: 0, warning: 1, info: 2 })[f.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.summary.critical + r.summary.warning + r.summary.info).toBe(r.findings.length);
    expect(Object.fromEntries(r.coverage.map((c) => [c.check, c.status]))).toEqual({
      memory: 'ok',
      'mcp-fanout': 'ok',
      'heavy-ungoverned': 'ok',
      sessions: 'ok',
      containers: 'ok',
      indexing: 'ok',
      'memory-guard': 'skipped',
    });
  });

  it('counts orphaned MCP servers (parent gone) separately from session ones', async () => {
    const f = assessSystemHealth(await darwinSnapshot()).findings.find(
      (x) => x.id === 'mcp-fanout:mcpvault',
    );
    expect(f?.evidence).toMatchObject({ processes: 9, sessionsWithServer: 8, orphans: 1 });
    expect(f?.title).toContain('1 orphaned');
  });

  it('flags swap, memory pressure and load', async () => {
    const ids = assessSystemHealth(await darwinSnapshot()).findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['swap', 'memory-pressure', 'cpu-load']));
    const swap = assessSystemHealth(await darwinSnapshot()).findings.find((f) => f.id === 'swap');
    expect(swap?.severity).toBe('critical');
    expect(swap?.evidence.swapUsedGib).toBe(24);
  });

  it('counts MCP servers per name, a wrapper and its server once, with an owner-choice remedy', async () => {
    const r = assessSystemHealth(await darwinSnapshot());
    const byId = new Map(r.findings.map((f) => [f.id, f]));
    expect(byId.get('mcp-fanout:playwright-mcp')?.evidence.processes).toBe(8);
    expect(byId.get('mcp-fanout:canva')?.evidence.processes).toBe(8);
    expect(byId.get('mcp-fanout:agentmbx')?.evidence.processes).toBe(8);
    expect(byId.get('mcp-fanout:agentmbx')?.evidence.rssMib).toBe(Math.round((8 * 120_000) / 1024));
    expect(byId.get('mcp-fanout:axiom-qa-mcp')?.evidence.processes).toBe(8);
    expect(byId.get('mcp-fanout:playwright-mcp')?.evidence).toMatchObject({
      sessionsWithServer: 8,
      sessionsTotal: 8,
      inEverySession: true,
      orphans: 0,
    });
    // agentmbx carries its owner's remedy: never a kill, never a removal
    const mbx = byId.get('mcp-fanout:agentmbx');
    expect(mbx?.remedy?.command).toBe('agentmbx doctor');
    expect(mbx?.remedy?.description).toContain('never kill');
    expect(mbx?.needsOwnerChoice).toBe(false);
    // launcher-started servers group by package, the wrapper and its child once
    expect(byId.get('mcp-fanout:@playwright/mcp')?.evidence).toMatchObject({
      processes: 8,
      rssMib: Math.round((8 * 100_000) / 1024),
    });
    expect(byId.get('mcp-fanout:@upstash/context7-mcp')?.evidence.processes).toBe(8);
    expect(byId.get('mcp-fanout:npm')).toBeUndefined();
    expect(byId.get('mcp-fanout:npx')).toBeUndefined();
    const pw = byId.get('mcp-fanout:playwright-mcp');
    expect(pw?.needsOwnerChoice).toBe(true);
    expect(pw?.remedy?.command).toBe('claude mcp remove playwright-mcp --scope user');
  });

  it('reports the root of an ungoverned heavy tree once, never a governed one', async () => {
    const heavy = assessSystemHealth(await darwinSnapshot()).findings.filter(
      (f) => f.category === 'heavy-ungoverned',
    );
    expect(heavy.map((f) => f.evidence.pid)).toEqual([5001]);
    expect(heavy[0]?.severity).toBe('critical');
    expect(heavy[0]?.remedy?.command).toBe('cleo doctor heavy-command-hook --fix');
    expect(heavy[0]?.needsOwnerChoice).toBe(false);
  });

  it('flags dangling volumes and long-running throwaway databases, never compose ones', async () => {
    const r = assessSystemHealth(await darwinSnapshot());
    const vols = r.findings.find((f) => f.id === 'docker-dangling-volumes');
    expect(vols?.evidence.danglingVolumes).toBe(475);
    expect(vols?.severity).toBe('warning');
    expect(vols?.needsOwnerChoice).toBe(true);
    const db = r.findings.find((f) => f.id === 'docker-long-running-db');
    expect(db?.remedy?.command).toBe('docker rm -f credit-t1716-full-pg17 lead-t1013-native');
    expect(r.findings.find((f) => f.id === 'docker-build-cache')).toBeUndefined();
  });

  it('reports sessions with idle RSS including their MCP servers', async () => {
    const s = assessSystemHealth(await darwinSnapshot()).findings.find((f) => f.id === 'sessions');
    expect(s?.evidence.sessions).toBe(8);
    expect(s?.evidence.idle).toBe(6);
    expect(s?.needsOwnerChoice).toBe(true);
    expect(s?.remedy?.command).toBeNull();
  });

  it('groups sessions per project and judges idle by terminal silence when known (T13438)', async () => {
    const ctx = (project: string, ttyIdleSec: number | null) => ({
      cwd: `${project}/packages/x`,
      project,
      ttyIdleSec,
    });
    const r = assessSystemHealth(
      await darwinSnapshot({
        sessionContext: {
          // busy by CPU but its terminal has been silent 3h: idle
          1000: ctx('/Users/u/projects/axiom', 3 * 3600),
          // quiet CPU but typed into a minute ago: active
          1020: ctx('/Users/u/projects/axiom', 60),
          1030: ctx('/Users/u/projects/cleocode', 7200),
        },
      }),
    );
    const byPid = new Map(r.sessions.map((x) => [x.pid, x]));
    expect(byPid.get(1000)).toMatchObject({ harness: 'claude', idle: true, idleSec: 10800 });
    expect(byPid.get(1020)?.idle).toBe(false);
    expect(byPid.get(1040)).toMatchObject({ project: null, idleSec: null, idle: true });
    // idlest first: known idle times before unknown ones
    expect(r.sessions[0]?.pid).toBe(1000);
    expect(r.sessions[1]?.pid).toBe(1030);
    const f = r.findings.find((x) => x.id === 'sessions');
    expect(f?.evidence.byProject).toEqual(
      expect.arrayContaining([expect.stringMatching(/^axiom: 2 sessions \(1 idle\)/)]),
    );
    expect(f?.evidence.idleSessions).toEqual(
      expect.arrayContaining([expect.stringMatching(/^axiom claude pid 1000 up 26h, idle 3h/)]),
    );
  });

  it('flags indexer CPU, Time Machine and Spotlight on node_modules', async () => {
    const r = assessSystemHealth(await darwinSnapshot());
    expect(r.findings.find((f) => f.id.startsWith('indexing-cpu:mds_stores'))).toBeDefined();
    const tm = r.findings.find((f) => f.id === 'time-machine-node-modules');
    expect(tm?.remedy?.command).toBe("tmutil addexclusion '/Users/u/p/node_modules'");
    expect(tm?.needsOwnerChoice).toBe(true);
    const quoted = assessSystemHealth(
      await darwinSnapshot({
        indexing: {
          projectRoot: "/Users/u/o'brien",
          timeMachine: '[Included] x',
          spotlightCount: '0',
        },
      }),
    ).findings.find((f) => f.id === 'time-machine-node-modules');
    expect(quoted?.remedy?.command).toBe("tmutil addexclusion '/Users/u/o'\\''brien/node_modules'");
    expect(
      r.findings.find((f) => f.id === 'spotlight-node-modules')?.evidence.indexedPackageJson,
    ).toBe(1234);
  });

  it('a calm machine reports nothing for memory, and missing sources are coverage, not health', async () => {
    const r = assessSystemHealth(
      await darwinSnapshot({ sample: null, loadAvg1: 2, ps: null, docker: null, indexing: null }),
    );
    expect(r.findings).toEqual([]);
    const cov = Object.fromEntries(r.coverage.map((c) => [c.check, c.status]));
    expect(cov).toMatchObject({
      memory: 'error',
      'mcp-fanout': 'error',
      containers: 'skipped',
      indexing: 'skipped',
    });
  });
});

describe('assessSystemHealth on Linux', () => {
  it('reads PSI pressure, /proc/meminfo swap and the memory guard', async () => {
    const r = assessSystemHealth(await linuxSnapshot());
    const byId = new Map(r.findings.map((f) => [f.id, f]));
    expect(byId.get('memory-pressure')?.severity).toBe('critical');
    expect(byId.get('swap')?.evidence.swapUsedGib).toBe(15);
    expect(byId.get('memory-guard')?.remedy?.command).toBe('cleo doctor memory-guard --fix');
    expect(byId.get('memory-guard')?.needsOwnerChoice).toBe(true);
    expect(byId.has('cpu-load')).toBe(false);
    expect(
      r.findings.filter((f) => f.category === 'heavy-ungoverned').map((f) => f.evidence.pid),
    ).toEqual([5001]);
    const cov = Object.fromEntries(r.coverage.map((c) => [c.check, c]));
    expect(cov.containers?.status).toBe('skipped');
    expect(cov.indexing?.status).toBe('skipped');
    expect(cov['memory-guard']?.status).toBe('ok');
  });

  it('a guarded machine has no memory-guard finding', async () => {
    const r = assessSystemHealth(
      await linuxSnapshot({ memoryGuard: { ...UNGUARDED, guarded: true } }),
    );
    expect(r.findings.find((f) => f.id === 'memory-guard')).toBeUndefined();
  });
});
