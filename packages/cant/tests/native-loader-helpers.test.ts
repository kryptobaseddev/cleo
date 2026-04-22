import { describe, expect, it } from 'vitest';
import { validateAgentCantPath } from '../src/native-loader';

describe('native-loader: validateAgentCantPath (R1 Rec 4)', () => {
  const projectRoot = '/mnt/projects/example';

  it('accepts a path that lives inside the project root', () => {
    const cantPath = '/mnt/projects/example/.cleo/cant/agents/foo.cant';
    expect(validateAgentCantPath(cantPath, projectRoot)).toBe(true);
  });

  it('rejects a path that climbs out of the project root', () => {
    const cantPath = '/mnt/projects/example/../../../etc/passwd';
    expect(validateAgentCantPath(cantPath, projectRoot)).toBe(false);
  });

  it('rejects a sibling-directory path', () => {
    const cantPath = '/mnt/projects/other/foo.cant';
    expect(validateAgentCantPath(cantPath, projectRoot)).toBe(false);
  });

  it('rejects a relative `cantPath`', () => {
    expect(validateAgentCantPath('./foo.cant', projectRoot)).toBe(false);
  });

  it('rejects when the root itself is a relative path', () => {
    expect(
      validateAgentCantPath('/mnt/projects/example/a.cant', './projects'),
    ).toBe(false);
  });

  it('rejects equality with the root (empty relative)', () => {
    expect(validateAgentCantPath(projectRoot, projectRoot)).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(validateAgentCantPath('', projectRoot)).toBe(false);
    expect(validateAgentCantPath('/x', '')).toBe(false);
  });

  it('handles paths with trailing slashes', () => {
    const cantPath = '/mnt/projects/example/.cleo/cant/agents/foo.cant';
    expect(validateAgentCantPath(cantPath, '/mnt/projects/example/')).toBe(
      true,
    );
  });
});
