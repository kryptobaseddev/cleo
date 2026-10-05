/**
 * The admission ledger across REAL processes (T13133): 20 concurrent
 * admitters, no lost update, no deadlock, never over budget.
 *
 * In one process the ledger's read-decide-write is synchronous between
 * awaits, so in-process concurrency cannot lose an update with or without the
 * lock. The property that matters is cross-process: 20 separate processes,
 * released together from a start barrier, each admit, hold and release
 * through the COMPILED module (`packages/core/dist/`; build first), five times
 * each. Each logs the moment it was admitted and the moment it released, and
 * checks while it holds that its entry is still in the ledger. No admitted
 * entry may ever go missing (a lost update), at no instant may more runs be
 * admitted than the budget holds, every process must finish, and the ledger
 * must end empty.
 *
 * @task T13133
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_DIST = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'dist',
  'resources',
  'admission-ledger.js',
);

/**
 * This test exercises the COMPILED module. Without a build there is nothing
 * to spawn, so it is skipped with this reason rather than failing on a
 * missing file. CI builds before testing.
 */
const DIST_MISSING = !existsSync(LEDGER_DIST);
if (DIST_MISSING) {
  process.stderr.write(
    'admission-ledger-multiprocess: SKIPPED — packages/core/dist is not built ' +
      '(run `pnpm --filter @cleocode/core run build`).\n',
  );
}

const ADMITTERS = 20;
const GIB = 1024 ** 3;

/** Admissions per child: enough concurrent read-decide-writes that a missing lock shows. */
const CYCLES = 5;

