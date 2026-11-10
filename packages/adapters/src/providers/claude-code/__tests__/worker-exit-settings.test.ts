/**
 * A spawned claude-code worker reports its own exit through a SessionEnd hook
 * that runs `cleo orchestrate worker-exit` for its instance (T14359).
 *
 * @task T14359
 */

import { describe, expect, it } from 'vitest';
import { trackedWorkerInstanceId, workerExitSettings } from '../spawn.js';

describe('workerExitSettings (T14359)', () => {
  it('installs one SessionEnd command hook naming the instance', () => {
    const settings = JSON.parse(workerExitSettings('claude-1-abc')) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(Object.keys(settings.hooks)).toEqual(['SessionEnd']);
    expect(settings.hooks.SessionEnd?.[0]?.hooks).toEqual([
      { type: 'command', command: 'cleo orchestrate worker-exit --instance claude-1-abc' },
    ]);
  });
});

describe('trackedWorkerInstanceId (T14359)', () => {
  it('adopts a shell-safe pre-assigned id only', () => {
    expect(trackedWorkerInstanceId({ workerInstanceId: 'claude-code-1-abc' })).toBe(
      'claude-code-1-abc',
    );
    expect(trackedWorkerInstanceId({ workerInstanceId: 'x; rm -rf /' })).toBeUndefined();
    expect(trackedWorkerInstanceId({})).toBeUndefined();
    expect(trackedWorkerInstanceId(undefined)).toBeUndefined();
  });
});
