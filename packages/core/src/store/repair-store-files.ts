/** File operations for recovery: originals are read only until a single atomic commit. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import type { StoreRepairFile } from '@cleocode/contracts/db-recovery.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';

/** SQLite sidecars whose exact original bytes belong in quarantine. */
export const REPAIR_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

/** Hash a file without holding the entire store in memory. */
export function repairFileHash(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Flush a file or its containing directory before publishing a name. */
export function repairFsync(file: string): void {
  const fd = openSync(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copy and verify originals without opening them through SQLite or reusing a destination. */
export function copyRepairOriginals(from: string, to: string, sidecars = true): StoreRepairFile[] {
  const files: StoreRepairFile[] = [];
  for (const suffix of sidecars ? REPAIR_SIDECARS : ['']) {
    if (!existsSync(from + suffix)) continue;
    const before = repairFileHash(from + suffix);
    copyFileSync(from + suffix, to + suffix, constants.COPYFILE_EXCL);
    repairFsync(to + suffix);
    if (before !== repairFileHash(to + suffix) || before !== repairFileHash(from + suffix)) {
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`Store changed while copying ${from + suffix}; repair refused`);
    }
    files.push({
      name: basename(from + suffix),
      sha256: before,
      bytes: statSync(from + suffix).size,
    });
  }
  return files;
}

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

/**
 * Prove quiescence without opening the damaged SQLite file. A normal lock
 * probe can checkpoint or delete a live WAL on close, destroying evidence.
 * The first-open lock and restore marker exclude racing CLEO opens; this
 * check also refuses pre-existing SQLite handles, including this process's.
 */
export function assertRepairQuiescent(target: string): void {
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
        // @sync-invariant none:local-only a kernel lock excludes replacement of the local store
        throw new Error('Another connection holds a kernel lock on the store');
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
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error(`Cannot inspect open store handles for pid ${pid}`);
      }
      for (const descriptor of descriptors) {
        try {
          const identity = linuxLockIdentity(`/proc/${pid}/fd/${descriptor}`);
          // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
          if (inodes.has(identity)) throw new Error(`Store is open in pid ${pid}`);
        } catch (error) {
          if (error instanceof Error && /Store is open/.test(error.message)) throw error;
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
    }
    return;
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
    return;
  }
  const probe = spawnSync('lsof', ['-F', 'p', '--', ...paths], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (probe.error || (probe.status !== 0 && probe.status !== 1) || probe.stderr.trim()) {
    // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
    throw new Error(`Cannot prove the store is closed: ${probe.error?.message ?? probe.stderr}`);
  }
  // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
  if (probe.stdout.trim()) throw new Error(`Store is open: ${probe.stdout.trim()}`);
}

/**
 * Build an installable, full-image WAL with SQLite itself. VACUUM in WAL mode
 * writes every output page in one transaction. Publishing that WAL is ONE
 * rename: there is no interval with a missing original WAL or an old WAL
 * overlaying a new main file. A subsequent ordinary checkpoint folds it in.
 */
export function prepareRepairCommit(staged: string, original: string, candidate: string): void {
  const snap = openCleoDbSnapshot(staged, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    snap.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    const fd = openSync(original, 'r');
    const header = Buffer.alloc(100);
    try {
      readSync(fd, header, 0, 100, 0);
    } finally {
      closeSync(fd);
    }
    const rawSize = header.readUInt16BE(16);
    const size = rawSize === 1 ? 65536 : rawSize;
    if (size < 512 || size > 65536 || (size & (size - 1)) !== 0)
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error('Damaged SQLite page size; cannot commit a WAL safely');
    snap.db.exec(
      `PRAGMA page_size=${size}; VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; VACUUM`,
    );
    copyFileSync(`${staged}-wal`, candidate, constants.COPYFILE_EXCL);
    repairFsync(candidate);
    // Check the full-image property, rather than depending only on VACUUM's implementation.
    const walFd = openSync(candidate, 'r');
    try {
      const header = Buffer.alloc(32);
      readSync(walFd, header, 0, 32, 0);
      const frameSize = header.readUInt32BE(8) + 24;
      const n = (statSync(candidate).size - 32) / frameSize;
      const pages = new Set<number>();
      const frame = Buffer.alloc(24);
      let last = 0;
      for (let i = 0; i < n; i++) {
        readSync(walFd, frame, 0, 24, 32 + i * frameSize);
        pages.add(frame.readUInt32BE(0));
        last = frame.readUInt32BE(4);
      }
      if (
        !Number.isInteger(n) ||
        last < 1 ||
        pages.size !== last ||
        !pages.has(1) ||
        !pages.has(last) ||
        [...pages].some((page) => page < 1 || page > last)
      ) {
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

/** Atomically publish an already-validated full-image WAL, preserving the original main file. */
export function commitRepairWal(candidate: string, target: string): void {
  if (process.platform !== 'win32') repairFsync(dirname(candidate));
  renameSync(candidate, `${target}-wal`);
}
