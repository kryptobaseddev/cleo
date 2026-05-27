/**
 * Tests for nexusMoveProject + nexusRenameProject + nexusReconcile path_updated (T11024).
 * @task T11024
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nexusAuditLog, projectRegistry } from '../../store/nexus-schema.js';
import { getNexusDb } from '../../store/nexus-sqlite.js';
import { generateProjectHash } from '../hash.js';
import {
  nexusGetProject,
  nexusInit,
  nexusMoveProject,
  nexusReconcile,
  nexusRenameProject,
  resetNexusDbState,
} from '../registry.js';

async function reg(dbDir: string, pid: string, name: string) {
  await nexusInit();
  const db = await getNexusDb();
  const rp = resolve(dbDir);
  const h = generateProjectHash(dbDir);
  const n = new Date().toISOString();
  await db
    .insert(projectRegistry)
    .values({
      projectId: pid,
      projectHash: h,
      projectPath: rp,
      name,
      registeredAt: n,
      lastSeen: n,
      healthStatus: 'unknown',
      permissions: 'read',
      lastSync: n,
      taskCount: 1,
      labelsJson: '[]',
      brainDbPath: join(rp, '.cleo', 'brain.db'),
      tasksDbPath: join(rp, '.cleo', 'tasks.db'),
      statsJson: '{}',
    })
    .onConflictDoNothing();
}

async function mkProj(dir: string, pid: string) {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  await writeFile(
    join(dir, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: pid, createdAt: new Date().toISOString() }),
  );
}

let td: string, rd: string, pd: string;

beforeEach(async () => {
  td = await mkdtemp(join(tmpdir(), 'nmt-'));
  rd = join(td, 'ch');
  pd = join(td, 'tp');
  await mkdir(rd, { recursive: true });
  process.env['CLEO_HOME'] = rd;
  process.env['NEXUS_HOME'] = join(rd, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(rd, 'nexus', 'cache');
  resetNexusDbState();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  resetNexusDbState();
  await rm(td, { recursive: true, force: true });
});

describe('nexusMoveProject', () => {
  it('AC1: updates projectPath, projectHash, lastSeen after move', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'mt');
    const md = join(td, 'moved');
    await mkProj(md, pid);
    await reg(md, pid, 'mt');
    const r = await nexusMoveProject(pid, md);
    expect(r.path).toBe(resolve(md));
    expect(r.hash).toBe(generateProjectHash(md));
    expect(r.projectId).toBe(pid);
    expect(new Date(r.lastSeen).getTime()).toBeGreaterThan(Date.now() - 10000);
  });
  it('AC8: brainDbPath and tasksDbPath updated', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'mdt');
    const md = join(td, 'mdb');
    await mkProj(md, pid);
    await reg(md, pid, 'mdt');
    const r = await nexusMoveProject(pid, md);
    expect(r.brainDbPath).toBe(join(resolve(md), '.cleo', 'brain.db'));
    expect(r.tasksDbPath).toBe(join(resolve(md), '.cleo', 'tasks.db'));
  });
  it('AC3: nexusReconcile called as final step', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'rt');
    const md = join(td, 'rec');
    await mkProj(md, pid);
    await reg(md, pid, 'rt');
    await nexusMoveProject(pid, md);
    expect((await nexusReconcile(md)).status).toBe('ok');
  });
  it('AC5: audit log entries written for move', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'amt');
    const md = join(td, 'am');
    await mkProj(md, pid);
    await reg(md, pid, 'amt');
    await nexusMoveProject(pid, md);
    const db = await getNexusDb();
    const rows = (
      await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'move'))
    ).filter((r) => {
      try {
        const d = JSON.parse(r.detailsJson ?? '{}');
        return d?.oldPath;
      } catch {
        return false;
      }
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].projectId).toBe(pid);
    expect(rows[0].success).toBe(1);
  });
  it('throws on missing projectId', async () => {
    await nexusInit();
    await expect(nexusMoveProject('', '/t')).rejects.toThrow('projectId required');
  });
  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusMoveProject('x', join(td, 'n'))).rejects.toThrow('not found');
  });
});

describe('nexusRenameProject', () => {
  it('AC4: updates name in registry', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'on');
    const r = await nexusRenameProject(pid, 'nn');
    expect(r.name).toBe('nn');
    const p = await nexusGetProject('nn');
    expect(p).not.toBeNull();
    expect(p!.projectId).toBe(pid);
  });
  it('AC2: lookup uses projectId (stable)', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'st');
    const md = join(td, 'sm');
    await mkProj(md, pid);
    await reg(md, pid, 'st');
    expect((await nexusMoveProject(pid, md)).projectId).toBe(pid);
    expect((await nexusRenameProject(pid, 'sr')).projectId).toBe(pid);
  });
  it('AC5: audit log entries written for rename', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'art');
    await nexusRenameProject(pid, 'arn');
    const db = await getNexusDb();
    const rows = (
      await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'rename'))
    ).filter((r) => {
      try {
        const d = JSON.parse(r.detailsJson ?? '{}');
        return d?.oldName === 'art';
      } catch {
        return false;
      }
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].projectId).toBe(pid);
  });
  it('throws on missing projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('', 'n')).rejects.toThrow('projectId required');
  });
  it('throws on unknown projectId', async () => {
    await nexusInit();
    await expect(nexusRenameProject('x', 'n')).rejects.toThrow('not found');
  });
});

describe('nexusReconcile Scenario 2', () => {
  it('AC6: path_updated with brainDbPath/tasksDbPath', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 's2');
    const md = join(td, 's2m');
    await mkProj(md, pid);
    const r = await nexusReconcile(md);
    expect(r.status).toBe('path_updated');
    const p = await nexusGetProject('s2');
    expect(p).not.toBeNull();
    expect(p!.brainDbPath).toBe(join(resolve(md), '.cleo', 'brain.db'));
    expect(p!.tasksDbPath).toBe(join(resolve(md), '.cleo', 'tasks.db'));
  });
  it('idempotent', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'it');
    const md = join(td, 'im');
    await mkProj(md, pid);
    expect((await nexusReconcile(md)).status).toBe('path_updated');
    expect((await nexusReconcile(md)).status).toBe('ok');
  });
});

describe('combined', () => {
  it('move then rename preserves projectId', async () => {
    const pid = randomUUID();
    await mkProj(pd, pid);
    await reg(pd, pid, 'lt');
    const md = join(td, 'lm');
    await mkProj(md, pid);
    await reg(md, pid, 'lt');
    await nexusMoveProject(pid, md);
    const rn = await nexusRenameProject(pid, 'lr');
    expect(rn.name).toBe('lr');
    expect(rn.projectId).toBe(pid);
    const db = await getNexusDb();
    expect(
      (await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'move'))).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await db.select().from(nexusAuditLog).where(eq(nexusAuditLog.action, 'rename'))).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
