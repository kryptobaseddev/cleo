/** File operations for recovery: originals are read only until a single atomic commit. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { StoreRepairFile } from '@cleocode/contracts/db-recovery.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { isLocked } from './lock.js';
import {
  copyRepairOriginals,
  openCleoDbSnapshot,
  REPAIR_SIDECARS,
  repairFileHash,
  repairFsync,
} from './open-cleo-db.js';
import { foreignWriterLeases } from './writer-lease.js';

/** Shared snapshot-copy primitives remain available to recovery callers. */
export {
  copyRepairOriginals,
  inspectStoreIntegrity,
  REPAIR_SIDECARS,
  repairFileHash,
  repairFsync,
} from './open-cleo-db.js';

/** Verify that neither an original file nor its sidecar population changed during repair. */
export function assertRepairOriginals(target: string, files: readonly StoreRepairFile[]): void {
  for (const suffix of REPAIR_SIDECARS) {
    const expected = files.find((f) => f.name === basename(target + suffix));
    if (
      existsSync(target + suffix) !== (expected !== undefined) ||
      (expected && repairFileHash(target + suffix) !== expected.sha256)
    ) {
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`Store changed during repair: ${target + suffix}`);
    }
  }
}

/** Linux exposes SQLite's locks across users even when another account's fd directory is private. */
function linuxLockIdentity(file: string): string {
  const { dev, ino } = statSync(file, { bigint: true });
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}:${ino}`;
}

/** A process can expose its fd directory while denying inspection of individual descriptors. */
function skipInaccessibleProcess(pid: string, error: Error, diagnostics: string[]): boolean {
  if (
    Number(pid) === process.pid ||
    !('code' in error) ||
    (error.code !== 'EACCES' && error.code !== 'EPERM')
  )
    return false;
  const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  if (!comm || /^(?:node(?:js)?|cleo|bun|deno|sqlite3?)(?:$|[ .-])/i.test(comm))
    // @sync-invariant none:local-only an uninspectable possible store holder excludes repair
    throw new Error(`Cannot inspect possible store holder pid ${pid} (${comm || 'unnamed'})`);
  const message = `Skipped inaccessible descriptors for non-store process pid ${pid} (${comm})`;
  if (!diagnostics.includes(message)) diagnostics.push(message);
  return true;
}

/** A proven holder, kept separate from failures to inspect handles. */
class StoreHolder extends Error {
  constructor(
    readonly pids: readonly number[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Prove quiescence without SQLite-opening the damaged file. Wait at most 15 seconds
 * for identifiable CLEO processes to finish teardown, rechecking every handle and lock.
 * Persistent holders return E_STORE_IN_USE with their commands and a shutdown fix.
 * The first-open lock and restore marker must remain held throughout the wait.
 */
export async function assertRepairQuiescent(target: string, diagnostics: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  let waited = false;
  for (;;) {
    try {
      await checkRepairQuiescent(target, diagnostics);
      if (waited) diagnostics.push('CLEO store holders exited during the bounded teardown wait');
      return;
    } catch (error) {
      if (!(error instanceof StoreHolder)) throw error;
      const { readProcessArgs } = await import('../sessions/terminal-identity.js');
      const { redactCommandLine } = await import('../resources/run-admission.js');
      const holders = [...new Set(error.pids)].map((pid) => ({
        pid,
        command: readProcessArgs(pid),
      }));
      const cleoOnly =
        holders.length > 0 &&
        holders.every(
          ({ pid, command }) =>
            pid !== process.pid &&
            command !== null &&
            /(?:^|[\\/\s])cleo(?:\.m?js|\.ts)?(?:[\\/\s]|$)/i.test(command),
        );
      // A holder can exit between the kernel probe and ps; require a fresh handle proof.
      const exiting =
        holders.length > 0 &&
        holders.every(({ command }) => command === null || command === '<defunct>');
      if ((cleoOnly || exiting) && Date.now() < deadline) {
        waited = true;
        await setTimeout(Math.min(200, Math.max(1, deadline - Date.now())));
        continue;
      }
      const who = holders
        .map(
          ({ pid, command }) =>
            `pid ${pid} (${command === null ? 'command unavailable' : redactCommandLine(command)})`,
        )
        .join(', ');
      // @sync-invariant none:local-only a proven local store holder prevents publication
      throw new CleoError(
        ExitCode.LOCK_TIMEOUT,
        `E_STORE_IN_USE: ${error.message}${who ? `; ${who}` : ''}`,
        {
          codeName: 'E_STORE_IN_USE',
          fix: `Close ${who || 'the application holding the store lock'} using its owning terminal or normal shutdown so it releases ${target}.`,
          cause: error,
        },
      );
    }
  }
}

/** Check every OS handle before copying lease rows; teardown polling never recopies a large store. */
async function checkRepairLeases(target: string, diagnostics: string[]): Promise<void> {
  // The first-open lock is ours; the ordinary writer lock must be unheld.
  if (await isLocked(target))
    // @sync-invariant none:local-only an existing CLEO writer excludes local store replacement
    throw new StoreHolder([], 'Another CLEO writer holds the store lock');
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-repair-lease-'));
  let held: ReturnType<typeof foreignWriterLeases> = [];
  try {
    const copy = join(scratch, 'lease.db');
    copyRepairOriginals(target, copy);
    try {
      held = foreignWriterLeases(copy);
    } catch (error) {
      // A damaged lease table cannot supersede the kernel and process-handle proof below.
      const message = `Writer lease rows unreadable: ${error instanceof Error ? error.message : String(error)}`;
      if (!diagnostics.includes(message)) diagnostics.push(message);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (held.length)
    // @sync-invariant none:local-only live CLEO lease holders exclude local store replacement
    throw new StoreHolder(
      held.map((h) => h.holderPid),
      `Store has live CLEO writer leases: ${held.map((h) => `pid ${h.holderPid} (${h.lane})`).join(', ')}`,
    );
}

/** Check kernel locks and idle handles without opening any store file with SQLite. */
async function checkRepairQuiescent(target: string, diagnostics: string[]): Promise<void> {
  const paths = REPAIR_SIDECARS.map((s) => target + s).filter(existsSync);
  if (process.platform === 'linux') {
    const inodes = new Set(paths.map(linuxLockIdentity));
    for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
      const m = /\b([0-9a-f]+):([0-9a-f]+):(\d+)\b/i.exec(line);
      if (
        m?.[1] &&
        m[2] &&
        m[3] &&
        inodes.has(`${BigInt(`0x${m[1]}`)}:${BigInt(`0x${m[2]}`)}:${BigInt(m[3])}`)
      ) {
        const pid = Number(/(-?\d+)\s+[0-9a-f]+:[0-9a-f]+:\d+/i.exec(line)?.[1]);
        // @sync-invariant none:local-only a kernel lock excludes publication of a local repair
        throw new StoreHolder(
          pid > 0 ? [pid] : [],
          'Another connection holds a kernel lock on the store',
        );
      }
    }
    const uid = statSync('/proc/self').uid;
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      let descriptors: string[];
      try {
        // Other accounts' SQLite locks were checked above; inspect all of our own idle handles too.
        if (statSync(`/proc/${pid}`).uid !== uid) continue;
        descriptors = readdirSync(`/proc/${pid}/fd`);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        if (error instanceof Error && skipInaccessibleProcess(pid, error, diagnostics)) continue;
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error(`Cannot inspect open store handles for pid ${pid}`);
      }
      for (const descriptor of descriptors) {
        try {
          const identity = linuxLockIdentity(`/proc/${pid}/fd/${descriptor}`);
          if (inodes.has(identity))
            // @sync-invariant none:local-only an idle descriptor excludes publication of a local repair
            throw new StoreHolder([Number(pid)], `Store is open in pid ${pid}`);
        } catch (error) {
          if (error instanceof StoreHolder) throw error;
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          if (error instanceof Error && skipInaccessibleProcess(pid, error, diagnostics)) break;
          throw error;
        }
      }
    }
    return checkRepairLeases(target, diagnostics);
  }
  if (process.platform === 'win32') {
    const script = paths
      .map(
        (p) => `$s=[IO.File]::Open('${p.replaceAll("'", "''")}','Open','Read','None');$s.Dispose()`,
      )
      .join(';');
    const probe = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(`$ErrorActionPreference='Stop';${script}`, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (probe.error || probe.status !== 0)
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`Cannot exclusively open the store: ${probe.error?.message ?? probe.stderr}`);
    return checkRepairLeases(target, diagnostics);
  }
  const probe = spawnSync('/usr/bin/fuser', ['-f', ...paths], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const unexpected = probe.stderr
    .split('\n')
    .filter((line) => line.trim() && !paths.some((path) => line.trim() === `${path}:`));
  if (probe.error || probe.status !== 0 || unexpected.length > 0) {
    // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
    throw new Error(`Cannot prove the store is closed: ${probe.error?.message ?? probe.stderr}`);
  }
  if (probe.stdout.trim()) {
    const pids = [...new Set(probe.stdout.trim().split(/\s+/).map(Number))];
    // @sync-invariant none:local-only proven open descriptors prevent replacing the store
    throw new StoreHolder(
      pids.filter((pid) => Number.isInteger(pid) && pid > 0),
      'Store is open',
    );
  }
  return checkRepairLeases(target, diagnostics);
}

