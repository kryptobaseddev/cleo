/** Cold-path, project-local provider delivery of activated shared checks (T13344). */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  editJsonConfigFile,
  readManagedJsonConfigFile,
  withFileLock,
  writeFileAtomic,
} from '@cleocode/caamp/atomic';
import { GENERATED_PROVIDER_HOOK_PROFILES } from '@cleocode/caamp/hooks';
import type { HookJsonValue } from '@cleocode/contracts/heavy-command-hook.js';
import {
  type HookConfigEdit,
  type HookConfigObject,
  type ProjectHookDeliveryOptions,
  type ProjectHookDeliveryReceipt,
  ProjectHookDeliveryReceiptSchema,
  type ProjectHookDeliveryResult,
  type ProjectHookEntryInspection,
} from '@cleocode/contracts/project-hook-delivery.js';
import { discoveryEnv } from '@cleocode/core/git/work-tree';
import { readFileText } from '@cleocode/core/tools/fs';
import { excludeHookFileFromGit } from './providers/shared/heavy-command-hook-install.js';

const MARKER = '# cleo-project-hook:v1';
const BINARIES: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  kimi: 'kimi',
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const object = (value: HookJsonValue | undefined): value is HookConfigObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function probeVersion(provider: string): string | undefined {
  const binary = BINARIES[provider];
  if (!binary) return undefined;
  try {
    return execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).match(/\d+\.\d+\.\d+/)?.[0];
  } catch {
    return undefined;
  }
}

/** Resolve an existing ancestor and refuse provider config symlink escapes. */
async function localTarget(root: string, path: string): Promise<string> {
  if ((await realpath(root)) === (await realpath(homedir())))
    throw new Error('HOOK_GLOBAL_CONFIG_FORBIDDEN');
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    throw new Error('HOOK_CONFIG_PATH_ESCAPE');
  const target = resolve(root, path);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const resolved = await realpath(ancestor);
  const rel = relative(await realpath(root), resolved);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('HOOK_CONFIG_PATH_ESCAPE');
  if (existsSync(target) && (await lstat(target)).isSymbolicLink())
    throw new Error('HOOK_CONFIG_SYMLINK');
  return target;
}

function command(provider: string, event: string): string {
  // Only registry IDs and canonical event identifiers are interpolated; never project paths.
  const invocation = 'cleo hook run --source agent --provider ' + provider + ' --event ' + event;
  return (
    'if command -v cleo >/dev/null 2>&1 && [ "$(cleo hook run --probe </dev/null 2>/dev/null)" = "CLEO_PROJECT_HOOK_V1" ]; then ' +
    invocation +
    '; else printf "%s\\n" "[cleo hook] project runner unavailable; operation allowed. Run cleo doctor hooks." >&2; fi # cleo-hook ' +
    MARKER
  );
}

function desiredEntries(provider: string, events: string[]): ProjectHookDeliveryReceipt['entries'] {
  const profile = GENERATED_PROVIDER_HOOK_PROFILES[provider];
  const result: ProjectHookDeliveryReceipt['entries'] = [];
  for (const canonical of new Set(events)) {
    const mapping = Object.entries(profile?.mappings ?? {}).find(
      ([event]) => event === canonical,
    )?.[1];
    if (!mapping?.supported || !mapping.nativeName || !/^[A-Za-z][A-Za-z0-9]*$/.test(canonical))
      continue;
    const cmd = command(provider, canonical);
    result.push({
      event: mapping.nativeName,
      command: cmd,
      hash: hash(JSON.stringify(entry(cmd))),
    });
  }
  return result;
}

function entry(cmd: string, timeout: number | null = 130): HookJsonValue {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: cmd, ...(timeout === null ? {} : { timeout }) }],
  };
}

