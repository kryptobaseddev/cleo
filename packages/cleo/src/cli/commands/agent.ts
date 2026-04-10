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
 *   cleo agent start      — start the daemon poller for an agent
 *   cleo agent install    — install an agent from .cantz archive or directory
 *   cleo agent pack       — package an agent directory as .cantz archive
 *   cleo agent create     — scaffold a new agent package with persona.cant and manifest.json
 *
 * **Daemon vs. Pi session — important distinction.** The daemon spawned
 * by `cleo agent start` ONLY polls SignalDock for inbound messages and
 * keeps the cloud status indicator green. It does NOT execute CANT
 * workflow profiles inside the daemon process. CANT workflow execution
 * (sessions, parallel arms, conditionals, approval gates, discretion
 * evaluation, etc.) lives entirely inside the
 * `cant-bridge.ts` Pi extension at
 * `packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts`,
 * which interprets `.cant` files via shell-out to the `cleo cant`
 * command family. Operators who want profile-driven behaviour should
 * start a Pi session and use `/cant:load <file>` followed by
 * `/cant:run <file> <workflowName>`. The daemon and the Pi session are
 * distinct runtimes with distinct purposes, by design (see ADR-035 §D5
 * "Option Y" addendum).
 *
 * @see docs/specs/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md Section 3.4
 * @see .cleo/adrs/ADR-035-pi-v2-v3-harness.md §D5 + Addendum
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
import { computeProfileStatus, type ProfileValidation } from './agent-profile-status.js';

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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const agentId = opts['id'] as string;
        const displayName = opts['name'] as string;
        const classification = opts['classification'] as string | undefined;

        const credential = await registry.register({
          agentId,
          displayName,
          apiKey: opts['apiKey'] as string,
          apiBaseUrl: (opts['apiUrl'] as string) ?? 'https://api.signaldock.io',
          classification,
          privacyTier: (opts['privacy'] as 'public' | 'discoverable' | 'private') ?? 'public',
          capabilities: [],
          skills: [],
          transportType: 'http',
          transportConfig: {},
          isActive: true,
        });

        // Scaffold .cant persona file if it doesn't exist
        const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const cantDir = join('.cleo', 'agents');
        const cantPath = join(cantDir, `${agentId}.cant`);
        let cantScaffolded = false;

        if (!existsSync(cantPath)) {
          mkdirSync(cantDir, { recursive: true });
          const role = classification ?? 'specialist';
          const cantContent = `---
kind: agent
version: 2
---

agent ${agentId}:
  house: none
  allegiance: canon
  role: ${role}
  parent: cleoos-opus-orchestrator
  description: "${displayName}"

  tone:
    |
    TODO: Describe how this agent communicates.

  prompt:
    |
    TODO: Write the core behavioral instruction.

  skills: [ct-cleo]

  permissions:
    tasks: read
    session: read
    memory: read

  transport:
    primary: local
    fallback: sse
    cloud: http
    apiBaseUrl: https://api.signaldock.io

  lifecycle:
    start: cleo agent start ${agentId}
    stop: cleo agent stop ${agentId}
    status: cleo agent status ${agentId}

  context:
    active-tasks
    memory-bridge

  on SessionStart:
    /checkin @all #online

  enforcement:
    1: TODO — what does this agent push back on?
`;
          writeFileSync(cantPath, cantContent, 'utf-8');
          cantScaffolded = true;
        }

        cliOutput(
          {
            success: true,
            data: {
              agentId: credential.agentId,
              displayName: credential.displayName,
              cantFile: cantScaffolded ? cantPath : existsSync(cantPath) ? cantPath : null,
              cantScaffolded,
            },
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

  // --- cleo agent signin ---
  agent
    .command('signin <agentId>')
    .description('Sign in as an agent — marks active, caches credentials for session')
    .option('--api-url <url>', 'Override API base URL for cloud status update')
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        // Look up the credential
        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Agent '${agentId}' not registered. Run: cleo agent register --id ${agentId} --name "..." --api-key sk_live_...`,
              },
            },
            { command: 'agent signin' },
          );
          process.exitCode = 1;
          return;
        }

        // Mark as active + update lastUsedAt
        await registry.update(agentId, { isActive: true });
        await registry.markUsed(agentId);

        // Attempt to set online status on cloud (best-effort, don't fail if offline)
        const apiUrl = (opts['apiUrl'] as string) ?? credential.apiBaseUrl;
        try {
          await fetch(`${apiUrl}/agents/${agentId}/status`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential.apiKey}`,
              'X-Agent-Id': agentId,
            },
            body: JSON.stringify({ status: 'online' }),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          // Offline is fine — LocalTransport works without cloud
        }

        cliOutput(
          {
            success: true,
            data: {
              agentId: credential.agentId,
              displayName: credential.displayName,
              apiBaseUrl: apiUrl,
              status: 'online',
              transport: 'local',
            },
          },
          { command: 'agent signin' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_SIGNIN', message: String(err) } },
          { command: 'agent signin' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent start ---
  // Boot the SignalDock-poller daemon for an agent.
  //
  // Profile handling:
  //   The `--cant <file>` option (or the default
  //   `.cleo/agents/<agentId>.cant` lookup) is read for two reasons:
  //
  //   1. **Fail-fast validation**: if the file exists and the optional
  //      `@cleocode/cant` validator is available in this build, the
  //      file is parsed so malformed profiles surface as a status
  //      string rather than blowing up later.
  //   2. **Status surface**: the resulting status (`validated`,
  //      `invalid (N errors)`, `loaded (unvalidated)`, or `none`) is
  //      reported in the LAFS envelope so operators know the daemon
  //      saw the file they expected.
  //
  //   The profile string is then DROPPED. The daemon does NOT execute
  //   workflow profiles. Profile-driven behaviour (sessions, parallel
  //   arms, conditionals, approval gates, discretion evaluation) runs
  //   inside Pi sessions through the `cant-bridge.ts` Pi extension at
  //   `packages/cleo/templates/cleoos-hub/pi-extensions/cant-bridge.ts`.
  //   Operators who want profile execution should start a Pi session
  //   and run `/cant:load <file>` followed by
  //   `/cant:run <file> <workflowName>`.
  //
  //   See ADR-035 §D5 (Option Y addendum) for the architectural
  //   rationale: there is exactly ONE workflow execution engine in
  //   CleoOS — `cant-bridge.ts` — and it lives inside Pi by design.
  agent
    .command('start <agentId>')
    .description(
      'Start an agent daemon — polls SignalDock for messages. Profile is validated for fail-fast feedback only; CANT execution lives in Pi via cant-bridge.ts.',
    )
    .option(
      '--cant <file>',
      'Path to .cant persona file (validated only, NOT executed by the daemon)',
    )
    .option('--poll-interval <ms>', 'Poll interval in milliseconds', '5000')
    .option('--no-heartbeat', 'Disable heartbeat service')
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const { createRuntime } = await import('@cleocode/runtime');
        const { existsSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');

        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        // 1. Look up credential
        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Agent '${agentId}' not registered. Run: cleo agent register --id ${agentId} --name "..." --api-key sk_live_...`,
              },
            },
            { command: 'agent start' },
          );
          process.exitCode = 1;
          return;
        }

        // 2. Read and (best-effort) validate the .cant profile.
        //    This is FAIL-FAST GUARDING ONLY. The profile string is
        //    used to compute a status field below, then dropped. The
        //    daemon does not interpret the workflow body — see the
        //    block comment above this command for why.
        let profile: string | null = null;
        let cantValidation: ProfileValidation | null = null;
        const cantPath = (opts['cant'] as string) ?? join('.cleo', 'agents', `${agentId}.cant`);
        if (existsSync(cantPath)) {
          profile = readFileSync(cantPath, 'utf-8');
          try {
            const cantModule = await import('@cleocode/cant');
            // validate() may not be available in all builds of @cleocode/cant
            const validate =
              'validate' in cantModule
                ? (
                    cantModule as {
                      validate: (input: string) => {
                        valid: boolean;
                        diagnostics?: Array<{ message: string }>;
                      };
                    }
                  ).validate
                : null;
            if (validate) {
              const result = validate(profile);
              cantValidation = {
                valid: result.valid,
                errors: result.diagnostics?.map((d) => d.message) ?? [],
              };
            }
          } catch {
            // cant-napi not available — profile loaded but unvalidated
            cantValidation = null;
          }
        }

        // 3. Mark active + update lastUsedAt
        await registry.update(agentId, { isActive: true });
        await registry.markUsed(agentId);

        // 4. Set cloud status (best-effort)
        try {
          await fetch(`${credential.apiBaseUrl}/agents/${agentId}/status`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential.apiKey}`,
              'X-Agent-Id': agentId,
            },
            body: JSON.stringify({ status: 'online' }),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          // Offline is fine — LocalTransport works without cloud
        }

        // 5. Start runtime services (transport auto-resolved: Local > SSE > HTTP).
        //    Note: createRuntime() does NOT receive the profile. The
        //    daemon's job is purely SignalDock polling + cloud status.
        const pollInterval = Number(opts['pollInterval'] ?? 5000);
        const runtime = await createRuntime(registry, {
          agentId,
          pollIntervalMs: pollInterval,
          heartbeatIntervalMs: opts['heartbeat'] === false ? 0 : 30000,
          groupConversationIds: [],
        });

        runtime.poller.start();

        cliOutput(
          {
            success: true,
            data: {
              agentId,
              displayName: credential.displayName,
              status: 'online',
              transport: runtime.transport.name,
              // Surfaced for operator visibility only — see
              // computeProfileStatus tsdoc for the four possible values.
              profile: computeProfileStatus(profile, cantValidation),
              services: {
                poller: 'running',
                heartbeat: runtime.heartbeat ? 'running' : 'disabled',
                keyRotation: runtime.keyRotation ? 'running' : 'disabled',
              },
            },
          },
          { command: 'agent start' },
        );

        // 6. Keep process alive until shutdown signal (cross-platform)
        const shutdown = () => {
          runtime.stop();
          void registry.update(agentId, { isActive: false }).catch(() => {});
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        // Windows: listen for 'message' from parent process managers (PM2, etc.)
        if (process.platform === 'win32') {
          process.on('message', (msg) => {
            if (msg === 'shutdown') shutdown();
          });
        }

        // Keep alive
        await new Promise(() => {});
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_START', message: String(err) } },
          { command: 'agent start' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent stop ---
  agent
    .command('stop <agentId>')
    .description('Stop an agent — mark offline and deactivate')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent '${agentId}' not registered.` },
            },
            { command: 'agent stop' },
          );
          process.exitCode = 1;
          return;
        }

        // Mark inactive
        await registry.update(agentId, { isActive: false });

        // Set cloud status offline (best-effort)
        try {
          await fetch(`${credential.apiBaseUrl}/agents/${agentId}/status`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential.apiKey}`,
              'X-Agent-Id': agentId,
            },
            body: JSON.stringify({ status: 'offline' }),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          // Offline is fine
        }

        cliOutput(
          { success: true, data: { agentId, status: 'offline' } },
          { command: 'agent stop' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_STOP', message: String(err) } },
          { command: 'agent stop' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent status ---
  agent
    .command('status [agentId]')
    .description('Show agent status — all agents or specific agent')
    .action(async (agentId?: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        if (agentId) {
          const credential = await registry.get(agentId);
          if (!credential) {
            cliOutput(
              {
                success: false,
                error: { code: 'E_NOT_FOUND', message: `Agent '${agentId}' not registered.` },
              },
              { command: 'agent status' },
            );
            process.exitCode = 1;
            return;
          }
          cliOutput(
            {
              success: true,
              data: {
                agentId: credential.agentId,
                displayName: credential.displayName,
                active: credential.isActive,
                lastUsedAt: credential.lastUsedAt,
                transport: credential.transportType,
              },
            },
            { command: 'agent status' },
          );
        } else {
          const agents = await registry.list();
          cliOutput(
            {
              success: true,
              data: {
                agents: agents.map((a) => ({
                  agentId: a.agentId,
                  displayName: a.displayName,
                  active: a.isActive,
                  lastUsedAt: a.lastUsedAt,
                })),
                total: agents.length,
              },
            },
            { command: 'agent status' },
          );
        }
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_STATUS', message: String(err) } },
          { command: 'agent status' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent assign ---
  agent
    .command('assign <agentId> <taskId>')
    .description('Assign a task to an agent via messaging')
    .action(async (agentId: string, taskId: string) => {
      try {
        const { AgentRegistryAccessor, getDb, createConduit } = await import(
          '@cleocode/core/internal'
        );
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const active = await registry.getActive();
        if (!active) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NO_ACTIVE',
                message: 'No active agent. Run: cleo agent signin <id>',
              },
            },
            { command: 'agent assign' },
          );
          process.exitCode = 1;
          return;
        }

        const conduit = await createConduit(registry);
        await conduit.send(
          agentId,
          `/action @${agentId} #task-assignment\n\nAssigned task ${taskId}. Run: cleo show ${taskId} && cleo start ${taskId}`,
        );
        await conduit.disconnect();

        cliOutput(
          {
            success: true,
            data: { agentId, taskId, assignedBy: active.agentId },
          },
          { command: 'agent assign' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_ASSIGN', message: String(err) } },
          { command: 'agent assign' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent wake ---
  agent
    .command('wake <agentId>')
    .description('Wake an idle agent — send a prod message')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb, createConduit } = await import(
          '@cleocode/core/internal'
        );
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const active = await registry.getActive();
        if (!active) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NO_ACTIVE',
                message: 'No active agent. Run: cleo agent signin <id>',
              },
            },
            { command: 'agent wake' },
          );
          process.exitCode = 1;
          return;
        }

        const conduit = await createConduit(registry);
        await conduit.send(
          agentId,
          `/action @${agentId} #wake #prod\n\nYou are idle. Check your queue: cleo current || cleo next. Report status immediately.`,
        );
        await conduit.disconnect();

        cliOutput(
          { success: true, data: { agentId, prodBy: active.agentId } },
          { command: 'agent wake' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_WAKE', message: String(err) } },
          { command: 'agent wake' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent spawn ---
  agent
    .command('spawn')
    .description('Spawn a new ephemeral agent for a specific task')
    .requiredOption('--role <role>', 'Agent role (e.g. code_dev, research, security)')
    .option('--task <taskId>', 'Task to assign to the spawned agent')
    .option('--model <model>', 'Model to use (e.g. opus, sonnet)')
    .option('--name <name>', 'Display name for the agent')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const role = opts['role'] as string;
        const taskId = opts['task'] as string | undefined;
        const model = (opts['model'] as string) ?? 'sonnet';
        const displayName =
          (opts['name'] as string) ?? `ephemeral-${role}-${Date.now().toString(36)}`;
        const agentId = displayName;

        // Register the ephemeral agent locally (no cloud registration)
        await registry.register({
          agentId,
          displayName,
          apiKey: 'ephemeral-local-only',
          apiBaseUrl: 'local',
          classification: role,
          privacyTier: 'private',
          capabilities: ['chat', 'tools'],
          skills: [role],
          transportType: 'http',
          transportConfig: {},
          isActive: true,
        });

        cliOutput(
          {
            success: true,
            data: {
              agentId,
              displayName,
              role,
              model,
              taskId: taskId ?? null,
              transport: 'local',
              lifecycle: 'ephemeral',
            },
          },
          { command: 'agent spawn' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_SPAWN', message: String(err) } },
          { command: 'agent spawn' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent reassign ---
  agent
    .command('reassign <taskId> <agentId>')
    .description('Reassign a task to another agent via conduit message')
    .action(async (taskId: string, agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb, createConduit } = await import(
          '@cleocode/core/internal'
        );
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());
        const active = await registry.getActive();
        if (!active) {
          cliOutput(
            { success: false, error: { code: 'E_NO_ACTIVE', message: 'No active agent.' } },
            { command: 'agent reassign' },
          );
          process.exitCode = 1;
          return;
        }
        const conduit = await createConduit(registry);
        await conduit.send(
          agentId,
          `/action @${agentId} #task-reassignment\n\nTask ${taskId} reassigned to you by ${active.agentId}. Run: cleo show ${taskId} && cleo start ${taskId}`,
        );
        await conduit.disconnect();
        cliOutput(
          { success: true, data: { taskId, newOwner: agentId, reassignedBy: active.agentId } },
          { command: 'agent reassign' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_REASSIGN', message: String(err) } },
          { command: 'agent reassign' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent stop-all ---
  agent
    .command('stop-all')
    .description('Stop all active agents — mark all offline')
    .action(async () => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());
        const agents = await registry.list({ active: true });
        let stopped = 0;
        for (const a of agents) {
          await registry.update(a.agentId, { isActive: false });
          try {
            await fetch(`${a.apiBaseUrl}/agents/${a.agentId}/status`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${a.apiKey}`,
                'X-Agent-Id': a.agentId,
              },
              body: JSON.stringify({ status: 'offline' }),
              signal: AbortSignal.timeout(3000),
            });
          } catch {
            /* best-effort */
          }
          stopped++;
        }
        cliOutput(
          { success: true, data: { stopped, total: agents.length } },
          { command: 'agent stop-all' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_STOP_ALL', message: String(err) } },
          { command: 'agent stop-all' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent work ---
  agent
    .command('work <agentId>')
    .description(
      'Enter autonomous work loop — poll tasks, report, optionally execute. Phase 3: --execute enables the Conductor Loop.',
    )
    .option('--poll-interval <ms>', 'Task check interval in milliseconds', '30000')
    .option(
      '--execute',
      'Autonomously execute ready tasks via orchestrate.spawn.execute (Phase 3 Conductor Loop)',
    )
    .option(
      '--adapter <id>',
      'Adapter id to route spawns through (default: auto-detect from capabilities)',
    )
    .option(
      '--epic <id>',
      'Restrict autonomous execution to a specific epic (default: any ready task)',
    )
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        const { createRuntime } = await import('@cleocode/runtime');
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());
        const credential = await registry.get(agentId);
        if (!credential) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent '${agentId}' not registered.` },
            },
            { command: 'agent work' },
          );
          process.exitCode = 1;
          return;
        }
        await registry.update(agentId, { isActive: true });
        await registry.markUsed(agentId);
        const cantPath = join('.cleo', 'agents', `${agentId}.cant`);
        const hasProfile = existsSync(cantPath);
        const runtime = await createRuntime(registry, {
          agentId,
          pollIntervalMs: 5000,
          heartbeatIntervalMs: 30000,
        });
        runtime.poller.start();
        const executeMode = opts['execute'] === true;
        const epicRestrict =
          typeof opts['epic'] === 'string' ? (opts['epic'] as string) : undefined;
        const adapterRestrict =
          typeof opts['adapter'] === 'string' ? (opts['adapter'] as string) : undefined;
        cliOutput(
          {
            success: true,
            data: {
              agentId,
              mode: executeMode ? 'conductor-loop' : 'watch-only',
              profile: hasProfile ? 'loaded' : 'none',
              status: 'running',
              epic: epicRestrict ?? 'any',
              adapter: adapterRestrict ?? 'auto',
            },
          },
          { command: 'agent work' },
        );

        // Parse LAFS envelope from CLI stdout (handles both minimal and full shapes)
        const parseLafs = <T = unknown>(raw: string): T | undefined => {
          const lines = raw.trim().split('\n');
          const envLine = [...lines].reverse().find((l) => l.startsWith('{'));
          if (!envLine) return undefined;
          try {
            const env = JSON.parse(envLine) as {
              ok?: boolean;
              r?: T;
              success?: boolean;
              result?: T;
              data?: T;
            };
            if (env.ok === true) return env.r;
            if (env.success === true) return (env.result ?? env.data) as T | undefined;
            return undefined;
          } catch {
            return undefined;
          }
        };

        const runCleo = async (args: string[], timeoutMs = 15000): Promise<string> => {
          const { stdout } = await execFileAsync('cleo', args, {
            encoding: 'utf-8',
            timeout: timeoutMs,
          });
          return stdout;
        };

        const taskInterval = Number(opts['pollInterval'] ?? 30000);
        let inFlight = false;
        let iterations = 0;
        const workLoop = setInterval(async () => {
          if (inFlight) return;
          inFlight = true;
          iterations += 1;
          try {
            const currentRaw = await runCleo(['current']).catch(() => '');
            if (currentRaw.trim()) {
              // A task is already in progress — skip
              return;
            }

            // Resolve next ready task (respect epic restriction when set)
            const nextArgs = epicRestrict ? ['orchestrate', 'next', epicRestrict] : ['next'];
            const nextRaw = await runCleo(nextArgs).catch(() => '');
            if (!nextRaw.trim()) return;

            const nextData = parseLafs<{
              nextTask?: { id?: string; title?: string } | null;
              id?: string;
              title?: string;
            }>(nextRaw);
            const taskId =
              nextData?.nextTask?.id ??
              (typeof nextData?.id === 'string' ? nextData.id : undefined);

            if (!taskId) return;

            if (!executeMode) {
              // Watch-only legacy behaviour: advertise availability
              console.log(
                `[${agentId}] Task available: ${taskId}. Pass --execute to run autonomously.`,
              );
              return;
            }

            // Phase 3 Conductor Loop: actually execute via orchestrate.spawn.execute
            const spawnArgs = ['orchestrate', 'spawn', taskId];
            if (adapterRestrict) {
              spawnArgs.push('--adapter', adapterRestrict);
            }
            const spawnRaw = await runCleo(spawnArgs, 60000).catch((e) => {
              console.error(
                `[${agentId}] conductor-loop: spawn failed for ${taskId}: ${String(e)}`,
              );
              return '';
            });
            const spawnData = parseLafs<{
              instanceId?: string;
              taskId?: string;
              status?: string;
            }>(spawnRaw);
            if (spawnData?.instanceId) {
              console.log(
                `[${agentId}] conductor-loop spawned task=${taskId} instance=${spawnData.instanceId} status=${spawnData.status ?? 'unknown'}`,
              );
            }
          } catch {
            /* non-fatal — loop continues */
          } finally {
            inFlight = false;
          }
        }, taskInterval);

        const shutdown = () => {
          clearInterval(workLoop);
          runtime.stop();
          void registry.update(agentId, { isActive: false }).catch(() => {});
          if (executeMode) {
            console.log(`[${agentId}] conductor-loop shutdown after ${iterations} iterations.`);
          }
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        if (process.platform === 'win32') {
          process.on('message', (msg) => {
            if (msg === 'shutdown') shutdown();
          });
        }
        await new Promise(() => {});
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_WORK', message: String(err) } },
          { command: 'agent work' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent list ---
  /**
   * Lists agents visible in the current project (default: INNER JOIN project-scoped),
   * or all global agents when `--global` is supplied (full scan, no project filter).
   *
   * Output columns: agentId, name, classification, transportType, isActive,
   * lastUsedAt, attachment (derived from projectRef).
   *
   * @task T362 @epic T310
   */
  agent
    .command('list')
    .description('List registered agent credentials')
    .option('--active', 'Show only active agents (project-scoped mode only)')
    .option('--global', 'Show all global agents regardless of project attachment (ADR-037 §4 Q1=B)')
    .option('--include-disabled', 'Include detached/disabled agents (enabled=0)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { listAgentsForProject, getDb } = await import('@cleocode/core/internal');
        await getDb();

        const includeGlobal = opts['global'] === true;
        const includeDisabled = opts['includeDisabled'] === true;

        const agents = listAgentsForProject(process.cwd(), {
          includeGlobal,
          includeDisabled,
        });

        // Apply legacy --active filter only when NOT in global mode
        const filtered =
          !includeGlobal && opts['active'] ? agents.filter((a) => a.isActive) : agents;

        cliOutput(
          {
            success: true,
            data: filtered.map((a) => ({
              agentId: a.agentId,
              name: a.displayName,
              classification: a.classification ?? null,
              transportType: a.transportType,
              isActive: a.isActive,
              lastUsedAt: a.lastUsedAt ?? null,
              attachment: a.projectRef
                ? a.projectRef.enabled === 1
                  ? '[attached]'
                  : '[disabled]'
                : '[global]',
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
  /**
   * Returns details for a specific agent credential.
   *
   * Default: project-scoped lookup via `lookupAgent(includeGlobal=false)` — agent
   * must have a project_agent_refs row with enabled=1 in the current project.
   *
   * With `--global`: cross-project identity lookup via `lookupAgent(includeGlobal=true)`.
   * Returns the global identity even if the agent is not attached to this project;
   * projectRef block will be null when not attached.
   *
   * @task T362 @epic T310
   */
  agent
    .command('get <agentId>')
    .description('Get details for a specific agent credential')
    .option(
      '--global',
      'Perform global identity lookup — returns agent even if not attached to current project',
    )
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { lookupAgent, getDb } = await import('@cleocode/core/internal');
        await getDb();

        const includeGlobal = opts['global'] === true;
        const agent = lookupAgent(process.cwd(), agentId, { includeGlobal });

        if (!agent) {
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
        const redactedKey =
          agent.apiKey.length > 16
            ? `${agent.apiKey.substring(0, 12)}...${agent.apiKey.substring(agent.apiKey.length - 4)}`
            : '***redacted***';

        cliOutput(
          {
            success: true,
            data: {
              agentId: agent.agentId,
              displayName: agent.displayName,
              apiKey: redactedKey,
              apiBaseUrl: agent.apiBaseUrl,
              classification: agent.classification ?? null,
              transportType: agent.transportType,
              isActive: agent.isActive,
              lastUsedAt: agent.lastUsedAt ?? null,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
              projectRef: agent.projectRef ?? 'not attached to current project',
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

  // --- cleo agent attach <id> ---
  /**
   * @task T364
   * @epic T310
   * @why ADR-037 §3 — project_agent_refs override table allows per-project
   *      agents to be attached/detached without touching global identity.
   */
  agent
    .command('attach <agentId>')
    .description('Attach a global agent to the current project')
    .option('--role <role>', 'Per-project role override')
    .option('--capabilities-override <json>', 'JSON blob of capability overrides')
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, attachAgentToProject, lookupAgent, getDb } = await import(
          '@cleocode/core/internal'
        );
        await getDb();
        const projectRoot = process.cwd();

        // Ensure both DBs initialised before any cross-DB operation
        const _registry = new AgentRegistryAccessor(projectRoot);
        void _registry;

        // Verify agent exists globally
        const global = lookupAgent(projectRoot, agentId, { includeGlobal: true });
        if (!global) {
          cliOutput(
            {
              success: false,
              error: { code: 'E_NOT_FOUND', message: `Agent not found: ${agentId}` },
            },
            { command: 'agent attach' },
          );
          process.exitCode = 4;
          return;
        }

        attachAgentToProject(projectRoot, agentId, {
          role: typeof opts['role'] === 'string' ? opts['role'] : null,
          capabilitiesOverride:
            typeof opts['capabilitiesOverride'] === 'string' ? opts['capabilitiesOverride'] : null,
        });

        cliOutput(
          {
            success: true,
            data: {
              attached: agentId,
              projectRoot,
              role: typeof opts['role'] === 'string' ? opts['role'] : null,
            },
          },
          { command: 'agent attach' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_ATTACH', message: String(err) } },
          { command: 'agent attach' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent detach <id> ---
  /**
   * @task T364
   * @epic T310
   * @why ADR-037 §3 — soft-delete via project_agent_refs.enabled=0 preserves
   *      global agent identity while removing it from the project view.
   */
  agent
    .command('detach <agentId>')
    .description('Detach an agent from the current project (preserves global identity)')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, detachAgentFromProject, getProjectAgentRef, getDb } =
          await import('@cleocode/core/internal');
        await getDb();
        const projectRoot = process.cwd();

        // Ensure both DBs initialised
        const _registry = new AgentRegistryAccessor(projectRoot);
        void _registry;

        const ref = getProjectAgentRef(projectRoot, agentId);
        if (!ref) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Agent ${agentId} not attached to current project`,
              },
            },
            { command: 'agent detach' },
          );
          process.exitCode = 4;
          return;
        }

        detachAgentFromProject(projectRoot, agentId);

        cliOutput(
          { success: true, data: { detached: agentId, projectRoot } },
          { command: 'agent detach' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_DETACH', message: String(err) } },
          { command: 'agent detach' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent remove <id> ---
  /**
   * Detach agent from current project (default) or remove from global registry
   * with the --global flag.
   *
   * Default (no --global): sets enabled=0 in conduit.db:project_agent_refs only.
   * This is identical to `cleo agent detach` and is the post-T310 default.
   *
   * --global: calls AgentRegistryAccessor.removeGlobal() (destructive). Pre-check
   * scans the current project's conduit.db for an active reference. If one exists
   * and --force-global is not supplied, aborts with E_VALIDATION (exit 6). The
   * scan is limited to the current project — see ADR-037 §6 known limitations.
   *
   * @task T366
   * @epic T310
   * @why ADR-037 §6 — never-auto-delete semantics; --global flag required for
   *      destructive removal; best-effort cross-project scan with documented
   *      limitation (current project only for v1).
   */
  agent
    .command('remove <agentId>')
    .description(
      'Detach agent from current project (default) or remove global identity with --global',
    )
    .option('--global', 'Remove from global signaldock.db (destructive, irreversible)')
    .option(
      '--force-global',
      'Force global removal even when the current project still has an active reference',
    )
    .action(async (agentId: string, opts: Record<string, unknown>) => {
      try {
        const { AgentRegistryAccessor, detachAgentFromProject, getProjectAgentRef, getDb } =
          await import('@cleocode/core/internal');
        await getDb();
        const projectRoot = process.cwd();

        if (!opts['global']) {
          // Project-scoped detach (default post-T310) — mirrors `cleo agent detach`
          // Ensure both DBs initialised
          const _registry = new AgentRegistryAccessor(projectRoot);
          void _registry;

          const ref = getProjectAgentRef(projectRoot, agentId);
          if (!ref) {
            cliOutput(
              {
                success: false,
                error: {
                  code: 'E_NOT_FOUND',
                  message: `Agent ${agentId} not attached to current project`,
                },
              },
              { command: 'agent remove' },
            );
            process.exitCode = 4;
            return;
          }

          detachAgentFromProject(projectRoot, agentId);

          cliOutput(
            { success: true, data: { removed: agentId, scope: 'project', projectRoot } },
            { command: 'agent remove' },
          );
          return;
        }

        // --global: destructive removal from signaldock.db
        // Safety scan — limited to current project (ADR-037 §6 known limitation).
        const _registry2 = new AgentRegistryAccessor(projectRoot);
        void _registry2;

        const activeRef = getProjectAgentRef(projectRoot, agentId);

        if (activeRef && !opts['forceGlobal']) {
          console.warn(
            `NOTE: Safety scan is limited to the current project. Other projects may have ` +
              `dangling references after global removal.`,
          );
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message:
                  `Agent "${agentId}" is still attached to current project. ` +
                  `Detach first or pass --force-global to proceed anyway.`,
                fix:
                  `cleo agent detach ${agentId}  # detach first, then retry` +
                  `  OR  cleo agent remove ${agentId} --global --force-global`,
              },
            },
            { command: 'agent remove' },
          );
          process.exitCode = 6;
          return;
        }

        console.warn(
          `NOTE: Safety scan is limited to the current project. Other projects may have ` +
            `dangling references after global removal.`,
        );

        const registry = new AgentRegistryAccessor(projectRoot);
        await registry.removeGlobal(agentId, { force: opts['forceGlobal'] === true });

        cliOutput(
          { success: true, data: { removed: agentId, scope: 'global' } },
          { command: 'agent remove' },
        );
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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

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
        if (process.platform === 'win32') {
          process.on('message', (msg) => {
            if (msg === 'shutdown') shutdown();
          });
        }
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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

        const agentId = opts['agent'] as string | undefined;
        const conduit = await createConduit(registry, agentId);
        const limit = Number(opts['limit']) || 20;
        const messages = await conduit.poll({ limit });

        cliOutput(
          {
            success: true,
            data: { agentId: conduit.agentId, messages, count: messages.length, limit },
          },
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
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

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

  // --- cleo agent install <path> ---
  /**
   * Install an agent from a `.cantz` archive or a directory containing `persona.cant`.
   *
   * - If the path is a `.cantz` file, extracts the ZIP to a temp directory first.
   * - Validates that `persona.cant` exists in the source.
   * - Copies the agent directory to the target tier.
   * - Default: project tier (`.cleo/cant/agents/<name>/`).
   * - `--global`: global tier (`~/.local/share/cleo/cant/agents/`).
   * - Best-effort agent registration in signaldock.db.
   *
   * @task T438
   * @epic T250
   * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
   */
  agent
    .command('install <path>')
    .description('Install an agent from a .cantz archive or agent directory')
    .option('--global', 'Install to global tier (~/.local/share/cleo/cant/agents/)')
    .action(async (sourcePath: string, opts: Record<string, unknown>) => {
      try {
        const { existsSync, mkdirSync, cpSync, readFileSync, rmSync, statSync } = await import(
          'node:fs'
        );
        const { join, basename, resolve } = await import('node:path');
        const { homedir } = await import('node:os');
        const { tmpdir } = await import('node:os');

        const resolvedPath = resolve(sourcePath);

        if (!existsSync(resolvedPath)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Path does not exist: ${resolvedPath}`,
              },
            },
            { command: 'agent install' },
          );
          process.exitCode = 4;
          return;
        }

        let agentDir: string;
        let agentName: string;
        let tempDir: string | null = null;

        const isCantzArchive = resolvedPath.endsWith('.cantz') && statSync(resolvedPath).isFile();

        if (isCantzArchive) {
          // Extract ZIP to temp directory
          const { execFileSync } = await import('node:child_process');
          tempDir = join(tmpdir(), `cleo-agent-install-${Date.now()}`);
          mkdirSync(tempDir, { recursive: true });

          try {
            execFileSync('unzip', ['-o', '-q', resolvedPath, '-d', tempDir], {
              encoding: 'utf-8',
              timeout: 30000,
            });
          } catch (unzipErr) {
            if (tempDir) rmSync(tempDir, { recursive: true, force: true });
            cliOutput(
              {
                success: false,
                error: {
                  code: 'E_VALIDATION',
                  message: `Failed to extract .cantz archive: ${String(unzipErr)}`,
                },
              },
              { command: 'agent install' },
            );
            process.exitCode = 6;
            return;
          }

          // Find the top-level directory inside the extracted archive
          const { readdirSync } = await import('node:fs');
          const topLevel = readdirSync(tempDir).filter((entry) => {
            const entryPath = join(tempDir as string, entry);
            return statSync(entryPath).isDirectory();
          });

          if (topLevel.length !== 1) {
            if (tempDir) rmSync(tempDir, { recursive: true, force: true });
            cliOutput(
              {
                success: false,
                error: {
                  code: 'E_VALIDATION',
                  message: `Archive must contain exactly one top-level directory, found ${topLevel.length}`,
                },
              },
              { command: 'agent install' },
            );
            process.exitCode = 6;
            return;
          }

          agentName = topLevel[0];
          agentDir = join(tempDir, agentName);
        } else if (statSync(resolvedPath).isDirectory()) {
          agentDir = resolvedPath;
          agentName = basename(resolvedPath);
        } else {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Path must be a .cantz file or a directory: ${resolvedPath}`,
              },
            },
            { command: 'agent install' },
          );
          process.exitCode = 6;
          return;
        }

        // Validate persona.cant exists
        const personaPath = join(agentDir, 'persona.cant');
        if (!existsSync(personaPath)) {
          if (tempDir) rmSync(tempDir, { recursive: true, force: true });
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Agent directory must contain persona.cant: ${personaPath}`,
              },
            },
            { command: 'agent install' },
          );
          process.exitCode = 6;
          return;
        }

        // Determine target tier directory
        const isGlobal = opts['global'] === true;
        let targetRoot: string;

        if (isGlobal) {
          const home = homedir();
          const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
          targetRoot = join(xdgData, 'cleo', 'cant', 'agents');
        } else {
          targetRoot = join(process.cwd(), '.cleo', 'cant', 'agents');
        }

        const targetDir = join(targetRoot, agentName);

        // Copy agent directory to target
        mkdirSync(targetRoot, { recursive: true });
        cpSync(agentDir, targetDir, { recursive: true, force: true });

        // Cleanup temp directory if we extracted from .cantz
        if (tempDir) {
          rmSync(tempDir, { recursive: true, force: true });
        }

        // Best-effort agent registration in signaldock.db
        let registered = false;
        try {
          const persona = readFileSync(join(targetDir, 'persona.cant'), 'utf-8');
          // Extract display name from persona.cant (best-effort parse)
          const descMatch = persona.match(/description:\s*"([^"]+)"/);
          const displayName = descMatch?.[1] ?? agentName;

          const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
          await getDb();
          const registry = new AgentRegistryAccessor(process.cwd());
          const existing = await registry.get(agentName);

          if (!existing) {
            await registry.register({
              agentId: agentName,
              displayName,
              apiKey: 'local-installed',
              apiBaseUrl: 'local',
              classification: 'specialist',
              privacyTier: 'private',
              capabilities: [],
              skills: [],
              transportType: 'http',
              transportConfig: {},
              isActive: false,
            });
            registered = true;
          }
        } catch {
          // Registration is best-effort — do not fail the install
        }

        cliOutput(
          {
            success: true,
            data: {
              agent: agentName,
              tier: isGlobal ? 'global' : 'project',
              path: targetDir,
              registered,
            },
          },
          { command: 'agent install' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_INSTALL', message: String(err) } },
          { command: 'agent install' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent pack <dir> ---
  /**
   * Package an agent directory into a `.cantz` ZIP archive.
   *
   * Validates that the source directory contains `persona.cant`, then
   * creates a ZIP archive named `<dirname>.cantz` in the current working
   * directory.
   *
   * @task T438
   * @epic T250
   * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
   */
  agent
    .command('pack <dir>')
    .description('Package an agent directory as a .cantz archive')
    .action(async (dir: string) => {
      try {
        const { existsSync, statSync } = await import('node:fs');
        const { resolve, basename, dirname } = await import('node:path');
        const { execFileSync } = await import('node:child_process');

        const resolvedDir = resolve(dir);

        if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_NOT_FOUND',
                message: `Directory does not exist: ${resolvedDir}`,
              },
            },
            { command: 'agent pack' },
          );
          process.exitCode = 4;
          return;
        }

        // Validate persona.cant exists
        const { join } = await import('node:path');
        const personaPath = join(resolvedDir, 'persona.cant');
        if (!existsSync(personaPath)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Agent directory must contain persona.cant: ${personaPath}`,
              },
            },
            { command: 'agent pack' },
          );
          process.exitCode = 6;
          return;
        }

        const agentName = basename(resolvedDir);
        const archiveName = `${agentName}.cantz`;
        const archivePath = resolve(archiveName);
        const parentDir = dirname(resolvedDir);

        // Create ZIP archive — run zip from parent directory so the
        // archive contains agentName/ as the top-level directory
        try {
          execFileSync('zip', ['-r', archivePath, agentName], {
            cwd: parentDir,
            encoding: 'utf-8',
            timeout: 30000,
          });
        } catch (zipErr) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_PACK',
                message: `Failed to create archive: ${String(zipErr)}`,
              },
            },
            { command: 'agent pack' },
          );
          process.exitCode = 1;
          return;
        }

        // Get file count and archive size
        const archiveStats = statSync(archivePath);
        const { readdirSync } = await import('node:fs');
        let fileCount = 0;
        const countFiles = (dirPath: string): void => {
          const entries = readdirSync(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              fileCount++;
            } else if (entry.isDirectory()) {
              countFiles(join(dirPath, entry.name));
            }
          }
        };
        countFiles(resolvedDir);

        cliOutput(
          {
            success: true,
            data: {
              archive: archivePath,
              agent: agentName,
              files: fileCount,
              size: archiveStats.size,
            },
          },
          { command: 'agent pack' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_PACK', message: String(err) } },
          { command: 'agent pack' },
        );
        process.exitCode = 1;
      }
    });

  // --- cleo agent create ---
  /**
   * Scaffold a complete agent package with persona.cant, manifest.json,
   * and optional expertise seed files.
   *
   * Creates a directory structure conforming to the CANTZ package standard
   * (docs/specs/CANTZ-PACKAGE-STANDARD.md) with role-based persona templates
   * derived from the starter-bundle canonical agents.
   *
   * Template roles:
   * - **orchestrator**: read-only tools, high tier, dispatch-focused
   * - **lead**: read-only tools, mid tier, task decomposition
   * - **worker**: full tool access, mid tier, code execution
   * - **docs-worker**: documentation-focused worker variant
   *
   * @task T439
   * @epic T250
   * @see docs/specs/CANTZ-PACKAGE-STANDARD.md
   * @see packages/cleo-os/starter-bundle/agents/ — canonical format reference
   */
  agent
    .command('create')
    .description('Scaffold a new agent package with persona.cant and manifest.json')
    .requiredOption('--name <name>', 'Agent name (kebab-case)')
    .requiredOption('--role <role>', 'Agent role: orchestrator, lead, worker, or docs-worker')
    .option('--tier <tier>', 'Agent tier: low, mid, or high (defaults based on role)')
    .option('--team <teamName>', 'Team this agent belongs to')
    .option('--domain <description>', 'Domain description for file permissions and context')
    .option('--global', 'Create in global tier (~/.local/share/cleo/cant/agents/)')
    .option('--seed-brain', 'Create expertise/mental-model-seed.md and seed a BRAIN observation')
    .option('--parent <parentAgent>', 'Parent agent name in the hierarchy')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');

        const name = opts['name'] as string;
        const role = opts['role'] as string;
        const tier = (opts['tier'] as string | undefined) ?? inferTierFromRole(role);
        const team = opts['team'] as string | undefined;
        const domain = opts['domain'] as string | undefined;
        const isGlobal = opts['global'] === true;
        const seedBrain = opts['seedBrain'] === true;
        const parent = opts['parent'] as string | undefined;

        // Validate role
        const validRoles = ['orchestrator', 'lead', 'worker', 'docs-worker'];
        if (!validRoles.includes(role)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Invalid role "${role}". Must be one of: ${validRoles.join(', ')}`,
                fix: `cleo agent create --name ${name} --role worker`,
              },
            },
            { command: 'agent create' },
          );
          process.exitCode = 6;
          return;
        }

        // Validate tier
        const validTiers = ['low', 'mid', 'high'];
        if (!validTiers.includes(tier)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Invalid tier "${tier}". Must be one of: ${validTiers.join(', ')}`,
                fix: `cleo agent create --name ${name} --role ${role} --tier mid`,
              },
            },
            { command: 'agent create' },
          );
          process.exitCode = 6;
          return;
        }

        // Validate name is kebab-case
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Agent name must be kebab-case: "${name}"`,
                fix: 'Use lowercase letters, numbers, and hyphens. Must start with a letter.',
              },
            },
            { command: 'agent create' },
          );
          process.exitCode = 6;
          return;
        }

        // Determine target directory
        let targetRoot: string;
        if (isGlobal) {
          const home = homedir();
          const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
          targetRoot = join(xdgData, 'cleo', 'cant', 'agents');
        } else {
          targetRoot = join(process.cwd(), '.cleo', 'cant', 'agents');
        }

        const agentDir = join(targetRoot, name);

        // Check if agent directory already exists
        if (existsSync(agentDir)) {
          cliOutput(
            {
              success: false,
              error: {
                code: 'E_VALIDATION',
                message: `Agent directory already exists: ${agentDir}`,
                fix: 'Remove the existing directory or choose a different name.',
              },
            },
            { command: 'agent create' },
          );
          process.exitCode = 6;
          return;
        }

        // Create directory structure
        mkdirSync(agentDir, { recursive: true });

        // Generate persona.cant from role template
        const personaContent = generatePersonaCant({
          name,
          role,
          tier,
          team,
          domain,
          parent,
        });
        writeFileSync(join(agentDir, 'persona.cant'), personaContent, 'utf-8');

        // Generate manifest.json
        const manifest = generateManifest({ name, role, tier, domain });
        writeFileSync(
          join(agentDir, 'manifest.json'),
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf-8',
        );

        // Track created files for summary
        const createdFiles: string[] = [
          join(agentDir, 'persona.cant'),
          join(agentDir, 'manifest.json'),
        ];

        // Generate team config if team specified
        if (team) {
          const teamConfigContent = generateTeamConfig(name, role, team);
          writeFileSync(join(agentDir, 'team-config.cant'), teamConfigContent, 'utf-8');
          createdFiles.push(join(agentDir, 'team-config.cant'));
        }

        // Seed brain expertise if requested
        if (seedBrain) {
          const expertiseDir = join(agentDir, 'expertise');
          mkdirSync(expertiseDir, { recursive: true });
          const seedContent = generateMentalModelSeed(name, role, domain);
          writeFileSync(join(expertiseDir, 'mental-model-seed.md'), seedContent, 'utf-8');
          createdFiles.push(join(expertiseDir, 'mental-model-seed.md'));

          // Best-effort BRAIN observation via CLI
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            await execFileAsync(
              'cleo',
              [
                'observe',
                `Agent ${name} created with role ${role}`,
                '--title',
                `Agent creation: ${name}`,
              ],
              { encoding: 'utf-8', timeout: 10000 },
            ).catch(() => {
              // Best-effort — do not fail create if observe fails
            });
          } catch {
            // Best-effort — do not fail create if observe fails
          }
        }

        // Best-effort agent registration in signaldock.db
        let registered = false;
        try {
          const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
          await getDb();
          const registry = new AgentRegistryAccessor(process.cwd());
          const existing = await registry.get(name);

          if (!existing) {
            const descMatch = personaContent.match(/description:\s*"([^"]+)"/);
            const displayName = descMatch?.[1] ?? name;

            await registry.register({
              agentId: name,
              displayName,
              apiKey: 'local-created',
              apiBaseUrl: 'local',
              classification: role,
              privacyTier: 'private',
              capabilities: [],
              skills: [],
              transportType: 'http',
              transportConfig: {},
              isActive: false,
            });
            registered = true;
          }
        } catch {
          // Registration is best-effort — do not fail the create
        }

        cliOutput(
          {
            success: true,
            data: {
              agent: name,
              role,
              tier,
              directory: agentDir,
              scope: isGlobal ? 'global' : 'project',
              files: createdFiles,
              registered,
              brainSeeded: seedBrain,
            },
          },
          { command: 'agent create' },
        );
      } catch (err) {
        cliOutput(
          { success: false, error: { code: 'E_CREATE', message: String(err) } },
          { command: 'agent create' },
        );
        process.exitCode = 1;
      }
    });
}

// ---------------------------------------------------------------------------
// Agent create template helpers
// ---------------------------------------------------------------------------

/** Agent role type for template generation. */
type AgentRole = 'orchestrator' | 'lead' | 'worker' | 'docs-worker';

/** Parameters for persona.cant generation. */
interface PersonaParams {
  name: string;
  role: string;
  tier: string;
  team?: string;
  domain?: string;
  parent?: string;
}

/** Parameters for manifest.json generation. */
interface ManifestParams {
  name: string;
  role: string;
  tier: string;
  domain?: string;
}

/**
 * Infer the default tier from the agent role.
 *
 * - orchestrator -> high
 * - lead -> mid
 * - worker -> mid
 * - docs-worker -> mid
 *
 * @param role - The agent role string.
 * @returns The inferred tier string.
 */
function inferTierFromRole(role: string): string {
  if (role === 'orchestrator') return 'high';
  return 'mid';
}

/**
 * Generate a `persona.cant` file from role-based templates.
 *
 * Templates are derived from the canonical starter-bundle agents at
 * `packages/cleo-os/starter-bundle/agents/`. Each role maps to a
 * specific set of tools, permissions, context sources, and behavioral
 * hooks.
 *
 * @param params - Agent persona parameters.
 * @returns The complete persona.cant file content.
 *
 * @see packages/cleo-os/starter-bundle/agents/cleo-orchestrator.cant
 * @see packages/cleo-os/starter-bundle/agents/dev-lead.cant
 * @see packages/cleo-os/starter-bundle/agents/code-worker.cant
 * @see packages/cleo-os/starter-bundle/agents/docs-worker.cant
 */
function generatePersonaCant(params: PersonaParams): string {
  const { name, role, tier, team, domain, parent } = params;

  switch (role as AgentRole) {
    case 'orchestrator':
      return generateOrchestratorPersona(name, tier, team, parent);
    case 'lead':
      return generateLeadPersona(name, tier, team, domain, parent);
    case 'worker':
      return generateWorkerPersona(name, tier, team, domain, parent);
    case 'docs-worker':
      return generateDocsWorkerPersona(name, tier, team, domain, parent);
    default:
      return generateWorkerPersona(name, tier, team, domain, parent);
  }
}

/**
 * Generate an orchestrator persona.cant.
 *
 * Orchestrators coordinate work but do not execute code. They hold
 * read-only core tools (Read, Grep, Glob) plus dispatch tools for
 * routing work to leads and workers.
 *
 * @param name - Agent name (kebab-case).
 * @param tier - Agent tier.
 * @param team - Optional team name.
 * @param parent - Optional parent agent.
 * @returns The persona.cant content string.
 */
function generateOrchestratorPersona(
  name: string,
  tier: string,
  team?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '';
  const teamComment = team ? `\n# Team: ${team}` : '';

  return `---
kind: agent
version: "1"
---

# ${name} — orchestrator agent.${teamComment}
# Coordinates the team, classifies work, dispatches to leads/workers.

agent ${name}:
  role: orchestrator${parentLine}
  tier: ${tier}
  description: "Orchestrator agent. Reads task context, classifies work, dispatches to leads, and synthesizes results. Does not execute code — coordinates."
  consult-when: "Cross-team decisions, scope changes, human-in-the-loop escalation, or when a lead reports a blocking ambiguity"

  context_sources:
    - source: decisions
      query: "recent architectural and project decisions"
      max_entries: 5
    - source: patterns
      query: "project conventions and established patterns"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 2000
    on_load:
      validate: true

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write

  skills:
    - ct-cleo
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_user]

  on SessionStart:
    session "Read active tasks and recent decisions to build situational awareness"
      context: [active-tasks, memory-bridge, recent-decisions]

  on TaskCompleted:
    if **the completed task unblocks downstream work**:
      session "Reassess task queue and dispatch next work"
`;
}

/**
 * Generate a lead persona.cant.
 *
 * Leads decide HOW to build and dispatch work to workers. They hold
 * read-only tools per TEAM-002 / ULTRAPLAN 10.3 — no Edit, Write, or
 * Bash access.
 *
 * @param name - Agent name (kebab-case).
 * @param tier - Agent tier.
 * @param team - Optional team name.
 * @param domain - Optional domain description.
 * @param parent - Optional parent agent.
 * @returns The persona.cant content string.
 */
function generateLeadPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: cleo-orchestrator';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain}.` : '';

  return `---
kind: agent
version: "1"
---

# ${name} — lead agent.${teamComment}
# Decomposes tasks, reviews worker output, decides technical approach.
# MUST NOT hold Edit/Write/Bash tools (TEAM-002 / ULTRAPLAN 10.3).

agent ${name}:
  role: lead${parentLine}
  tier: ${tier}
  description: "Development lead.${domainDesc} Decomposes tasks into concrete implementation steps, reviews worker output, and decides technical approach. Does not write code directly."
  consult-when: "Implementation strategy, code architecture, refactoring direction, task decomposition, or when workers need clarification"

  context_sources:
    - source: patterns
      query: "codebase conventions and architecture patterns"
      max_entries: 5
    - source: decisions
      query: "technical decisions affecting implementation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      read: ["**/*"]

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Grep, Glob]
    dispatch: [dispatch_worker, report_to_orchestrator]

  on SessionStart:
    session "Review current task assignments and worker availability"
      context: [active-tasks, memory-bridge]

  on TaskCompleted:
    if **the completed task introduced new code**:
      session "Review worker output for quality and completeness before reporting to orchestrator"
`;
}

/**
 * Generate a worker persona.cant.
 *
 * Workers execute code changes within declared file globs. They hold
 * the full tool set (Read, Edit, Write, Bash, Glob, Grep) and operate
 * within file permission boundaries derived from the `--domain` flag.
 *
 * @param name - Agent name (kebab-case).
 * @param tier - Agent tier.
 * @param team - Optional team name.
 * @param domain - Optional domain description for file permissions.
 * @param parent - Optional parent agent.
 * @returns The persona.cant content string.
 */
function generateWorkerPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: dev-lead';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain}.` : '';
  const writeGlobs = deriveWriteGlobs(domain);

  return `---
kind: agent
version: "1"
---

# ${name} — worker agent.${teamComment}
# Executes code changes within declared file globs.

agent ${name}:
  role: worker${parentLine}
  tier: ${tier}
  description: "Code worker.${domainDesc} Reads requirements, writes code, runs tests, and validates changes. Operates within declared file permission globs."
  consult-when: "Writing code, fixing bugs, running tests, formatting, or any file modification task"

  context_sources:
    - source: patterns
      query: "coding conventions and testing patterns"
      max_entries: 5
    - source: learnings
      query: "past implementation mistakes and fixes"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ${JSON.stringify(writeGlobs)}
      read: ["**/*"]
      delete: ${JSON.stringify(writeGlobs)}

  skills:
    - ct-cleo
    - ct-dev-workflow
    - ct-task-executor

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned task and read relevant source files before starting work"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify the change compiles and passes lint before proceeding"
`;
}

/**
 * Generate a docs-worker persona.cant.
 *
 * Documentation workers write and maintain documentation within declared
 * documentation file globs. They carry documentation-specific skills and
 * context sources.
 *
 * @param name - Agent name (kebab-case).
 * @param tier - Agent tier.
 * @param team - Optional team name.
 * @param domain - Optional domain description.
 * @param parent - Optional parent agent.
 * @returns The persona.cant content string.
 */
function generateDocsWorkerPersona(
  name: string,
  tier: string,
  team?: string,
  domain?: string,
  parent?: string,
): string {
  const parentLine = parent ? `\n  parent: ${parent}` : '\n  parent: dev-lead';
  const teamComment = team ? `\n# Team: ${team}` : '';
  const domainDesc = domain ? ` Specializes in ${domain} documentation.` : '';

  return `---
kind: agent
version: "1"
---

# ${name} — documentation worker agent.${teamComment}
# Writes and maintains documentation within declared globs.

agent ${name}:
  role: worker${parentLine}
  tier: ${tier}
  description: "Documentation worker.${domainDesc} Writes READMEs, updates guides, adds TSDoc comments, and maintains project documentation. Operates within declared documentation file globs."
  consult-when: "Writing documentation, updating READMEs, adding TSDoc comments, or improving existing docs"

  context_sources:
    - source: patterns
      query: "documentation conventions and style patterns"
      max_entries: 3
    - source: decisions
      query: "architectural decisions needing documentation"
      max_entries: 3
  on_overflow: escalate_tier

  mental_model:
    scope: project
    max_tokens: 1000
    on_load:
      validate: true

  permissions:
    files:
      write: ["docs/**", "**/*.md", "**/*.mdx"]
      read: ["**/*"]
      delete: ["docs/**"]

  skills:
    - ct-cleo
    - ct-documentor
    - ct-docs-write

  tools:
    core: [Read, Edit, Write, Bash, Glob, Grep]

  on SessionStart:
    session "Check assigned documentation task and review existing docs for context"
      context: [active-tasks, memory-bridge]

  on PostToolUse:
    if tool.name == "Write" or tool.name == "Edit":
      session "Verify markdown renders correctly and follows project style conventions"
`;
}

/**
 * Derive file write globs from a domain description string.
 *
 * Maps common domain keywords to appropriate file glob patterns.
 * Falls back to the default `["src/**", "packages/**"]` when no
 * domain is specified or no keywords match.
 *
 * @param domain - Optional domain description string.
 * @returns Array of glob pattern strings for file write permissions.
 */
function deriveWriteGlobs(domain?: string): string[] {
  const defaults = ['src/**', 'packages/**', 'lib/**', 'test/**', 'tests/**'];
  if (!domain) return defaults;

  const lower = domain.toLowerCase();

  // Domain-specific glob mappings
  if (lower.includes('frontend') || lower.includes('ui') || lower.includes('component')) {
    return ['src/**', 'packages/**', 'components/**', 'styles/**', 'public/**', 'test/**'];
  }
  if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) {
    return ['src/**', 'packages/**', 'lib/**', 'api/**', 'test/**', 'tests/**'];
  }
  if (lower.includes('infra') || lower.includes('deploy') || lower.includes('ci')) {
    return ['.github/**', 'infra/**', 'deploy/**', 'scripts/**', 'Dockerfile*'];
  }
  if (lower.includes('test') || lower.includes('qa') || lower.includes('quality')) {
    return ['test/**', 'tests/**', 'src/**/*.test.*', 'src/**/*.spec.*', 'packages/**/*.test.*'];
  }
  if (lower.includes('rust') || lower.includes('crate')) {
    return ['crates/**', 'src/**', 'Cargo.toml', 'test/**'];
  }
  if (lower.includes('doc')) {
    return ['docs/**', '**/*.md', '**/*.mdx'];
  }

  return defaults;
}

/**
 * Generate a `manifest.json` object for the agent package.
 *
 * Conforms to the CANTZ-PACKAGE-STANDARD.md Section 2.3 schema.
 *
 * @param params - Manifest generation parameters.
 * @returns A plain object ready for JSON serialization.
 */
function generateManifest(params: ManifestParams): Record<string, unknown> {
  return {
    name: params.name,
    version: '1.0.0',
    description: `${capitalizeFirst(params.role)} agent${params.domain ? ` for ${params.domain}` : ''}`,
    cant: {
      minVersion: '1',
      tier: params.tier,
      role: params.role === 'docs-worker' ? 'worker' : params.role,
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate a team configuration CANT file fragment.
 *
 * Creates a minimal team-config.cant that declares the agent's
 * membership in a named team.
 *
 * @param name - Agent name.
 * @param role - Agent role.
 * @param team - Team name.
 * @returns The team-config.cant content string.
 */
function generateTeamConfig(name: string, role: string, team: string): string {
  return `---
kind: team-config
version: "1"
---

# Team membership for ${name}

team ${team}:
  member ${name}:
    role: ${role}
    status: active
`;
}

/**
 * Generate a mental model seed markdown file.
 *
 * Creates an initial expertise document with placeholder sections
 * for the agent to populate as it learns about the project domain.
 *
 * @param name - Agent name.
 * @param role - Agent role.
 * @param domain - Optional domain description.
 * @returns The mental-model-seed.md content string.
 */
function generateMentalModelSeed(name: string, role: string, domain?: string): string {
  const domainSection = domain
    ? `## Domain\n\n${domain}\n`
    : `## Domain\n\nTODO: Describe the domain this agent specializes in.\n`;

  return `# Mental Model Seed: ${name}

> Auto-generated at ${new Date().toISOString()}
> Role: ${role}

${domainSection}
## Key Patterns

TODO: Document recurring patterns this agent should recognize.

## Known Pitfalls

TODO: Document common mistakes or anti-patterns in this domain.

## Decision History

TODO: Track important decisions and their rationale.

## Learning Log

TODO: Record discoveries and insights as the agent operates.
`;
}

/**
 * Capitalize the first letter of a string.
 *
 * @param str - Input string.
 * @returns String with the first character uppercased.
 */
function capitalizeFirst(str: string): string {
  if (str.length === 0) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
