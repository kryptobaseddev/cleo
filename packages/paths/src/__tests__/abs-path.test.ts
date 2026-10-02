import { describe, expect, it } from 'vitest';
import { isAbsolutePath, isVaultRemotePath, VAULT_REMOTE_PATH_PREFIX } from '../abs-path.js';

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

describe('isVaultRemotePath (T13006)', () => {
  it('recognises the cloud vault placeholder and nothing else', () => {
    expect(
      isVaultRemotePath(`${VAULT_REMOTE_PATH_PREFIX}nexus_project_registry:["p2"]:project_path`),
    ).toBe(true);
    // Resolved against a working directory (T13021).
    expect(isVaultRemotePath(`/tmp/x/${VAULT_REMOTE_PATH_PREFIX}t:["a/b"]:path`)).toBe(true);
    expect(isVaultRemotePath(`C:\\x\\${VAULT_REMOTE_PATH_PREFIX}t:1:path`)).toBe(true);
    expect(isVaultRemotePath('/home/me/p2')).toBe(false);
    expect(isVaultRemotePath('/home/me/not-cleo-vault-remote:x')).toBe(false);
    expect(isVaultRemotePath('superseded:p2')).toBe(false);
    expect(isVaultRemotePath('')).toBe(false);
    expect(isVaultRemotePath(null)).toBe(false);
    expect(isVaultRemotePath(undefined)).toBe(false);
  });
});
