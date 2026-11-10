/**
 * Lead MCP isolation (T14423): a lead loads ONLY the runner and the user's
 * mbx server, through `--mcp-config <file> --strict-mcp-config`; every other
 * user MCP server, at any scope, stays out. Without an mbx entry the lead gets
 * the runner alone and the report says so.
 *
 * @task T14423
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnContext } from '@cleocode/contracts';
import { LEAD_DENIED_TOOLS, LEAD_RUNNER_TOOL } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareLeadMcp, resolveMbxMcpServer } from '../lead-mcp.js';
import { buildClaudeArgs } from '../spawn.js';

const LEAD: SpawnContext = { taskId: 'T1', prompt: 'plan', leadDeniedTools: LEAD_DENIED_TOOLS };

const MBX = {
  type: 'stdio',
  command: '/opt/agentmbx/bin/agentmbx',
  args: ['mcp'],
  env: { AGENTMBX_TOKEN: 'secret' },
};
const SHELL_SERVER = { type: 'stdio', command: 'shell-mcp', args: [] };

describe('lead MCP isolation (T14423)', () => {
  let root: string;
  let project: string;
  let spawnDir: string;
  let claudeJson: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lead-mcp-'));
    project = join(root, 'project');
    spawnDir = join(root, 'spawn');
    mkdirSync(project);
    mkdirSync(spawnDir);
    claudeJson = join(root, '.claude.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('argv carries --strict-mcp-config and exactly the runner plus mbx; no other user server', async () => {
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { mbx: MBX, 'shell-tools': SHELL_SERVER, filesystem: SHELL_SERVER },
        projects: { [project]: { mcpServers: { 'local-writer': SHELL_SERVER } } },
      }),
    );
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'project-writer': SHELL_SERVER } }),
    );

    const setup = await prepareLeadMcp(spawnDir, project, claudeJson);
    const args = buildClaudeArgs(LEAD, '/tmp/p.md', [], setup);

    expect(args).toContain('--strict-mcp-config');
    const file = args[args.indexOf('--mcp-config') + 1] ?? '';
    expect(file).toBe(join(spawnDir, 'lead-mcp.json'));
    const config = JSON.parse(readFileSync(file, 'utf-8'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['cleo-lead', 'mbx']);
    expect(config.mcpServers['cleo-lead']).toEqual({
      type: 'stdio',
      command: 'cleo',
      args: ['orchestrate', 'lead-runner'],
    });
    for (const other of ['shell-tools', 'filesystem', 'local-writer', 'project-writer']) {
      expect(JSON.stringify(config)).not.toContain(other);
      expect(args.join(' ')).not.toContain(other);
    }
    expect(setup.report).toEqual({ servers: ['cleo-lead', 'mbx'], mailbox: 'loaded' });
    // The file can hold mbx env secrets: owner-only.
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('keeps mailbox access: the mbx entry is passed verbatim and its tools are pre-approved', async () => {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { mbx: MBX } }));
    const setup = await prepareLeadMcp(spawnDir, project, claudeJson);
    const config = JSON.parse(readFileSync(setup.config, 'utf-8'));
    expect(config.mcpServers.mbx).toEqual(MBX);
    const args = buildClaudeArgs(LEAD, '/tmp/p.md', [], setup);
    expect(args[args.indexOf('--allowedTools') + 1]?.split(',')).toEqual([
      LEAD_RUNNER_TOOL,
      'mcp__mbx',
    ]);
  });

  it('resolves mbx as Claude Code does: local, then project .mcp.json, then user', () => {
    const local = { ...MBX, args: ['mcp', '--local'] };
    const proj = { ...MBX, args: ['mcp', '--project'] };
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { mbx: MBX },
        projects: { [project]: { mcpServers: { mbx: local } } },
      }),
    );
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { mbx: proj } }));
    expect(resolveMbxMcpServer(project, claudeJson)).toEqual(local);
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { mbx: MBX } }));
    expect(resolveMbxMcpServer(project, claudeJson)).toEqual(proj);
    rmSync(join(project, '.mcp.json'));
    expect(resolveMbxMcpServer(project, claudeJson)).toEqual(MBX);
    // An entry under another name is still found by its `agentmbx mcp` command.
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { mailbox: MBX, other: SHELL_SERVER } }),
    );
    expect(resolveMbxMcpServer(project, claudeJson)).toEqual(MBX);
  });

  it('no mbx configured: the runner alone, reported as not-configured', async () => {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'shell-tools': SHELL_SERVER } }));
    const setup = await prepareLeadMcp(spawnDir, project, claudeJson);
    const config = JSON.parse(readFileSync(setup.config, 'utf-8'));
    expect(Object.keys(config.mcpServers)).toEqual(['cleo-lead']);
    expect(setup.report).toEqual({ servers: ['cleo-lead'], mailbox: 'not-configured' });
    const args = buildClaudeArgs(LEAD, '/tmp/p.md', [], setup);
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(LEAD_RUNNER_TOOL);
  });

  it('a missing or unreadable ~/.claude.json reads as no mbx', () => {
    expect(resolveMbxMcpServer(project, join(root, 'absent.json'))).toBeNull();
    writeFileSync(claudeJson, '{not json');
    expect(resolveMbxMcpServer(project, claudeJson)).toBeNull();
  });
});