/** One child: wait for the barrier, then CYCLES times admit 1 GiB of a 3 GiB budget, hold, release. */
function childScript(index: number): string {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(process.env.READY_DIR, String(process.pid)), '');
    const tick = (res) => (fs.existsSync(process.env.GO_FILE) ? res() : setTimeout(() => tick(res), 2));
    const log = (line) => fs.appendFileSync(process.env.LOG, line + ' ' + process.hrtime.bigint() + '\\n');
    new Promise(tick).then(async () => {
      const { admit } = await import(${JSON.stringify(pathToFileURL(LEDGER_DIST).href)});
      for (let c = 0; c < ${CYCLES}; c++) {
        const out = await admit(
          { label: 'tool:t${index}', footprintBytes: ${GIB}, command: 't${index}', cwd: null },
          {
            wait: true,
            timeoutMs: 60000,
            pollMs: 5,
            capacityBytes: ${3 * GIB},
            dir: process.env.LEDGER_DIR,
            env: {},
            sample: async () => { throw new Error('no pressure signal in this test'); },
          },
        );
        if (!out.admitted) { console.error('refused: ' + out.refusal.reason); process.exit(3); }
        log('in ${index}');
        // A lost update shows as an admitted run missing from the ledger.
        const present = () => JSON.parse(fs.readFileSync(path.join(process.env.LEDGER_DIR, 'ledger.json'), 'utf-8'))
          .entries.some((e) => e.id === out.grant.id && e.state === 'admitted');
        for (let n = 0; n < 3; n++) {
          if (!present()) log('lost ${index}');
          await new Promise((r) => setTimeout(r, 3 + ${index % 4} * 3));
        }
        log('out ${index}');
        await out.grant.release();
      }
      process.exit(0);
    }).catch((err) => { console.error(String(err && err.stack || err)); process.exit(4); });
  `;
}

describe.skipIf(DIST_MISSING)('admission ledger — 20 real processes (T13133)', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'cleo-ledger-mp-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('no lost update, no deadlock, never more admitted than the budget holds', async () => {
    const readyDir = join(work, 'ready');
    const goFile = join(work, 'go');
    const log = join(work, 'log');
    const ledgerDir = join(work, 'admission');
    mkdirSync(readyDir, { recursive: true });
    writeFileSync(log, '');
    const children: ChildProcess[] = [];
    const exits = Array.from(
      { length: ADMITTERS },
      (_, i) =>
        new Promise<{ code: number | null; stderr: string }>((res) => {
          const child = spawn(process.execPath, ['-e', childScript(i)], {
            cwd: work,
            env: {
              ...process.env,
              READY_DIR: readyDir,
              GO_FILE: goFile,
              LOG: log,
              LEDGER_DIR: ledgerDir,
              CLEO_HOME: join(work, 'home'),
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          children.push(child);
          let stderr = '';
          child.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          child.on('close', (code) => res({ code, stderr }));
        }),
    );
    const deadline = Date.now() + 60_000;
    while (readdirSync(readyDir).length < ADMITTERS) {
      if (Date.now() > deadline) {
        for (const c of children) c.kill();
        throw new Error('children never became ready');
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(goFile, '');
    const outcomes = await Promise.all(exits);

    expect(outcomes.filter((o) => o.code !== 0).map((o) => o.stderr)).toEqual([]);
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    // No admitted run ever went missing from the ledger: no lost update.
    expect(lines.filter((l) => l.startsWith('lost '))).toEqual([]);
    // Replay admissions and releases in time order: never more than 3 at once.
    const events = lines
      .filter((l) => !l.startsWith('lost '))
      .map((l) => {
        const [kind, , at] = l.split(' ');
        return { kind, at: BigInt(at ?? '0') };
      })
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === 'out' ? -1 : 1));
    let running = 0;
    let peak = 0;
    for (const e of events) {
      running += e.kind === 'in' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(events.filter((e) => e.kind === 'in')).toHaveLength(ADMITTERS * CYCLES);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    const ledger = JSON.parse(readFileSync(join(ledgerDir, 'ledger.json'), 'utf-8')) as {
      entries: unknown[];
    };
    expect(ledger.entries).toEqual([]);
  }, 120_000);

  it("re-entrancy across real processes: a holder's descendant rides its grant (even with a scrubbed env); a stranger waits", async () => {
    const ledgerDir = join(work, 'admission');
    const url = JSON.stringify(pathToFileURL(LEDGER_DIST).href);
    const opts = `{ wait: false, capacityBytes: ${3 * GIB}, dir: process.env.LEDGER_DIR, sample: async () => { throw new Error('none'); } }`;
    // The holder takes the whole budget, then runs a child with an EMPTY env
    // (no CLEO_ADMISSION: a wrapper that scrubbed it) that asks again.
    const holder = `
      const { execFileSync } = require('node:child_process');
      import(${url}).then(async ({ admit }) => {
        const out = await admit({ label: 'run:test-run', footprintBytes: ${3 * GIB}, command: 'holder', cwd: null }, { ...${opts}, env: {} });
        if (!out.admitted) { console.log('HOLDER-REFUSED'); process.exit(3); }
        const child = \`import(\${JSON.stringify(${url})}).then(async ({ admit }) => {
          const r = await admit({ label: 'tool:test', footprintBytes: ${GIB}, command: 'child', cwd: null },
            { wait: false, capacityBytes: ${3 * GIB}, dir: \${JSON.stringify(process.env.LEDGER_DIR)}, env: {}, sample: async () => { throw new Error('none'); } });
          console.log(r.admitted && r.grant.nested ? 'CHILD-NESTED' : 'CHILD-NOT-NESTED');
        });\`;
        process.stdout.write(execFileSync(process.execPath, ['-e', child], { env: {}, encoding: 'utf-8' }));
        // A stranger (spawned by the test, not by the holder) is refused meanwhile.
        require('node:fs').writeFileSync(process.env.HELD, '');
        await new Promise((r) => { const t = () => (require('node:fs').existsSync(process.env.DONE) ? r() : setTimeout(t, 10)); t(); });
        await out.grant.release();
      });
    `;
    const held = join(work, 'held');
    const done = join(work, 'done');
    const env = { ...process.env, LEDGER_DIR: ledgerDir, HELD: held, DONE: done };
    let holderOut = '';
    const holderExit = new Promise<number | null>((res) => {
      const child = spawn(process.execPath, ['-e', holder], {
        cwd: work,
        env,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      child.stdout?.on('data', (d: Buffer) => {
        holderOut += d.toString();
      });
      child.on('close', res);
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(held) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const stranger = await new Promise<string>((res) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `import(${url}).then(async ({ admit }) => { const r = await admit({ label: 'tool:test', footprintBytes: ${GIB}, command: 'stranger', cwd: null }, { ...${opts}, env: {} }); console.log(r.admitted ? 'STRANGER-ADMITTED' : 'STRANGER-REFUSED'); });`,
        ],
        { cwd: work, env, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let out = '';
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.on('close', () => res(out));
    });
    writeFileSync(done, '');
    expect(await holderExit).toBe(0);
    expect(holderOut).toContain('CHILD-NESTED');
    expect(stranger).toContain('STRANGER-REFUSED');
  }, 60_000);
});
