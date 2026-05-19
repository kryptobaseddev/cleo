/**
 * Unit tests for `cleo skills doctor adopt-orphans` (T9657).
 *
 * Covers:
 *  - orphan discovery (on-disk dirs not in skills.db)
 *  - non-interactive mode → list-only, zero side effects
 *  - --auto-user-adopt → bulk insert with source_type='user'
 *  - canonical-adopt refused on user machine (always)
 *  - delete → archives before remove
 *  - idempotent re-runs (upsert path)
 *  - audit-log JSON envelope
 *
 * @remarks
 * Post-ADR-068 refactor (T9657 follow-up): the caamp module no longer opens
 * `skills.db` itself; the test harness owns the chokepoint-compliant sqlite
 * open via `node:sqlite` (test files are allowlisted by
 * `scripts/lint-no-raw-db-opens.mjs`).
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AdoptedSkillRowData,
  applyDecision,
  discoverOrphans,
  type OrphanRecord,
  type RecordRowFn,
  runDoctorAdopt,
  writeAuditLog,
} from '../../src/commands/skills/doctor-adopt.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS \`skills\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`name\` text NOT NULL,
  \`version\` text,
  \`source_type\` text NOT NULL,
  \`source_url\` text,
  \`install_path\` text NOT NULL,
  \`canonical_path\` text,
  \`installed_at\` text NOT NULL,
  \`last_updated_at\` text,
  \`lifecycle_state\` text DEFAULT 'active' NOT NULL,
  \`pinned\` integer DEFAULT 0 NOT NULL,
  \`is_agent_created\` integer DEFAULT 0 NOT NULL,
  \`archived_at\` text,
  \`archived_from_path\` text,
  CONSTRAINT \`skills_source_type_check\` CHECK (\`source_type\` IN ('canonical','user','community','agent-created')),
  CONSTRAINT \`skills_lifecycle_state_check\` CHECK (\`lifecycle_state\` IN ('active','stale','archived'))
);
CREATE UNIQUE INDEX IF NOT EXISTS \`skills_name_unique\` ON \`skills\` (\`name\`);
`;

interface Sandbox {
  root: string;
  fakeHome: string;
  cleoHome: string;
  cleoSkills: string;
  legacySkills: string;
  homeAgentsSkills: string;
  dbPath: string;
  origHome: string | undefined;
  origCleoHome: string | undefined;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'doctor-adopt-'));
  const fakeHome = join(root, 'home');
  const cleoHome = join(fakeHome, '.local', 'share', 'cleo');
  const cleoSkills = join(fakeHome, '.cleo', 'skills');
  const legacySkills = join(fakeHome, '.local', 'share', 'agents', 'skills');
  const homeAgentsSkills = join(fakeHome, '.agents', 'skills');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(cleoSkills, { recursive: true });
  mkdirSync(legacySkills, { recursive: true });
  mkdirSync(homeAgentsSkills, { recursive: true });

  const dbPath = join(cleoHome, 'skills.db');
  const db = new DatabaseSync(dbPath);
  db.exec(MIGRATION_SQL);
  db.close();

  const sandbox: Sandbox = {
    root,
    fakeHome,
    cleoHome,
    cleoSkills,
    legacySkills,
    homeAgentsSkills,
    dbPath,
    origHome: process.env.HOME,
    origCleoHome: process.env.CLEO_HOME,
  };
  process.env.HOME = fakeHome;
  // Force @cleocode/paths to use our sandboxed cleo home for getCleoHome()
  process.env.CLEO_HOME = cleoHome;
  return sandbox;
}

function teardown(s: Sandbox): void {
  if (s.origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = s.origHome;
  }
  if (s.origCleoHome === undefined) {
    delete process.env.CLEO_HOME;
  } else {
    process.env.CLEO_HOME = s.origCleoHome;
  }
  rmSync(s.root, { recursive: true, force: true });
}

function createSkillDir(parent: string, name: string, withSkillMd: boolean = true): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (withSkillMd) {
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`, 'utf8');
  }
  return dir;
}

function registerSkill(dbPath: string, name: string, installPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO skills (name, source_type, install_path, installed_at)
       VALUES (?, 'user', ?, ?)`,
    ).run(name, installPath, new Date().toISOString());
  } finally {
    db.close();
  }
}

function readSkillsRows(dbPath: string): Array<{
  name: string;
  source_type: string;
  install_path: string;
  lifecycle_state: string;
}> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT name, source_type, install_path, lifecycle_state FROM skills ORDER BY name')
      .all() as Array<{
      name: string;
      source_type: string;
      install_path: string;
      lifecycle_state: string;
    }>;
  } finally {
    db.close();
  }
}

/**
 * Build a sandboxed `loadRegisteredNames` callback that reads from the given
 * sqlite file. Mirrors the production wiring (which would route through
 * `openCleoDb('skills')`) without taking a `@cleocode/core` dep from the
 * caamp test suite.
 */
