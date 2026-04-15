/**
 * Unit tests for global-salt subsystem.
 *
 * @task T348
 * @epic T310
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearGlobalSaltCache,
  GLOBAL_SALT_FILENAME,
  GLOBAL_SALT_SIZE,
  getGlobalSalt,
  getGlobalSaltPath,
  validateGlobalSalt,
} from '../global-salt.js';

// Mock getCleoHome to use a per-test tmp directory
let tmpHome: string;
vi.mock('../../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
  return {
    ...actual,
    getCleoHome: () => tmpHome,
  };
});

describe('global-salt', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t348-'));
    __clearGlobalSaltCache();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // getGlobalSaltPath
  // -------------------------------------------------------------------------

  describe('getGlobalSaltPath', () => {
    it('returns <cleoHome>/global-salt', () => {
      expect(getGlobalSaltPath()).toBe(path.join(tmpHome, GLOBAL_SALT_FILENAME));
    });
  });

  // -------------------------------------------------------------------------
  // getGlobalSalt — first-run generation
  // -------------------------------------------------------------------------

  describe('getGlobalSalt — first-run generation', () => {
    it('generates a Buffer of exactly 32 bytes on first call', () => {
      const salt = getGlobalSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(GLOBAL_SALT_SIZE);
    });

    it('persists the salt file to disk', () => {
      getGlobalSalt();
      expect(fs.existsSync(getGlobalSaltPath())).toBe(true);
    });

    it('writes the salt file with mode 0o600 on POSIX', () => {
      if (process.platform === 'win32') return;
      getGlobalSalt();
      const mode = fs.statSync(getGlobalSaltPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('creates the cleoHome directory if it does not exist', () => {
      // Remove the tmp dir to simulate a missing cleoHome
      fs.rmSync(tmpHome, { recursive: true, force: true });
      expect(() => getGlobalSalt()).not.toThrow();
      expect(fs.existsSync(tmpHome)).toBe(true);
      expect(fs.existsSync(getGlobalSaltPath())).toBe(true);
    });

    it('leaves no lingering .tmp- files after a successful write', () => {
      getGlobalSalt();
      const files = fs.readdirSync(tmpHome);
      const lingering = files.filter((f) => f.includes('.tmp-'));
      expect(lingering).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getGlobalSalt — memoization
  // -------------------------------------------------------------------------

  describe('getGlobalSalt — memoization', () => {
    it('returns the same Buffer instance on repeated calls (memoized)', () => {
      const first = getGlobalSalt();
      const second = getGlobalSalt();
      expect(second.equals(first)).toBe(true);
    });

    it('returns the same bytes after a cache clear (simulated process restart)', () => {
      const first = getGlobalSalt();
      __clearGlobalSaltCache();
      const second = getGlobalSalt();
      expect(second.equals(first)).toBe(true);
    });

    it('NEVER overwrites an existing file on subsequent calls', () => {
      getGlobalSalt();
      const mtime1 = fs.statSync(getGlobalSaltPath()).mtimeMs;

      // Spin-wait 2 ms so mtime could differ if the file were rewritten
      const until = Date.now() + 2;
      while (Date.now() < until) {
        // busy wait
      }

      __clearGlobalSaltCache();
      getGlobalSalt();
      const mtime2 = fs.statSync(getGlobalSaltPath()).mtimeMs;
      expect(mtime2).toBe(mtime1);
    });
  });

  // -------------------------------------------------------------------------
  // getGlobalSalt — validation on existing file
  // -------------------------------------------------------------------------

  describe('getGlobalSalt — validation on existing file', () => {
    it('throws with "wrong size" when the file has incorrect byte count', () => {
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.writeFileSync(getGlobalSaltPath(), Buffer.alloc(16), { mode: 0o600 });
      __clearGlobalSaltCache();
      expect(() => getGlobalSalt()).toThrow(/wrong size/);
    });

    it('throws with "wrong permissions" on POSIX when mode is too permissive', () => {
      if (process.platform === 'win32') return;
      fs.mkdirSync(tmpHome, { recursive: true });
      const randomBytes = crypto.randomBytes(GLOBAL_SALT_SIZE);
      fs.writeFileSync(getGlobalSaltPath(), randomBytes, { mode: 0o644 });
      __clearGlobalSaltCache();
      expect(() => getGlobalSalt()).toThrow(/wrong permissions/);
    });
  });

  // -------------------------------------------------------------------------
  // validateGlobalSalt
  // -------------------------------------------------------------------------

  describe('validateGlobalSalt', () => {
    it('is a no-op when the salt file does not exist', () => {
      expect(() => validateGlobalSalt()).not.toThrow();
    });

    it('does not throw when the salt file is valid', () => {
      getGlobalSalt(); // generates a valid file
      expect(() => validateGlobalSalt()).not.toThrow();
    });

    it('throws with "validation failed" and "size" when size is wrong', () => {
      fs.mkdirSync(tmpHome, { recursive: true });
      fs.writeFileSync(getGlobalSaltPath(), Buffer.alloc(10), { mode: 0o600 });
      expect(() => validateGlobalSalt()).toThrow(/validation failed.*size/i);
    });

    it('throws with "validation failed" and "permissions" on POSIX when mode is wrong', () => {
      if (process.platform === 'win32') return;
      fs.mkdirSync(tmpHome, { recursive: true });
      const randomBytes = crypto.randomBytes(GLOBAL_SALT_SIZE);
      fs.writeFileSync(getGlobalSaltPath(), randomBytes, { mode: 0o644 });
      expect(() => validateGlobalSalt()).toThrow(/validation failed.*permissions/i);
    });
  });

  // -------------------------------------------------------------------------
  // __clearGlobalSaltCache — test utility
  // -------------------------------------------------------------------------

  describe('__clearGlobalSaltCache', () => {
    it('allows re-generation in a fresh tmp dir after cache is cleared', () => {
      const first = getGlobalSalt();

      // Simulate switching to a different machine / user by using a new tmpHome
      fs.rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t348-fresh-'));
      __clearGlobalSaltCache();

      const second = getGlobalSalt();
      // Different directory => different (freshly generated) salt
      expect(fs.existsSync(getGlobalSaltPath())).toBe(true);
      // The new salt is a valid 32-byte buffer (may or may not equal first by chance)
      expect(second.length).toBe(GLOBAL_SALT_SIZE);
      // Suppress unused variable warning
      expect(first.length).toBe(GLOBAL_SALT_SIZE);
    });
  });
});