/**
 * Whether a WAL covers every data page of its committed image. SQLite never writes
 * its reserved lock-byte page at 1 GiB (sqlite.org/fileformat2.html#lockbyte).
 * All other pages, including the header and final page, must be present.
 */
export function repairWalCoversPages(
  pages: ReadonlySet<number>,
  last: number,
  pageSize: number,
): boolean {
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0
  )
    return false;
  const lockPage = Math.floor(0x40000000 / pageSize) + 1;
  const reserved = lockPage <= last && !pages.has(lockPage) ? 1 : 0;
  return (
    last >= 1 &&
    pages.size + reserved === last &&
    pages.has(1) &&
    pages.has(last) &&
    [...pages].every((page) => page >= 1 && page <= last)
  );
}

/**
 * Build an installable, full-image WAL with SQLite itself. VACUUM in WAL mode
 * writes every data page in one transaction. Publishing that WAL is ONE
 * rename: there is no interval with a missing original WAL or an old WAL
 * overlaying a new main file. A subsequent ordinary checkpoint folds it in.
 * The WAL supplies page 1 too, so even a destroyed main header is replaced.
 * Its page size comes from the staged image, never from the damaged header.
 */
export function prepareRepairCommit(staged: string, original: string, candidate: string): void {
  const snap = openCleoDbSnapshot(staged, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    snap.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    snap.db.exec('VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; VACUUM');
    copyFileSync(`${staged}-wal`, candidate, constants.COPYFILE_EXCL);
    chmodSync(candidate, statSync(original).mode & 0o777);
    repairFsync(candidate);
    // Check the full-image property, rather than depending only on VACUUM's implementation.
    const walFd = openSync(candidate, 'r');
    try {
      const header = Buffer.alloc(32);
      readSync(walFd, header, 0, 32, 0);
      const pageSize = header.readUInt32BE(8);
      const frameSize = pageSize + 24;
      const n = (statSync(candidate).size - 32) / frameSize;
      const pages = new Set<number>();
      const frame = Buffer.alloc(24);
      let last = 0;
      for (let i = 0; i < n; i++) {
        readSync(walFd, frame, 0, 24, 32 + i * frameSize);
        pages.add(frame.readUInt32BE(0));
        last = frame.readUInt32BE(4);
      }
      if (!Number.isInteger(n) || !repairWalCoversPages(pages, last, pageSize)) {
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error('SQLite did not produce a complete repair WAL');
      }
    } finally {
      closeSync(walFd);
    }
  } finally {
    snap.close();
  }
}

