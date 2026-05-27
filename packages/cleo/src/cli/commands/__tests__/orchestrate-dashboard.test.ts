import { describe, expect, it } from 'vitest';
import { orchestrateCommand } from '../orchestrate.js';

describe('orchestrate dashboard CLI command', () => {
  it('is registered in the orchestrate command manifest', () => {
    expect(orchestrateCommand.subCommands).toHaveProperty('dashboard');
    expect(orchestrateCommand.subCommands?.dashboard?.meta?.name).toBe('dashboard');
  });
});
