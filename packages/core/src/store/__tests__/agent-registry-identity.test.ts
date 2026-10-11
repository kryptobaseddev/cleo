/**
 * Row identity of the global agent registry (T12915, owner decision
 * `t13467-global-secrets-sync-design`): agents are natural on their slug
 * (`agent_id`), and the random text `id` minted per device is a local key that
 * never travels. The junction tables are derived, the legacy catalogs and the
 * better-auth children local-only. Secret columns are captured only as
 * `<changed>` and dropped at seal, so a received agent arrives without them
 * (the four whole-table secret tables stay exempt until T13467).
 *
 * @task T12915
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentSkills } from '../agent-resolver.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { missingRowIdentitySchema, naturalRowUid } from '../row-identity.js';
import { ROW_UID_FILL_FLAG } from '../row-identity-flag.js';
import { rowIdentitySpec } from '../row-identity-registry.js';
import { withApplyFrame } from '../sync/apply/frame.js';
import { captureTableDef, setCaptureEnabled } from '../sync/capture.js';
import { classifyTable } from '../table-classification.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');

let dir: string;
let home: string;

async function open(path: string): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const handle = await openDualScopeDbAtPath('global', path);
  return handle.db.$client as DatabaseSync;
}

function addAgent(db: DatabaseSync, id: string, slug: string): void {
  db.prepare(
    `INSERT INTO agent_registry_agents (id, agent_id, name, created_at, updated_at)
     VALUES (?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
  ).run(id, slug, slug);
}

const agentUid = (db: DatabaseSync, slug: string): string | null =>
  (
    db.prepare('SELECT uid FROM agent_registry_agents WHERE agent_id = ?').get(slug) as
      | { uid: string | null }
      | undefined
  )?.uid ?? null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-agent-identity-'));
  home = join(dir, 'cleo');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('agent registry identity (T12915)', () => {
  it('declares agents natural on the slug with the text id as a local key', () => {
    const spec = rowIdentitySpec('global', 'agent_registry_agents');
    expect(spec?.kind).toBe('natural');
    expect(spec?.key).toEqual(['agent_id']);
    expect(spec?.localKey).toBe('id');
  });

  it('two stores with different local ids derive the same uid for one slug', async () => {
    const path = join(home, 'cleo.db');
    vi.stubEnv(ROW_UID_FILL_FLAG, '0');
    const raw = await open(path);
    addAgent(raw, 'local-id-on-a', 'cleo-dev');
    expect(agentUid(raw, 'cleo-dev')).toBeNull();
    vi.stubEnv(ROW_UID_FILL_FLAG, '1');
    const atOpen = agentUid(await open(path), 'cleo-dev');
    _resetDualScopeDbCache();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const b = await open(path);
    addAgent(b, 'another-id-on-b', 'cleo-dev');
    expect(atOpen).toBe(naturalRowUid('global', 'agent_registry_agents', ['cleo-dev']));
    expect(agentUid(b, 'cleo-dev')).toBe(atOpen);
  });

  it('has a unique uid index, and an old store is healed at open, then filled', async () => {
    const path = join(home, 'cleo.db');
    const db = await open(path);
    addAgent(db, 'id-1', 'cleo-dev');
    expect(() => db.exec("UPDATE agent_registry_agents SET uid = 'x'")).not.toThrow();
    addAgent(db, 'id-2', 'cleo-lead');
    expect(() =>
      db.exec("UPDATE agent_registry_agents SET uid = 'x' WHERE agent_id = 'cleo-lead'"),
    ).toThrow(/UNIQUE/);
    db.exec('DROP TRIGGER IF EXISTS temp."trg_row_uid_agent_registry_agents"');
    db.exec('DROP INDEX IF EXISTS main."uq_agent_registry_agents_uid"');
    db.exec('ALTER TABLE main.agent_registry_agents DROP COLUMN uid');
    expect(missingRowIdentitySchema(db, 'global')).toContain('index uq_agent_registry_agents_uid');
    const healed = await open(path);
    expect(missingRowIdentitySchema(healed, 'global')).toEqual([]);
    expect(agentUid(healed, 'cleo-lead')).toBe(
      naturalRowUid('global', 'agent_registry_agents', ['cleo-lead']),
    );
  });

  it('reclassifies the junctions as derived and the catalogs and better-auth children local-only', () => {
    const cls = (t: string) => {
      const r = classifyTable('global', t);
      return r.kind === 'entry' ? r.class : r.kind;
    };
    expect(cls('agent_registry_agent_capabilities')).toBe('derived');
    expect(cls('agent_registry_agent_skills')).toBe('derived');
    for (const t of [
      'agent_registry_capabilities',
      'agent_registry_skills',
      'agent_registry_accounts',
      'agent_registry_org_agent_keys',
    ]) {
      expect(cls(t), t).toBe('local-only');
    }
  });

  it('a received agent gets its uid as its local id, which never travels', async () => {
    const db = await open(join(home, 'cleo.db'));
    setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
    const uid = naturalRowUid('global', 'agent_registry_agents', ['cleo-remote']);
    withApplyFrame(db, 'global', null, (api) => {
      api.insertRow('agent_registry_agents', uid, {
        agent_id: 'cleo-remote',
        name: 'remote',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      });
    });
    expect(
      db.prepare("SELECT id, uid FROM agent_registry_agents WHERE agent_id = 'cleo-remote'").get(),
    ).toEqual({ id: uid, uid });
  });

  it('a received agent resolves its skills; a local cant skill survives a received change (T13519)', async () => {
    const db = await open(join(home, 'cleo.db'));
    const catalog = (table: string, slug: string): void => {
      db.prepare(
        `INSERT INTO ${table} (id, slug, name, description, category, created_at)
         VALUES (?, ?, ?, '', 'test', '2026-10-01T00:00:00Z')`,
      ).run(`${table}-${slug}`, slug, slug);
    };
    for (const k of ['ct-cleo', 'ct-other', 'ct-local']) catalog('agent_registry_skills', k);
    catalog('agent_registry_capabilities', 'code');
    setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
    const uid = naturalRowUid('global', 'agent_registry_agents', ['cleo-remote']);
    withApplyFrame(db, 'global', null, (api) => {
      api.insertRow('agent_registry_agents', uid, {
        agent_id: 'cleo-remote',
        name: 'remote',
        capabilities: '["code"]',
        skills: '["ct-cleo"]',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      });
    });
    expect(getAgentSkills(db, 'cleo-remote')).toEqual(['ct-cleo']);
    expect(
      db
        .prepare('SELECT count(*) AS n FROM agent_registry_agent_capabilities WHERE agent_id = ?')
        .get(uid),
    ).toEqual({ n: 1 });
    // This device's own .cant attachment (agent-install) is local, never synced.
    db.prepare(
      "INSERT INTO agent_registry_agent_skills (agent_id, skill_id, source) VALUES (?, 'agent_registry_skills-ct-local', 'cant')",
    ).run(uid);
    withApplyFrame(db, 'global', null, (api) => {
      api.writeFields('agent_registry_agents', uid, { skills: '["ct-other"]' });
    });
    expect(getAgentSkills(db, 'cleo-remote').sort()).toEqual(['ct-local', 'ct-other']);
  });

  it('captures an agent insert once, with no local id, FK into local-only rows or secret value', async () => {
    const db = await open(join(home, 'cleo.db'));
    setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
    for (const t of [
      'agent_registry_agent_capabilities',
      'agent_registry_agent_skills',
      'agent_registry_capabilities',
      'agent_registry_skills',
      'agent_registry_accounts',
      'agent_registry_org_agent_keys',
    ]) {
      expect(captureTableDef(db, 'global', t), t).toBeUndefined();
    }
    const def = captureTableDef(db, 'global', 'agent_registry_agents');
    expect(def?.localRowid).toBe('id');
    expect(def?.localKeyIsUid).toBe(true);
    db.prepare(
      `INSERT INTO agent_registry_agents (id, agent_id, name, owner_id, webhook_secret, created_at, updated_at)
       VALUES ('id-1', 'cleo-dev', 'cleo-dev', NULL, 's3cret', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    ).run();
    const caps = db
      .prepare("SELECT op, img FROM _sync_capture WHERE tbl = 'agent_registry_agents' ORDER BY seq")
      .all() as Array<{ op: string; img: string }>;
    expect(caps.map((c) => c.op)).toEqual(['I']);
    const image = JSON.parse(caps[0]?.img ?? '{}') as Record<string, unknown>;
    expect(image).not.toHaveProperty('id');
    expect(image).not.toHaveProperty('owner_id');
    expect(image).not.toHaveProperty('organization_id');
    expect(image.webhook_secret).toBe('<changed>');
    expect(JSON.stringify(image)).not.toContain('s3cret');
  });
});
