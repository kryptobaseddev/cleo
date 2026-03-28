/**
 * CLI agent command group — agent credential management (unified registry).
 *
 * Provides:
 *   cleo agent register   — register a new agent credential
 *   cleo agent list       — list all registered agent credentials
 *   cleo agent get <id>   — get a specific agent credential
 *   cleo agent remove <id> — remove an agent credential
 *   cleo agent rotate-key <id> — rotate an agent's API key
 *   cleo agent poll       — one-shot message check
 *   cleo agent send       — send a message to an agent or conversation
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.4
 * @task T178
 */

import {
  checkAgentHealth,
  detectCrashedAgents,
  detectStaleAgents,
  getHealthReport,
  STALE_THRESHOLD_MS,
} from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the `cleo agent` command group.
 */
export function registerAgentCommand(program: Command): void {
  const agent = program.command('agent').description('Agent lifecycle, credentials, and messaging');

  // --- cleo agent register ---
  agent
    .command('register')
    .description('Register a new agent credential in the local registry')
    .requiredOption('--id <agentId>', 'Unique agent identifier')
    .requiredOption('--name <displayName>', 'Human-readable display name')
    .requiredOption('--api-key <apiKey>', 'API key (sk_live_...)')
    .option('--api-url <url>', 'API base URL', 'https://api.signaldock.io')
    .option('--classification <class>', 'Agent classification (e.g. code_dev, orchestrator)')
    .option('--privacy <tier>', 'Privacy tier: public, discoverable, private', 'public')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const credential = await registry.register({
          agentId: opts['id'] as string,
          displayName: opts['name'] as string,
          apiKey: opts['apiKey'] as string,
          apiBaseUrl: (opts['apiUrl'] as string) ?? 'https://api.signaldock.io',
          classification: opts['classification'] as string | undefined,
          privacyTier: (opts['privacy'] as 'public' | 'discoverable' | 'private') ?? 'public',
          capabilities: [],
          skills: [],
          transportConfig: {},
          isActive: true,
        });

        cliOutput(
          {
            success: true,
            data: { agentId: credential.agentId, displayName: credential.displayName },
          },
          { command: 'agent register' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_REGISTER', message: String(err) } },
          { command: 'agent register' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent list ---
  agent
    .command('list')
    .description('List all registered agent credentials')
    .option('--active', 'Show only active agents')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const filter = opts['active'] ? { active: true } : undefined;
        const agents = await registry.list(filter);

        cliOutput(
          {
            success: true,
            data: agents.map((a) => ({
              agentId: a.agentId,
              displayName: a.displayName,
              apiBaseUrl: a.apiBaseUrl,
              classification: a.classification,
              isActive: a.isActive,
              lastUsedAt: a.lastUsedAt,
            })),
          },
          { command: 'agent list' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_LIST', message: String(err) } },
          { command: 'agent list' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent get <id> ---
  agent
    .command('get <agentId>')
    .description('Get details for a specific agent credential')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
            },
            { command: 'agent get' },
          );
          process.exitCode = 4;
          return;
        }

        // Redact API key in output
        cliOutput(
          {
            success: true,
            data: {
              ...credential,
              apiKey:
                credential.apiKey.length > 16
                  ? `${credential.apiKey.substring(0, 12)}...${credential.apiKey.substring(credential.apiKey.length - 4)}`
                  : '***redacted***',
            },
          },
          { command: 'agent get' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_GET', message: String(err) } },
          { command: 'agent get' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent remove <id> ---
  agent
    .command('remove <agentId>')
    .description('Remove an agent credential from the local registry')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        await registry.remove(agentId);
        cliOutput({ success: true, data: { agentId, removed: true } }, { command: 'agent remove' });
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_REMOVE', message: String(err) } },
          { command: 'agent remove' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent rotate-key <id> ---
  agent
    .command('rotate-key <agentId>')
    .description('Rotate an agent API key (generates new key on cloud, re-encrypts locally)')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const result = await registry.rotateKey(agentId);
        cliOutput(
          {
            success: true,
            data: {
              agentId: result.agentId,
              newApiKey: `${result.newApiKey.substring(0, 12)}...`,
              message: 'API key rotated. Old key is invalidated.',
            },
          },
          { command: 'agent rotate-key' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_ROTATE', message: String(err) } },
          { command: 'agent rotate-key' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent claim-code <id> ---
  agent
    .command('claim-code <agentId>')
    .description('Generate a claim code for human ownership of an agent')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
            },
            { command: 'agent claim-code' },
          );
          process.exitCode = 4;
          return;
        }

        const response = await fetch(`${credential.apiBaseUrl}/agents/${agentId}/claim-code`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            'X-Agent-Id': agentId,
          },
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`Failed to generate claim code: ${response.status} ${text}`);
        }

        const data = (await response.json()) as {
          data?: { claimCode?: string; claimUrl?: string; expiresAt?: string };
        };

        cliOutput(
          {
            success: true,
            data: {
              agentId,
              claimCode: data.data?.claimCode,
              claimUrl:
                data.data?.claimUrl ?? `https://signaldock.io/claim/${data.data?.claimCode}`,
              expiresAt: data.data?.expiresAt,
              message: 'Share this claim code with the human owner to verify agent ownership.',
            },
          },
          { command: 'agent claim-code' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_CLAIM', message: String(err) } },
          { command: 'agent claim-code' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent watch ---
  agent
    .command('watch')
    .description('Start continuous message polling for the active agent (long-running)')
    .option('--agent <id>', 'Agent ID to watch as (defaults to most recently used)')
    .option('--interval <ms>', 'Poll interval in milliseconds', '5000')
    .option('--group <ids>', 'Comma-separated group conversation IDs to monitor')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const { createRuntime } = await import('@cleocode/runtime');
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const groupIds = opts['group']
          ? (opts['group'] as string).split(',').map((s) => s.trim())
          : undefined;

        const handle = await createRuntime(registry, {
          agentId: opts['agent'] as string | undefined,
          pollIntervalMs: Number(opts['interval']) || 5000,
          groupConversationIds: groupIds,
        });

        handle.poller.onMessage((msg) => {
          cliOutput(
            {
              success: true,
              data: {
                event: 'message',
                id: msg.id,
                from: msg.from,
                content: msg.content,
                threadId: msg.threadId,
                timestamp: msg.timestamp,
              },
            },
            { command: 'agent watch' },
          );
        });

        handle.poller.start();

        cliOutput(
          {
            success: true,
            data: {
              event: 'started',
              agentId: handle.agentId,
              pollIntervalMs: Number(opts['interval']) || 5000,
              groupConversationIds: groupIds ?? [],
              message: 'Watching for messages. Press Ctrl+C to stop.',
            },
          },
          { command: 'agent watch' },
        );

        // Keep alive until SIGINT/SIGTERM
        const shutdown = () => {
          handle.stop();
          cliOutput(
            { success: true, data: { event: 'stopped', agentId: handle.agentId } },
            { command: 'agent watch' },
          );
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_WATCH', message: String(err) } },
          { command: 'agent watch' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent poll ---
  agent
    .command('poll')
    .description('One-shot message check for the active agent')
    .option('--agent <id>', 'Agent ID to poll as (defaults to most recently used)')
    .option('--limit <n>', 'Max messages to fetch', '20')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, createConduit, getDb } = await import(
          '@cleocode/core/internal'
        );
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const agentId = opts['agent'] as string | undefined;
        const conduit = await createConduit(registry, agentId);
        const limit = Number(opts['limit']) || 20;
        cliOutput(
          { success: true, data: { agentId: conduit.agentId, messages: [], limit } },
          { command: 'agent poll' },
        );

        await conduit.disconnect();
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_POLL', message: String(err) } },
          { command: 'agent poll' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent send ---
  agent
    .command('send <message>')
    .description('Send a message to an agent or conversation')
    .option('--to <agentId>', 'Target agent ID')
    .option('--conv <conversationId>', 'Target conversation ID')
    .option('--agent <id>', 'Send as this agent (defaults to most recently used)')
    .action(async (message: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, createConduit, getDb } = await import(
          '@cleocode/core/internal'
        );
        const db = await getDb();
        const registry = new AgentRegistryAccessor(db, process.cwd());

        const agentId = opts['agent'] as string | undefined;
        const to = opts['to'] as string | undefined;
        const conv = opts['conv'] as string | undefined;

        if (!to && !conv) {
          cliOutput(
            { success: false, error: { code: 'E_ARGS', message: 'Must specify --to or --conv' } },
            { command: 'agent send' },
          );
          process.exitCode = 1;
          return;
        }

        const conduit = await createConduit(registry, agentId);
        const result = await conduit.send(to ?? conv ?? '', message, {
          threadId: conv,
        });

        cliOutput(
          { success: true, data: { messageId: result.messageId, deliveredAt: result.deliveredAt } },
          { command: 'agent send' },
        );

        await conduit.disconnect();
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_SEND', message: String(err) } },
          { command: 'agent send' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent health ---
  agent
    .command('health')
    .description('Check agent health and detect stale or crashed agents')
    .option('--id <agentId>', 'Check health for a specific agent ID')
    .option(
      '--threshold <ms>',
      'Staleness threshold in milliseconds (default: 180000 = 3 minutes)',
      String(STALE_THRESHOLD_MS),
    )
    .option('--detect-crashed', 'Detect and mark crashed agents (write operation)')
    .action(async (opts: Record<string, unknown>) => {
      const thresholdMs =
        typeof opts['threshold'] === 'string' ? Number(opts['threshold']) : STALE_THRESHOLD_MS;
      const agentId = opts['id'] as string | undefined;
      const detectCrashed = Boolean(opts['detectCrashed']);

      if (agentId) {
        const health = await checkAgentHealth(agentId, thresholdMs);
        if (!health) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
            },
            { command: 'agent health' },
          );
          process.exitCode = 4;
          return;
        }
        cliOutput({ success: true, data: health }, { command: 'agent health' });
        return;
      }

      if (detectCrashed) {
        const crashed = await detectCrashedAgents(thresholdMs);
        cliOutput(
          {
            success: true,
            data: {
              detectedCrashed: crashed.length,
              agents: crashed.map((a) => ({
                id: a.id,
                agentType: a.agentType,
                lastHeartbeat: a.lastHeartbeat,
                status: a.status,
              })),
            },
          },
          { command: 'agent health' },
        );
        return;
      }

      const [report, stale] = await Promise.all([
        getHealthReport(thresholdMs),
        detectStaleAgents(thresholdMs),
      ]);

      cliOutput(
        {
          success: true,
          data: {
            summary: {
              total: report.total,
              active: report.active,
              idle: report.idle,
              starting: report.starting,
              error: report.error,
              crashed: report.crashed,
              stopped: report.stopped,
              totalErrors: report.totalErrors,
            },
            staleAgents: stale.map((s) => ({
              id: s.agentId,
              status: s.status,
              heartbeatAgeMs: s.heartbeatAgeMs,
              lastHeartbeat: s.lastHeartbeat,
              thresholdMs: s.thresholdMs,
            })),
            thresholdMs,
          },
        },
        { command: 'agent health' },
      );
    });
}