async function receiptAt(path: string): Promise<ProjectHookDeliveryReceipt | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
      throw new Error('HOOK_RECEIPT_UNSAFE');
    return ProjectHookDeliveryReceiptSchema.parse(
      JSON.parse((await readFileText({ path, maxBytes: 262144 })).content),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error('HOOK_RECEIPT_INVALID');
  }
}

function entryCommand(value: HookJsonValue): string | undefined {
  if (!object(value) || !Array.isArray(value.hooks) || value.hooks.length !== 1) return undefined;
  const hook = value.hooks[0];
  return object(hook) && typeof hook.command === 'string' ? hook.command : undefined;
}

function inspectEntries(
  config: HookConfigObject,
  receipt: ProjectHookDeliveryReceipt | undefined,
): ProjectHookEntryInspection[] {
  const result: ProjectHookEntryInspection[] = [];
  if (!object(config.hooks)) return result;
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const [index, value] of entries.entries()) {
      const digest = hash(JSON.stringify(value));
      const owned = receipt?.entries.some((item) => item.event === event && item.hash === digest);
      result.push({
        event,
        index,
        hash: digest,
        owner: owned ? 'project' : 'unknown',
        provenance: owned ? 'cleo-receipt' : 'unknown',
        ...(owned ? { source: '.cleo/hooks.json' } : {}),
      });
    }
  }
  return result;
}

function configEdits(
  config: HookConfigObject,
  prior: ProjectHookDeliveryReceipt | undefined,
  desired: ProjectHookDeliveryReceipt['entries'],
): HookConfigEdit[] {
  if (config.hooks !== undefined && !object(config.hooks))
    throw new Error('HOOK_CONFIG_HOOKS_SHAPE');
  const hooks = object(config.hooks) ? config.hooks : {};
  const edits: HookConfigEdit[] = [];
  const found = new Set<string>();
  const retained = new Set<string>();
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new Error('HOOK_CONFIG_EVENT_SHAPE');
    for (let index = entries.length - 1; index >= 0; index--) {
      const value = entries[index];
      if (value === undefined) continue;
      const cmd = entryCommand(value);
      const owns = prior?.entries.find((old) => old.event === event && old.command === cmd);
      const hasMarker = JSON.stringify(value).includes(MARKER);
      if (!owns && hasMarker) throw new Error('HOOK_CONFIG_UNATTRIBUTED_ENTRY');
      if (!owns) continue;
      if (hash(JSON.stringify(value)) !== owns.hash || found.has(event + ':' + cmd))
        throw new Error('HOOK_CONFIG_MANAGED_DRIFT');
      found.add(event + ':' + cmd);
      if (desired.some((next) => next.event === event && next.hash === owns.hash))
        retained.add(event + ':' + cmd);
      else edits.push({ path: ['hooks', event, index] });
    }
  }
  for (const next of desired) {
    const entries = hooks[next.event];
    if (entries !== undefined && !Array.isArray(entries))
      throw new Error('HOOK_CONFIG_EVENT_SHAPE');
    if (retained.has(next.event + ':' + next.command)) continue;
    const removals = edits.filter((change) => change.path[1] === next.event).length;
    edits.push(
      Array.isArray(entries)
        ? {
            path: ['hooks', next.event, entries.length - removals],
            value: entry(next.command),
            insert: true,
          }
        : { path: ['hooks', next.event], value: [entry(next.command)] },
    );
  }
  return edits;
}