/** Atomically replace the old WAL with the validated complete database image. */
export function commitRepairImage(candidate: string, target: string): void {
  if (process.platform !== 'win32') repairFsync(dirname(candidate));
  renameSync(candidate, `${target}-wal`);
}

/** Restore only a disposable damaged view's header so intact b-trees remain readable. */
export function repairSalvageHeader(view: string, staged: string): string | null {
  const header = Buffer.alloc(100);
  const fd = openSync(view, 'r');
  try {
    readSync(fd, header, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  const rawSize = header.readUInt16BE(16);
  const size = rawSize === 1 ? 65536 : rawSize;
  if (
    header.subarray(0, 16).toString('binary') === 'SQLite format 3\0' &&
    size >= 512 &&
    size <= 65536 &&
    (size & (size - 1)) === 0
  )
    return null;
  const baseline = Buffer.alloc(100);
  const base = openSync(staged, 'r');
  try {
    readSync(base, baseline, 0, 100, 0);
  } finally {
    closeSync(base);
  }
  let pageSize = baseline.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (existsSync(`${view}-wal`)) {
    const wal = openSync(`${view}-wal`, 'r');
    const bytes = Buffer.alloc(12);
    try {
      readSync(wal, bytes, 0, 12, 0);
    } finally {
      closeSync(wal);
    }
    const n = bytes.readUInt32BE(8);
    if (
      (bytes.readUInt32BE(0) & 0xfffffffe) === 0x377f0682 &&
      n >= 512 &&
      n <= 65536 &&
      (n & (n - 1)) === 0
    )
      pageSize = n;
  }
  baseline.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  baseline.writeUInt32BE(Math.floor(statSync(view).size / pageSize), 28);
  baseline.fill(0, 32, 40); // A reconstructed header must never follow a snapshot's freelist.
  const recovered = `${view}.header-recovered`;
  copyRepairOriginals(view, recovered);
  const out = openSync(recovered, 'r+');
  try {
    writeSync(out, baseline, 0, baseline.length, 0);
  } finally {
    closeSync(out);
  }
  return recovered;
}
