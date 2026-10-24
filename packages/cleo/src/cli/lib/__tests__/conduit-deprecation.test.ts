/**
 * Conduit verbs carry a deprecation warning (T13982).
 *
 * D11174 freezes before it deletes: `cleo conduit *`, `cleo orchestrate
 * conduit-*`, `cleo nexus conduit-scan` and `cleo graph living conduit-scan`
 * keep working and only add a `W_DEPRECATED_COMMAND` warning pointing at
 * AgentMBX. These tests pin the warning and that every such verb emits it.
 *
 * @task T13982
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainWarnings } from '@cleocode/core/output';
import { afterEach, describe, expect, it } from 'vitest';
import { warnConduitDeprecated } from '../conduit-deprecation.js';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');

/** The `run` body of the command whose `meta.name` is `name`, from source. */
function runBodyOf(file: string, name: string): string {
  const source = readFileSync(join(commandsDir, file), 'utf-8');
  const at = source.search(new RegExp(`name: '${name}'`));
  expect(at, `${file}: no command named ${name}`).toBeGreaterThan(-1);
  const runAt = source.indexOf('async run(', at);
  return source.slice(runAt, runAt + 400);
}

afterEach(() => {
  drainWarnings();
});

describe('warnConduitDeprecated (T13982)', () => {
  it('adds a W_DEPRECATED_COMMAND warning naming the verb and AgentMBX', () => {
    drainWarnings();
    warnConduitDeprecated('conduit send');
    const warnings = drainWarnings() ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('W_DEPRECATED_COMMAND');
    expect(warnings[0]?.deprecated).toBe('cleo conduit send');
    expect(warnings[0]?.message).toContain('AgentMBX');
  });

  const verbs: Array<[string, string, string]> = [
    ...['status', 'peek', 'start', 'stop', 'send', 'publish', 'subscribe', 'listen'].map(
      (v): [string, string, string] => ['conduit.ts', v, `conduit ${v}`],
    ),
    ...['conduit-status', 'conduit-peek', 'conduit-start', 'conduit-stop', 'conduit-send'].map(
      (v): [string, string, string] => ['orchestrate.ts', v, `orchestrate ${v}`],
    ),
    ['nexus.ts', 'conduit-scan', 'nexus conduit-scan'],
    ['graph.ts', 'conduit-scan', 'graph living conduit-scan'],
    // T13986: agent verbs that call createConduit.
    ...['assign', 'wake', 'reassign', 'poll', 'send'].map(
      (v): [string, string, string] => ['agent.ts', v, `agent ${v}`],
    ),
  ];

  it.each(verbs)('%s `%s` warns before dispatching', (file, name, label) => {
    expect(runBodyOf(file, name)).toContain(`warnConduitDeprecated('${label}')`);
  });
});
