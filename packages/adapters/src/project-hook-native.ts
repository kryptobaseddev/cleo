/** Provider payload and response adapters for shared project checks (T13344). */
import type { HookJsonValue } from '@cleocode/contracts/heavy-command-hook.js';
import type {
  ProjectHookNativeRequest,
  ProjectHookNativeResult,
} from '@cleocode/contracts/project-hook-delivery.js';
import type { HookOutcome, HookRefUpdate } from '@cleocode/contracts/project-hooks.js';

function flag(argv: readonly string[], name: string): string | undefined {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const index = options.findIndex(
    (arg) => arg === '--' + name || arg.startsWith('--' + name + '='),
  );
  return index < 0
    ? undefined
    : options[index]?.split('=').slice(1).join('=') || options[index + 1];
}
function object(value: HookJsonValue): value is { readonly [key: string]: HookJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function refsFromStdin(body: string): HookRefUpdate[] {
  const refs: HookRefUpdate[] = [];
  for (const line of body.split(/\r?\n/).filter((line) => line.trim())) {
    const fields = line.trim().split(/\s+/);
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    if (
      fields.length !== 4 ||
      !localRef ||
      !remoteRef ||
      !localOid ||
      !remoteOid ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(localOid) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(remoteOid)
    )
      throw new Error('HOOK_GIT_INPUT_INVALID');
    refs.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return refs;
}

/** Normalize actual Git ref updates or native agent JSON; no Claude environment dependency. */
export function normalizeNativeProjectHook(
  argv: readonly string[],
  body: string,
  cwd: string,
): ProjectHookNativeRequest {
  if (Buffer.byteLength(body) > 262144) throw new Error('HOOK_INPUT_TOO_LARGE');
  const source = flag(argv, 'source') ?? 'agent';
  if (source !== 'agent' && source !== 'git') throw new Error('HOOK_SOURCE_INVALID');
  const provider = flag(argv, 'provider') ?? 'claude-code';
  const event = flag(argv, 'event') ?? (source === 'git' ? 'pre-push' : 'PreToolUse');
  const separator = argv.indexOf('--');
  if (source === 'git')
    return {
      cwd,
      provider,
      input: {
        schemaVersion: 1,
        source,
        event,
        refs: refsFromStdin(body),
        remote: {
          name: flag(argv, 'remote-name') ?? (separator < 0 ? '' : argv[separator + 1]) ?? '',
          location:
            flag(argv, 'remote-location') ?? (separator < 0 ? '' : argv[separator + 2]) ?? '',
        },
      },
    };
  const payload = JSON.parse(body || '{}') as HookJsonValue;
  if (!object(payload)) throw new Error('HOOK_AGENT_INPUT_INVALID');
  return {
    cwd: typeof payload.cwd === 'string' ? payload.cwd : cwd,
    provider,
    nativeEvent: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : event,
    input: { schemaVersion: 1, source, event, toolInput: payload.tool_input ?? {} },
  };
}

/** Produce advisory-only native output; project blocks apply solely to Git. */
export function renderNativeProjectHook(
  request: ProjectHookNativeRequest,
  outcomes: HookOutcome[],
): ProjectHookNativeResult {
  const message = outcomes
    .filter((outcome) => outcome.status !== 'pass' && outcome.status !== 'skip')
    .map(
      (outcome) =>
        'CLEO project hook ' +
        outcome.id +
        ': ' +
        outcome.status +
        ' (' +
        outcome.code +
        ')' +
        (outcome.message ? ': ' + outcome.message : ''),
    )
    .join('\n')
    .slice(0, 8192);
  if (request.input.source === 'agent')
    return {
      exitCode: 0,
      stderr: '',
      stdout: message
        ? JSON.stringify(
            request.provider === 'opencode'
              ? { context: message }
              : request.input.event === 'PreToolUse'
                ? {
                    hookSpecificOutput: {
                      hookEventName: request.nativeEvent ?? request.input.event,
                      additionalContext: message,
                    },
                  }
                : { systemMessage: message },
          ) + '\n'
        : '',
    };
  return {
    stdout: '',
    stderr: message ? message + '\n' : '',
    exitCode: outcomes.some(
      (outcome) => outcome.blocks && outcome.status !== 'infrastructure-error',
    )
      ? 1
      : 0,
  };
}
