/**
 * The strict envelope helper must reject what the lenient one accepted (gh#1223).
 *
 * @task T12164
 */

import { describe, expect, it } from 'vitest';
import { assertSpawnReachedCommand, parseSoleEnvelope } from './envelope.js';

/** The exact stdout measured from a real `cleo` write on 2026-09-12. */
const POLLUTED =
  '{"success":true,"data":{"count":1}}\n' +
  'AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.';

const CLEAN = '{"success":true,"data":{"count":1},"meta":{"operation":"tasks.add-batch"}}';

/** The implementation this replaces, kept verbatim as a counter-example. */
function lenientParse(stdout: string): unknown {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const line = lines.find((l) => l.trim().startsWith('{'));
  return line === undefined ? undefined : JSON.parse(line);
}

describe('parseSoleEnvelope — ADR-086, one envelope per call', () => {
  it('accepts a clean envelope', () => {
    expect(parseSoleEnvelope(CLEAN).success).toBe(true);
  });

  it('REJECTS a banner appended after the envelope', () => {
    expect(() => parseSoleEnvelope(POLLUTED)).toThrow();
  });

  it('the lenient helper ACCEPTED that same output — which is why the defect survived', () => {
    // Not decoration. This is the counter-example that justifies the change:
    // every spawned-CLI test in the repo used the lenient form, so stdout
    // impurity was untestable by construction and `ai@6`'s console.info banner
    // reached stdout unchallenged.
    expect(lenientParse(POLLUTED)).toEqual({ success: true, data: { count: 1 } });
  });

  it('rejects empty stdout rather than returning undefined', () => {
    expect(() => parseSoleEnvelope('   ')).toThrow();
  });
});

describe('assertSpawnReachedCommand', () => {
  it('fails when the spawned CLI died during startup', () => {
    // Measured: a dist with an unbuilt workspace dependency exits this way
    // BEFORE any command runs, so assertions about its output are vacuous.
    const startupFailure =
      '{"success":false,"error":{"code":1,"message":"Cannot find module \'…\'","codeName":"E_CLI_UNCAUGHT"}}';
    expect(() => assertSpawnReachedCommand(startupFailure)).toThrow();
  });

  it('passes when a real command produced the envelope', () => {
    expect(() => assertSpawnReachedCommand(CLEAN)).not.toThrow();
  });

  it('defers to the caller when stdout is unparseable', () => {
    // Unparseable stdout is the failure under test; masking it here would hide
    // the very thing parseSoleEnvelope exists to report.
    expect(() => assertSpawnReachedCommand(POLLUTED)).not.toThrow();
  });
});
