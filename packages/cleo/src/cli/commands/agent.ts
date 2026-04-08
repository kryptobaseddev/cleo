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

  // --- cleo agent remove <id> ---
  agent
    .command('remove <agentId>')
    .description('Remove an agent credential from the local registry')
    .action(async (agentId: string) => {
      try {
        const { AgentRegistryAccessor, getDb } = await import('@cleocode/core/internal');
        await getDb();
        const registry = new AgentRegistryAccessor(process.cwd());

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
}
