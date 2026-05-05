import { describe, expect, it } from 'vitest';
import { isAbsolutePath } from '../abs-path.js';

describe('isAbsolutePath', () => {
  it('treats POSIX absolute paths as absolute', () => {
    expect(isAbsolutePath('/usr/bin')).toBe(true);
    expect(isAbsolutePath('/')).toBe(true);
  });

  it('treats Windows drive-letter paths as absolute', () => {
    expect(isAbsolutePath('C:\\Users\\me')).toBe(true);
    expect(isAbsolutePath('D:/Projects')).toBe(true);
    expect(isAbsolutePath('z:\\foo')).toBe(true);
  });

  it('treats UNC paths as absolute', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('rejects relative and tilde paths', () => {
    expect(isAbsolutePath('./relative')).toBe(false);
    expect(isAbsolutePath('relative/path')).toBe(false);
    expect(isAbsolutePath('~/home')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });

  it('rejects strings that look like drives but lack a separator', () => {
    expect(isAbsolutePath('C:')).toBe(false);
    expect(isAbsolutePath('CC:\\')).toBe(false);
  });
});
