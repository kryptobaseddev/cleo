/**
 * Portable-bundle path relocation across root shapes and OSes (T12608).
 *
 * Bundle rows hold the SOURCE machine's paths and are relocated onto the
 * destination's root, so neither side is necessarily this host's OS.
 *
 * @task T12608
 */

import { describe, expect, it } from 'vitest';
import { applyPathMappings } from '../portable-bundle-import.js';
import { isUnderRoot, relocatePath } from '../portable-bundle-relocate.js';

describe('relocatePath — root with a trailing separator', () => {
  it('keeps the boundary: /home/a/proj/x from /home/a/proj/ to /Users/me/new', () => {
    expect(relocatePath('/home/a/proj/x', '/home/a/proj/', '/Users/me/new')).toBe(
      '/Users/me/new/x',
    );
  });

  it('a trailing separator on the target is not doubled', () => {
    expect(relocatePath('/home/a/proj/x', '/home/a/proj', '/Users/me/new/')).toBe(
      '/Users/me/new/x',
    );
  });

  it('the root itself maps to the target root', () => {
    expect(relocatePath('/home/a/proj', '/home/a/proj/', '/Users/me/new')).toBe('/Users/me/new');
  });
});

describe('relocatePath — filesystem roots', () => {
  it('drive root D:\\ keeps every path intact', () => {
    expect(isUnderRoot('D:\\work\\a.db', 'D:\\')).toBe(true);
    expect(relocatePath('D:\\work\\a.db', 'D:\\', 'E:\\')).toBe('E:\\work\\a.db');
  });

  it('POSIX root / keeps every path intact', () => {
    expect(relocatePath('/srv/p/a.db', '/', '/mnt/old')).toBe('/mnt/old/srv/p/a.db');
  });

  it('a drive root does not claim a path on another drive or a relative path', () => {
    expect(isUnderRoot('C:\\x', 'D:\\')).toBe(false);
    expect(isUnderRoot('D:x', 'D:\\')).toBe(false);
  });
});

describe('relocatePath — cross-OS separators', () => {
  it('Windows source onto a POSIX target writes / separators', () => {
    expect(relocatePath('C:\\p\\a\\b.db', 'C:\\p', '/Users/me/new')).toBe('/Users/me/new/a/b.db');
  });

  it('POSIX source onto a Windows target writes \\ separators', () => {
    expect(relocatePath('/home/a/proj/.cleo/x.db', '/home/a/proj', 'C:\\Users\\me\\proj')).toBe(
      'C:\\Users\\me\\proj\\.cleo\\x.db',
    );
  });

  it('applyPathMappings uses the same conversion', () => {
    expect(applyPathMappings('C:\\p\\a\\b', [{ from: 'C:\\p', to: '/Users/me/new' }])).toBe(
      '/Users/me/new/a/b',
    );
  });
});

describe('isUnderRoot — .. escapes are not under the root', () => {
  it('POSIX: proj/../../etc/passwd', () => {
    expect(isUnderRoot('/home/a/proj/../../etc/passwd', '/home/a/proj')).toBe(false);
  });

  it('Windows: proj\\..\\..\\etc', () => {
    expect(isUnderRoot('C:\\home\\proj\\..\\..\\etc', 'C:\\home\\proj')).toBe(false);
  });

  it('a .. that stays inside the root is still under it, and is resolved', () => {
    expect(isUnderRoot('/home/a/proj/x/../y', '/home/a/proj')).toBe(true);
    expect(relocatePath('/home/a/proj/x/../y', '/home/a/proj', '/new')).toBe('/new/y');
  });

  it('an escaping value is left unchanged by relocatePath', () => {
    expect(relocatePath('/home/a/proj/../../etc/passwd', '/home/a/proj', '/new')).toBe(
      '/home/a/proj/../../etc/passwd',
    );
  });
});