function pluginSource(events: string[]): string {
  if (!events.includes('PreToolUse'))
    return '// CLEO project hooks v1; no supported bindings.\nexport default async () => ({});\n';
  return [
    '// CLEO project hooks v1; managed by a local hash receipt.',
    'import { execFile } from "node:child_process";',
    'export const CleoProjectHooks = async ({directory}) => {',
    ' const contexts = new Map();',
    ' return {',
    ' "tool.execute.before": async (input, output) => {',
    '  const context = await new Promise(done => {',
    '   const child = execFile("cleo", ["hook","run","--source","agent","--provider","opencode","--event","PreToolUse"], {cwd:directory, timeout:130000, maxBuffer:32768}, (error, stdout, stderr) => {',
    '    if(error) {done("CLEO project hook unavailable; operation allowed. Run cleo doctor hooks."); return}',
    '    try {const answer=JSON.parse(stdout || "{}"); done(typeof answer.context === "string" ? answer.context : stderr ? "CLEO project hook infrastructure warning; operation allowed. Run cleo doctor hooks." : "")} catch {done("CLEO project hook response unavailable; operation allowed. Run cleo doctor hooks.")}',
    '   });',
    '   child.on("error", () => done("CLEO project hook unavailable; operation allowed. Run cleo doctor hooks."));',
    '   child.stdin?.on("error", () => {}); child.stdin?.end(JSON.stringify({tool_name:input.tool,tool_input:output.args,cwd:directory}));',
    '  });',
    '  if(context && input.callID) {if(contexts.size >= 128) contexts.delete(contexts.keys().next().value); contexts.set(input.callID, context.slice(0,8192))}',
    ' },',
    ' "tool.execute.after": async (input, output) => {',
    '  const context=contexts.get(input.callID); contexts.delete(input.callID);',
    '  if(context && typeof output.output === "string") output.output += "\\n\\n" + context;',
    ' },',
    ' };',
    '};',
    '',
  ].join('\n');
}