function makeLoadRegisteredNames(dbPath: string): () => ReadonlySet<string> {
  return (): ReadonlySet<string> => {
    if (!existsSync(dbPath)) return new Set();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skills'")
        .get();
      if (!tableCheck) return new Set();
      const rows = db.prepare('SELECT name FROM skills').all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    } finally {
      db.close();
    }
  };
}

/**
 * Build a sandboxed `recordRow` callback that writes via upsert into the
 * given sqlite file. Mirrors the production wiring (`upsertSkillRow` from
 * `@cleocode/core/store/skills-db`).
 */
function makeRecordRow(dbPath: string): RecordRowFn {
  return (data: AdoptedSkillRowData): void => {
    if (!existsSync(dbPath)) {
      throw new Error(`skills.db not found at ${dbPath}`);
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `INSERT INTO skills (name, source_type, install_path, installed_at, lifecycle_state, pinned, is_agent_created)
         VALUES (?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(name) DO UPDATE SET
           install_path = excluded.install_path,
           lifecycle_state = 'active',
           last_updated_at = excluded.installed_at`,
      ).run(data.name, data.sourceType, data.installPath, data.installedAt, data.lifecycleState);
    } finally {
      db.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skills doctor adopt-orphans', () => {
  let s: Sandbox;
  beforeEach(() => {
    s = makeSandbox();
  });
  afterEach(() => {
    teardown(s);
  });

  describe('discoverOrphans', () => {
    it('identifies skill dirs not present in skills.db', () => {
      createSkillDir(s.cleoSkills, 'orphan-one');
      createSkillDir(s.cleoSkills, 'orphan-two');
      createSkillDir(s.cleoSkills, 'tracked-skill');
      registerSkill(s.dbPath, 'tracked-skill', join(s.cleoSkills, 'tracked-skill'));

      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      const names = orphans.map((o) => o.name).sort();

      expect(names).toEqual(['orphan-one', 'orphan-two']);
      expect(orphans.every((o) => o.discoveredVia === 'cleo')).toBe(true);
      expect(orphans.every((o) => o.hasSkillMd)).toBe(true);
    });

    it('discovers orphans in legacy XDG path', () => {
      createSkillDir(s.legacySkills, 'legacy-orphan');
      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      expect(orphans.map((o) => o.name)).toContain('legacy-orphan');
      expect(orphans.find((o) => o.name === 'legacy-orphan')?.discoveredVia).toBe('legacy-agents');
    });

    it('skips bridge symlinks under ~/.agents/skills/ that resolve into ~/.cleo/skills/', () => {
      // Create a real cleo skill, then a symlink from ~/.agents/skills/ to it.
      createSkillDir(s.cleoSkills, 'shared-skill');
      const bridge = join(s.homeAgentsSkills, 'shared-skill');
      // Use cpSync? No — symlink.
      execSync(`ln -s ${join(s.cleoSkills, 'shared-skill')} ${bridge}`);
      registerSkill(s.dbPath, 'shared-skill', join(s.cleoSkills, 'shared-skill'));

      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      expect(orphans.find((o) => o.name === 'shared-skill')).toBeUndefined();
    });

    it('reports real-dir orphans in ~/.agents/skills/', () => {
      createSkillDir(s.homeAgentsSkills, 'real-dir-orphan');
      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      expect(orphans.find((o) => o.name === 'real-dir-orphan')?.discoveredVia).toBe('home-agents');
    });

    it('skips dotfile sentinel dirs (.archive, .audit-log)', () => {
      mkdirSync(join(s.cleoSkills, '.archive'), { recursive: true });
      mkdirSync(join(s.cleoSkills, '.audit-log'), { recursive: true });
      createSkillDir(s.cleoSkills, 'real-orphan');
      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      expect(orphans.map((o) => o.name)).toEqual(['real-orphan']);
    });

    it('returns empty list when skills.db has no row for any on-disk dir AND no dirs exist', () => {
      const registered = makeLoadRegisteredNames(s.dbPath)();
      const orphans = discoverOrphans(registered);
      expect(orphans).toEqual([]);
    });
  });

  describe('applyDecision', () => {
    function makeOrphan(name: string, parent: string = s.cleoSkills): OrphanRecord {
      const path = createSkillDir(parent, name);
      return {
        name,
        path,
        discoveredVia: 'cleo',
        hasSkillMd: true,
        sizeBytes: 42,
      };
    }

    it('refuses canonical-adopt with E_CANONICAL_ADOPT_REFUSED + PR-flow remediation', async () => {
      const orphan = makeOrphan('would-be-canonical');
      const result = await applyDecision(
        orphan,
        'canonical-adopt',
        new Date().toISOString(),
        makeRecordRow(s.dbPath),
      );

      expect(result.applied).toBe(false);
      expect(result.refusal?.code).toBe('E_CANONICAL_ADOPT_REFUSED');
      expect(result.refusal?.remediation).toMatch(/packages\/skills\/skills\//);
      expect(result.refusal?.remediation).toMatch(/PR/);
      // Directory MUST still exist (no destructive side-effect).
      expect(existsSync(orphan.path)).toBe(true);
      // No row inserted.
      const rows = readSkillsRows(s.dbPath);
      expect(rows.find((r) => r.name === 'would-be-canonical')).toBeUndefined();
    });

    it('user-adopt inserts a source_type=user row in skills.db', async () => {
      const orphan = makeOrphan('my-user-skill');
      const now = new Date().toISOString();
      const result = await applyDecision(orphan, 'user-adopt', now, makeRecordRow(s.dbPath));

      expect(result.applied).toBe(true);
      expect(result.refusal).toBeNull();
      const rows = readSkillsRows(s.dbPath);
      const row = rows.find((r) => r.name === 'my-user-skill');
      expect(row).toBeDefined();
      expect(row?.source_type).toBe('user');
      expect(row?.lifecycle_state).toBe('active');
      expect(row?.install_path).toBe(orphan.path);
    });

    it('user-adopt is idempotent across repeat invocations (upsert)', async () => {
      const orphan = makeOrphan('idempotent-skill');
      const recordRow = makeRecordRow(s.dbPath);
      await applyDecision(orphan, 'user-adopt', new Date().toISOString(), recordRow);
      await applyDecision(orphan, 'user-adopt', new Date().toISOString(), recordRow);
      const rows = readSkillsRows(s.dbPath);
      const matches = rows.filter((r) => r.name === 'idempotent-skill');
      expect(matches).toHaveLength(1);
    });

    it('delete archives the dir before removing the original', async () => {
      const orphan = makeOrphan('to-be-deleted');
      const result = await applyDecision(
        orphan,
        'delete',
        new Date().toISOString(),
        makeRecordRow(s.dbPath),
      );

      expect(result.applied).toBe(true);
      expect(result.archivedTo).toBeTruthy();
      expect(result.archivedTo).toMatch(/\.archive\/to-be-deleted-/);
      if (!result.archivedTo) throw new Error('archive path missing');
      // Archive exists with original SKILL.md content.
      expect(existsSync(result.archivedTo)).toBe(true);
      expect(existsSync(join(result.archivedTo, 'SKILL.md'))).toBe(true);
      const archivedMd = readFileSync(join(result.archivedTo, 'SKILL.md'), 'utf8');
      expect(archivedMd).toContain('to-be-deleted');
      // Original removed.
      expect(existsSync(orphan.path)).toBe(false);
    });

    it('skip is a true no-op', async () => {
      const orphan = makeOrphan('untouched');
      const result = await applyDecision(
        orphan,
        'skip',
        new Date().toISOString(),
        makeRecordRow(s.dbPath),
      );
      expect(result.applied).toBe(true);
      expect(result.refusal).toBeNull();
      expect(result.archivedTo).toBeNull();
      expect(existsSync(orphan.path)).toBe(true);
      const rows = readSkillsRows(s.dbPath);
      expect(rows.find((r) => r.name === 'untouched')).toBeUndefined();
    });
  });

  describe('runDoctorAdopt', () => {
    it('--non-interactive lists orphans without action', async () => {
      createSkillDir(s.cleoSkills, 'a-orphan');
      createSkillDir(s.cleoSkills, 'b-orphan');

      const result = await runDoctorAdopt({
        nonInteractive: true,
        loadRegisteredNames: makeLoadRegisteredNames(s.dbPath),
        recordRow: makeRecordRow(s.dbPath),
      });

      expect(result.mode).toBe('non-interactive');
      expect(result.totalOrphans).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.decision === 'skip')).toBe(true);
      expect(result.results.every((r) => r.applied)).toBe(true);
      // No rows inserted, dirs intact.
      expect(readSkillsRows(s.dbPath)).toHaveLength(0);
      expect(existsSync(join(s.cleoSkills, 'a-orphan'))).toBe(true);
      expect(existsSync(join(s.cleoSkills, 'b-orphan'))).toBe(true);
    });

    it('--auto-user-adopt bulk-adopts all orphans', async () => {
      createSkillDir(s.cleoSkills, 'auto-one');
      createSkillDir(s.cleoSkills, 'auto-two');
      createSkillDir(s.cleoSkills, 'auto-three');

      const result = await runDoctorAdopt({
        autoUserAdopt: true,
        loadRegisteredNames: makeLoadRegisteredNames(s.dbPath),
        recordRow: makeRecordRow(s.dbPath),
      });

      expect(result.mode).toBe('auto-user-adopt');
      expect(result.totalOrphans).toBe(3);
      expect(result.results.every((r) => r.applied)).toBe(true);
      expect(result.results.every((r) => r.decision === 'user-adopt')).toBe(true);

      const rows = readSkillsRows(s.dbPath);
      expect(rows.map((r) => r.name).sort()).toEqual(['auto-one', 'auto-three', 'auto-two']);
      expect(rows.every((r) => r.source_type === 'user')).toBe(true);
    });

    it('writes an audit log under ~/.cleo/skills/.audit-log/', async () => {
      createSkillDir(s.cleoSkills, 'log-me');
      const result = await runDoctorAdopt({
        autoUserAdopt: true,
        loadRegisteredNames: makeLoadRegisteredNames(s.dbPath),
        recordRow: makeRecordRow(s.dbPath),
      });

      expect(result.auditLogPath).toBeTruthy();
      expect(result.auditLogPath.startsWith(join(s.cleoSkills, '.audit-log'))).toBe(true);
      expect(existsSync(result.auditLogPath)).toBe(true);

      const logged = JSON.parse(readFileSync(result.auditLogPath, 'utf8')) as {
        runId: string;
        writtenAt: string;
        totalOrphans: number;
        results: Array<{ orphan: { name: string }; decision: string; applied: boolean }>;
        mode: string;
      };
      expect(typeof logged.runId).toBe('string');
      expect(typeof logged.writtenAt).toBe('string');
      expect(logged.totalOrphans).toBe(1);
      expect(logged.mode).toBe('auto-user-adopt');
      expect(logged.results[0]?.orphan.name).toBe('log-me');
      expect(logged.results[0]?.applied).toBe(true);
    });

    it('produces a zero-orphan result when nothing is on disk', async () => {
      const result = await runDoctorAdopt({
        nonInteractive: true,
        loadRegisteredNames: makeLoadRegisteredNames(s.dbPath),
        recordRow: makeRecordRow(s.dbPath),
      });
      expect(result.totalOrphans).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('interactive mode threads injected prompt through every orphan', async () => {
      createSkillDir(s.cleoSkills, 'prompt-a');
      createSkillDir(s.cleoSkills, 'prompt-b');
      createSkillDir(s.cleoSkills, 'prompt-c');

      const seen: string[] = [];
      const result = await runDoctorAdopt({
        loadRegisteredNames: makeLoadRegisteredNames(s.dbPath),
        recordRow: makeRecordRow(s.dbPath),
        prompt: async (orphan) => {
          seen.push(orphan.name);
          if (orphan.name === 'prompt-a') return 'user-adopt';
          if (orphan.name === 'prompt-b') return 'canonical-adopt';
          return 'skip';
        },
      });

      expect(seen.sort()).toEqual(['prompt-a', 'prompt-b', 'prompt-c']);
      expect(result.mode).toBe('interactive');

      const aResult = result.results.find((r) => r.orphan.name === 'prompt-a');
      const bResult = result.results.find((r) => r.orphan.name === 'prompt-b');
      const cResult = result.results.find((r) => r.orphan.name === 'prompt-c');

      expect(aResult?.decision).toBe('user-adopt');
      expect(aResult?.applied).toBe(true);
      expect(bResult?.decision).toBe('canonical-adopt');
      expect(bResult?.applied).toBe(false);
      expect(bResult?.refusal?.code).toBe('E_CANONICAL_ADOPT_REFUSED');
      expect(cResult?.decision).toBe('skip');
    });
  });

  describe('writeAuditLog', () => {
    it('writes structured JSON with runId + writtenAt', () => {
      const orphans: OrphanRecord[] = [
        {
          name: 'standalone',
          path: '/tmp/standalone',
          discoveredVia: 'cleo',
          hasSkillMd: true,
          sizeBytes: 100,
        },
      ];
      const path = writeAuditLog({
        totalOrphans: 1,
        results: [
          {
            orphan: orphans[0]!,
            decision: 'skip',
            applied: true,
            refusal: null,
            archivedTo: null,
            decidedAt: new Date().toISOString(),
          },
        ],
        auditLogPath: '',
        mode: 'non-interactive',
      });

      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        runId: string;
        writtenAt: string;
        results: unknown[];
      };
      expect(parsed.runId).toMatch(/[0-9a-f-]{36}/);
      expect(typeof parsed.writtenAt).toBe('string');
      expect(parsed.results).toHaveLength(1);

      // Verify atomic write — no .tmp leftover
      const dir = join(s.cleoSkills, '.audit-log');
      const tmpLeft = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
      expect(tmpLeft).toHaveLength(0);
    });
  });
});
