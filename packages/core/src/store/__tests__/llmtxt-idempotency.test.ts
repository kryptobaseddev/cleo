/**
 * `llmtxt` DB role idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * The canonical DB inventory (`packages/core/src/store/db-inventory.json`)
 * registers `llmtxt` as a **reserved** role at
 * `<projectRoot>/.cleo/llmtxt/llmtxt.db` whose opener
 * (`openCleoDb('llmtxt', cwd)`) currently throws
 * `"CLEO DB role llmtxt is not yet implemented"` (see
 * `packages/core/src/store/open-cleo-db.ts:138`). Until the llmtxt-core
 * package wires a live opener under this role, the idempotency contract
 * for the role is the *error-stability* contract:
 *
 *   1. Calling `openCleoDb('llmtxt')` MUST throw a recognisable error
 *      every single time — never partially succeed and never leave
 *      stray file descriptors or DB files on disk.
 *   2. Repeated invocations MUST throw the SAME error message — no
 *      drift across calls, no nondeterminism that could leak through
 *      to a caller relying on `catch (err)` and message-matching.
 *   3. No `.cleo/llmtxt/` directory is materialised as a side-effect
 *      of the failed open — the disk state observed before and after
 *      the throw is identical.
 *
 * When the live llmtxt opener lands (tracked outside this task), this
 * test is the canonical place to flip from "rejects identically" to
 * "opens idempotently across two cycles + does not duplicate rows on
 * identical writes."
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory.
 *
 * Cross-link: ADR-013 §9 — once live, the llmtxt DB joins tasks.db,
 * brain.db, manifest.db, and conduit.db as a runtime-data SQLite file
 * excluded from git tracking. This test pins the reopen invariant
 * forward-compatibly.
 *
 * @task T10314
 * @epic T10283
 * @saga T10281
 * @adr ADR-013
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCleoDb } from '../open-cleo-db.js';

describe('llmtxt DB role idempotency contract (T10314)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-llmtxt-idempotency-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('openCleoDb("llmtxt") throws the canonical "not yet implemented" error', async () => {
    await expect(openCleoDb('llmtxt', tempDir)).rejects.toThrow(/llmtxt is not yet implemented/);
  });

  it('repeated openCleoDb("llmtxt") calls throw identical messages (no drift)', async () => {
    let firstMessage: string | undefined;
    let secondMessage: string | undefined;

    try {
      await openCleoDb('llmtxt', tempDir);
    } catch (err) {
      firstMessage = err instanceof Error ? err.message : String(err);
    }

    try {
      await openCleoDb('llmtxt', tempDir);
    } catch (err) {
      secondMessage = err instanceof Error ? err.message : String(err);
    }

    expect(firstMessage).toBeDefined();
    expect(secondMessage).toBeDefined();
    expect(secondMessage).toBe(firstMessage);
  });

  it('no .cleo/llmtxt/ directory is materialised by a failed open', async () => {
    const llmtxtDir = join(tempDir, '.cleo', 'llmtxt');
    expect(existsSync(llmtxtDir)).toBe(false);

    await expect(openCleoDb('llmtxt', tempDir)).rejects.toThrow();

    // Disk state must be unchanged after the throw — failed open is
    // forbidden to leak filesystem side-effects.
    expect(existsSync(llmtxtDir)).toBe(false);
  });
});