async function deliverProvider(
  options: ProjectHookDeliveryOptions,
  provider: string,
): Promise<ProjectHookDeliveryResult> {
  const profile = GENERATED_PROVIDER_HOOK_PROFILES[provider];
  const capability = profile?.projectDelivery;
  const version = probeVersion(provider);
  const result: ProjectHookDeliveryResult = {
    provider,
    version,
    state: 'unsupported',
    capability:
      version && capability?.verifiedVersions.includes(version)
        ? 'verified'
        : version && capability?.documentedVersions.includes(version)
          ? 'documented'
          : 'unverified',
    nativeTrust: 'unverified',
    provenance: 'unknown',
    diagnostics: [],
  };
  if (result.capability !== 'verified') result.diagnostics.push('HOOK_LIVE_DELIVERY_UNVERIFIED');
  if (!capability?.configPath) {
    result.diagnostics.push('HOOK_PROJECT_LOCAL_UNSUPPORTED');
    return result;
  }
  const configPath = capability.configPath;
  const target = await localTarget(options.projectRoot, configPath);
  result.configPath = target;
  const receiptPath = join(options.stateDir, 'provider-' + provider + '.json');
  const prior = await receiptAt(receiptPath);
  if (prior && (prior.provider !== provider || prior.configPath !== target))
    throw new Error('HOOK_RECEIPT_PATH_MISMATCH');
  if (prior) {
    const allowed = desiredEntries(provider, Object.keys(profile.mappings));
    // Exact former v1 generator output is known; never derive ownership from a marker alone.
    for (const [canonical, mapping] of Object.entries(profile.mappings)) {
      if (!mapping?.supported || !mapping.nativeName) continue;
      const former =
        'cleo hook run --source agent --provider ' +
        provider +
        ' --event ' +
        canonical +
        ' # cleo-hook ' +
        MARKER;
      for (const generated of [former, command(provider, canonical)]) {
        allowed.push({
          event: mapping.nativeName,
          command: generated,
          hash: hash(JSON.stringify(entry(generated, null))),
        });
      }
    }
    const valid =
      profile.hookSystem === 'plugin'
        ? prior.entries.length === 1 &&
          prior.entries[0]?.event === 'plugin' &&
          prior.entries[0]?.command === 'cleo hook run' &&
          [pluginSource([]), pluginSource(['PreToolUse'])].some(
            (body) => hash(body) === prior.entries[0]?.hash,
          )
        : prior.entries.every((item) =>
            allowed.some(
              (candidate) =>
                candidate.event === item.event &&
                candidate.command === item.command &&
                candidate.hash === item.hash,
            ),
          );
    if (!valid) throw new Error('HOOK_RECEIPT_OWNERSHIP_INVALID');
    result.provenance = 'cleo-receipt';
  }
  if (options.events.length === 0 && !prior && !options.rollback) {
    result.state = 'unsupported';
    result.diagnostics.push('HOOK_NO_AGENT_BINDINGS');
    return result;
  }
  if (!options.enabled && !options.rollback) {
    result.state = 'disabled';
    return result;
  }
  const desired = options.rollback ? [] : desiredEntries(provider, options.events);
  const tracking = spawnSync(
    'git',
    ['-C', options.projectRoot, 'ls-files', '--error-unmatch', '--', capability.configPath],
    { timeout: 2000, stdio: 'ignore', env: discoveryEnv() },
  );
  if (tracking.status === 0) {
    result.state = 'conflict';
    result.diagnostics.push('HOOK_CONFIG_TRACKED_REVIEW_REQUIRED');
    result.integrationSnippet = JSON.stringify(
      { hooks: Object.fromEntries(desired.map((item) => [item.event, [entry(item.command)]])) },
      null,
      2,
    );
    return result;
  }
  if (tracking.error || tracking.signal || tracking.status !== 1)
    throw new Error('HOOK_GIT_TRACKING_UNVERIFIED');
  for (const event of options.events) {
    if (!desired.some((item) => item.command === command(provider, event)))
      result.diagnostics.push('HOOK_EVENT_UNSUPPORTED:' + event);
  }
  if (profile.hookSystem === 'plugin') {
    for (const event of options.events.filter((event) => event !== 'PreToolUse'))
      result.diagnostics.push('HOOK_PLUGIN_EVENT_UNSUPPORTED:' + event);
    if (!options.rollback && !options.events.includes('PreToolUse')) {
      result.state = 'unsupported';
      return result;
    }
    const body = pluginSource(options.events);
    const existing = existsSync(target)
      ? (await readFileText({ path: target, maxBytes: 262144 })).content
      : undefined;
    if (existing !== undefined && (!prior || prior.entries[0]?.hash !== hash(existing))) {
      result.state = 'conflict';
      result.diagnostics.push('HOOK_CONFIG_MANAGED_DRIFT');
      return result;
    }
    if (options.rollback) {
      if (existing !== undefined && !options.dryRun)
        await withFileLock(target, async () => {
          await localTarget(options.projectRoot, configPath);
          const current = existsSync(target)
            ? (await readFileText({ path: target, maxBytes: 262144 })).content
            : undefined;
          if (current !== existing) throw new Error('HOOK_CONFIG_CONCURRENT_EDIT');
          await unlink(target);
        });
      result.state = 'disabled';
      return result;
    }
    result.state = existing === body ? 'current' : 'planned';
    if (!options.dryRun && existing !== body) {
      if (existing === undefined)
        excludeHookFileFromGit(options.projectRoot, capability.configPath);
      await withFileLock(target, async () => {
        await localTarget(options.projectRoot, configPath);
        const current = existsSync(target)
          ? (await readFileText({ path: target, maxBytes: 262144 })).content
          : undefined;
        if (current !== existing) throw new Error('HOOK_CONFIG_CONCURRENT_EDIT');
        await writeFileAtomic({ path: target, content: body });
      });
      await writeFileAtomic({
        path: receiptPath,
        content:
          JSON.stringify({
            schemaVersion: 1,
            provider,
            configPath: target,
            entries: [{ event: 'plugin', command: 'cleo hook run', hash: hash(body) }],
            recordedAt: new Date().toISOString(),
          }) + '\n',
      });
      result.state = 'installed';
      result.provenance = 'cleo-receipt';
    }
    return result;
  }
  const config = await readManagedJsonConfigFile(target);
  result.entries = inspectEntries(config, prior);
  const edits = configEdits(config, prior, desired);
  result.state = edits.length ? 'planned' : 'current';
  if (!options.dryRun) {
    if (!existsSync(target)) excludeHookFileFromGit(options.projectRoot, capability.configPath);
    await editJsonConfigFile(target, (current) => configEdits(current, prior, desired));
    await writeFileAtomic({
      path: receiptPath,
      content:
        JSON.stringify({
          schemaVersion: 1,
          provider,
          configPath: target,
          entries: desired,
          recordedAt: new Date().toISOString(),
        }) + '\n',
    });
    result.state = edits.length ? 'installed' : 'current';
    result.provenance = 'cleo-receipt';
    result.entries = inspectEntries(
      await readManagedJsonConfigFile(target),
      await receiptAt(receiptPath),
    );
  }
  return result;
}

/** Report unsupported bindings even when the same provider delivered other eligible events. */
export function hasUnsupportedProjectHookDelivery(
  results: readonly ProjectHookDeliveryResult[],
): boolean {
  return results.some(
    (result) =>
      result.state === 'unsupported' ||
      result.diagnostics.some(
        (code) =>
          code.startsWith('HOOK_EVENT_UNSUPPORTED:') ||
          code.startsWith('HOOK_PLUGIN_EVENT_UNSUPPORTED:'),
      ),
  );
}

async function validateStateDirectory(options: ProjectHookDeliveryOptions): Promise<void> {
  const gitState = resolve(
    options.projectRoot,
    execFileSync(
      'git',
      [
        '-C',
        options.projectRoot,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'cleo-project-hooks',
      ],
      {
        encoding: 'utf8',
        timeout: 2000,
        maxBuffer: 16384,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: discoveryEnv(),
      },
    ).trim(),
  );
  const parent = await realpath(dirname(gitState));
  if (
    resolve(options.stateDir) !== gitState ||
    (await realpath(dirname(resolve(options.stateDir)))) !== parent
  )
    throw new Error('HOOK_STATE_DIRECTORY_INVALID');
  if (
    existsSync(gitState) &&
    (!(await lstat(gitState)).isDirectory() || (await lstat(gitState)).isSymbolicLink())
  )
    throw new Error('HOOK_STATE_DIRECTORY_INVALID');
}

/** Inspect or sync only project-local entries; no provider trust settings are written. */
export async function syncProjectHookProviders(
  options: ProjectHookDeliveryOptions,
): Promise<ProjectHookDeliveryResult[]> {
  const providers =
    options.providers ??
    Object.entries(GENERATED_PROVIDER_HOOK_PROFILES)
      .filter(
        ([id, profile]) =>
          profile.projectDelivery &&
          (probeVersion(id) !== undefined ||
            (profile.projectDelivery.configPath !== null &&
              existsSync(
                join(options.projectRoot, profile.projectDelivery.configPath.split('/')[0] ?? ''),
              ))),
      )
      .map(([id]) => id);
  const outcomes: ProjectHookDeliveryResult[] = [];
  for (const provider of providers) {
    try {
      if (
        !Object.hasOwn(GENERATED_PROVIDER_HOOK_PROFILES, provider) ||
        !/^[a-z][a-z0-9-]*$/.test(provider)
      )
        throw new Error('HOOK_PROVIDER_INVALID');
      await validateStateDirectory(options);
      outcomes.push(
        options.dryRun
          ? await deliverProvider(options, provider)
          : await withFileLock(join(options.stateDir, 'provider-' + provider + '.json'), () =>
              deliverProvider(options, provider),
            ),
      );
    } catch (error) {
      outcomes.push({
        provider,
        state: 'conflict',
        capability: 'unverified',
        nativeTrust: 'unverified',
        provenance: 'unknown',
        diagnostics: [
          error instanceof Error && /^HOOK_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'HOOK_DELIVERY_FAILED',
        ],
      });
    }
  }
  return outcomes;
}
