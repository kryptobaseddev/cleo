import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type {
  PackageArtifactFile,
  PackageArtifactInventory,
  PackageArtifactPolicy,
} from '@cleocode/contracts/package-artifact';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleoShippedBuildShape,
  CLEO_ARTIFACT_BUDGETS,
  CLEO_ARTIFACT_REQUIREMENTS,
  classifyPackageFilesEntry,
  validatePackageArtifact,
} from '../../src/core/artifacts/validation.js';

// Independent required resources: never generated from the validator's policy.
const resources = [
  'dist/cli/index.js',
  'studio-dist/index.js',
  'studio-dist/handler.js',
  'studio-dist/server/index.js',
  'studio-dist/server/manifest.js',
  'studio-dist/client/_app/immutable/entry/start.a1b2.js',
  'studio-dist/client/_app/immutable/entry/app.c3d4.js',
];
const payload = Buffer.from('export const fixture = true;\n');
const hash = createHash('sha256').update(payload).digest('hex');
const policy: PackageArtifactPolicy = {
  requirements: CLEO_ARTIFACT_REQUIREMENTS,
  budgets: CLEO_ARTIFACT_BUDGETS,
  filesEntries: ['dist', 'studio-dist', '!dist/**/*.map'],
  forbiddenPatterns: ['**/*.map'],
};

function fixture(
  files: readonly PackageArtifactFile[] = resources.map((path) => ({
    path,
    size: payload.length,
    sha256: hash,
  })),
): PackageArtifactInventory {
  return {
    packageName: '@fixture/cli',
    version: '1.0.0',
    source: 'fixture',
    packedBytes: 100,
    files,
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Independently inspect files extracted from a real npm tarball, without reading staging paths. */
function packFixture(filesEntries: string[]): PackageArtifactInventory {
  const root = mkdtempSync(join(tmpdir(), 'caamp-package-artifact-'));
  directories.push(root);
  const source = join(root, 'source');
  const packed = join(root, 'packed');
  const extracted = join(root, 'extracted');
  for (const path of [source, packed, extracted]) mkdirSync(path);
  for (const path of resources) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), payload);
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'artifact-fixture',
      version: '1.0.0',
      type: 'module',
      files: filesEntries,
    }),
  );
  execFileSync('npm', ['pack', '--ignore-scripts', '--offline', '--pack-destination', packed], {
    cwd: source,
    stdio: 'pipe',
    timeout: 20_000,
    env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
  });
  const tarball = join(packed, 'artifact-fixture-1.0.0.tgz');
  execFileSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: 'pipe', timeout: 10_000 });
  const packageRoot = join(extracted, 'package');
  const files: PackageArtifactFile[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const bytes = readFileSync(path);
        files.push({
          path: relative(packageRoot, path).replaceAll('\\', '/'),
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  walk(packageRoot);
  const bytes = readFileSync(tarball);
  return {
    packageName: 'artifact-fixture',
    version: '1.0.0',
    source: 'npm-pack',
    packedBytes: bytes.length,
    tarballSha256: createHash('sha256').update(bytes).digest('hex'),
    files,
  };
}

describe('manifest entry classification', () => {
  it.each([
    ['dist', 'literal', 'dist'],
    ['./dist/', 'literal', 'dist'],
    ['!dist/**/*.map', 'exclusion', 'dist/**/*.map'],
    ['dist/**/*.js', 'glob', 'dist/**/*.js'],
    ['dist/entry?.js', 'glob', 'dist/entry?.js'],
    ['dist/{one,two}.js', 'glob', 'dist/{one,two}.js'],
    ['dist/[ab].js', 'glob', 'dist/[ab].js'],
    ['dist/+(one|two).js', 'glob', 'dist/+(one|two).js'],
    ['dist/file(name).js', 'literal', 'dist/file(name).js'],
    ['dist/file!.js', 'literal', 'dist/file!.js'],
  ])('classifies %s without looking for it on disk', (entry, kind, pattern) => {
    expect(classifyPackageFilesEntry(entry)).toEqual({ entry, kind, pattern, reason: null });
  });

  it.each([
    '',
    '!',
    '!!dist',
    '../escape',
    '/absolute',
    'C:/absolute',
    'dist\\file.js',
    'dist//file',
    ' dist',
    'dist/../file',
    'dist/\u0000file',
  ])('rejects unsafe or unassessed entry %j', (entry) => {
    expect(classifyPackageFilesEntry(entry)).toMatchObject({
      entry,
      kind: 'invalid',
      reason: expect.any(String),
    });
  });
});

describe('semantic artifact requirements', () => {
  it('accepts a complete tiny fixture while retaining its limited evidence scope', () => {
    const result = validatePackageArtifact(fixture(), policy);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.requirements).toHaveLength(7);
    expect(result.requirements.every((item) => item.satisfied)).toBe(true);
    expect(result.unpackedBytes).toBe(payload.length * 7);
    expect(result.inventory.source).toBe('fixture');
    expect(result.runtime).toBe('not-assessed');
    expect(result.hashComparison).toBe('not-requested');
    expect(result.limitations.join(' ')).toContain('does not read or authenticate tarball bytes');
    expect(result.limitations.join(' ')).toContain(
      'native/dynamic runtime behavior are not assessed',
    );
  });

  it('keeps all existing upper budgets without introducing presence floors', () => {
    expect(CLEO_ARTIFACT_BUDGETS).toEqual({
      packedBytes: 20 * 1024 * 1024,
      unpackedBytes: 36 * 1024 * 1024,
      fileCount: 800,
    });
  });

  it('rejects an empty package even though it has zero installation cost', () => {
    const result = validatePackageArtifact(fixture([]), policy);
    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'missing')).toHaveLength(7);
  });

  it.each(
    resources,
  )('rejects missing semantic resource %s independently of other resources', (path) => {
    const result = validatePackageArtifact(
      fixture(fixture().files.filter((file) => file.path !== path)),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing' }));
    expect(result.requirements.filter((item) => !item.satisfied)).toHaveLength(1);
  });

  it.each(resources)('rejects empty semantic resource %s', (path) => {
    const result = validatePackageArtifact(
      fixture(fixture().files.map((file) => (file.path === path ? { ...file, size: 0 } : file))),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'empty', subject: path }));
  });

  it('rejects padded missing content that meets both historical lower floors', () => {
    const files = fixture().files.filter((file) => file.path !== 'studio-dist/server/manifest.js');
    const padding = Array.from({ length: 600 }, (_, index) => ({
      path: `padding/${index}.dat`,
      size: 40_000,
    }));
    const result = validatePackageArtifact(fixture([...files, ...padding]), policy);
    expect(result.unpackedBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(result.inventory.files.length).toBeGreaterThan(600);
    expect(result.issues.filter((issue) => issue.code === 'budget')).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing', subject: 'studio-manifest' }),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects source maps actually selected by the packer, without treating exclusions as paths', () => {
    const result = validatePackageArtifact(
      fixture([...fixture().files, { path: 'dist/cli/index.js.map', size: 1 }]),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.filesEntries[2]?.kind).toBe('exclusion');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'forbidden', subject: 'dist/cli/index.js.map' }),
    );
  });

  it('does not infer npm selection from classified manifest patterns', () => {
    const result = validatePackageArtifact(fixture(), {
      ...policy,
      filesEntries: ['dist/**/*.js', '!studio-dist/server/manifest.js'],
    });
    expect(result.valid).toBe(true);
    expect(result.filesEntries.map((entry) => entry.kind)).toEqual(['glob', 'exclusion']);
    expect(result.limitations[0]).toContain('supplied packer inventory is the content authority');
  });
});

describe('inventory diagnostics and expected evidence', () => {
  it.each([
    '../escape.js',
    '/escape.js',
    'C:/escape.js',
    'dist\\cli.js',
    'dist//cli.js',
    './dist/cli.js',
  ])('rejects unsafe inventory path %s', (path) => {
    const result = validatePackageArtifact(
      fixture([...fixture().files, { path, size: 1 }]),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-inventory', subject: path }),
    );
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid byte accounting %s', (size) => {
    const result = validatePackageArtifact(
      fixture([...fixture().files, { path: 'extra', size }]),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.unpackedBytes).toBeNull();
  });

  it('rejects duplicate paths instead of silently selecting one hash', () => {
    const result = validatePackageArtifact(
      fixture([...fixture().files, { path: resources[0]!, size: 1 }]),
      policy,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-inventory', message: 'Duplicate inventory path.' }),
    );
  });

  it('compares independently expected hashes and records the evidence without claiming byte authentication', () => {
    const inventory = fixture();
    const result = validatePackageArtifact(inventory, {
      ...policy,
      expectedFiles: resources.map((path) => ({ path, size: payload.length, sha256: hash })),
    });
    expect(result.valid).toBe(true);
    expect(result.hashComparison).toBe('matched');
    expect(result.inventory).toEqual(inventory);
    expect(result.inventory).not.toBe(inventory);
    expect(result.inventory.files[0]).not.toBe(inventory.files[0]);
    expect(result.runtime).toBe('not-assessed');
  });

  it('rejects tampering and absent hashes against independent expected evidence', () => {
    const expectedFiles = [
      { path: 'dist/cli/index.js', size: payload.length, sha256: 'a'.repeat(64) },
    ];
    const result = validatePackageArtifact(fixture(), { ...policy, expectedFiles });
    expect(result.valid).toBe(false);
    expect(result.hashComparison).toBe('failed');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'mismatch', subject: 'dist/cli/index.js' }),
    );
    const noHashes = fixture(fixture().files.map(({ path, size }) => ({ path, size })));
    expect(validatePackageArtifact(noHashes, { ...policy, expectedFiles }).hashComparison).toBe(
      'failed',
    );
  });

  it('rejects an omitted auxiliary chunk against a full expected inventory', () => {
    const result = validatePackageArtifact(fixture(), {
      ...policy,
      expectedFiles: [{ path: 'studio-dist/server/chunks/required.js', size: 10, sha256: hash }],
    });
    expect(result.valid).toBe(false);
    expect(result.hashComparison).toBe('failed');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing',
        subject: 'studio-dist/server/chunks/required.js',
      }),
    );
  });

  it('rejects malformed hash provenance and impossible preview tarball evidence', () => {
    expect(validatePackageArtifact({ ...fixture(), tarballSha256: 'invalid' }, policy).valid).toBe(
      false,
    );
    expect(
      validatePackageArtifact(
        { ...fixture(), source: 'npm-pack-dry-run', tarballSha256: hash },
        policy,
      ).valid,
    ).toBe(false);
    expect(
      validatePackageArtifact(
        fixture([...fixture().files, { path: 'extra', size: 1, sha256: 'invalid' }]),
        policy,
      ).valid,
    ).toBe(false);
  });

  it('rejects an empty or malformed policy instead of declaring vacuous success', () => {
    expect(validatePackageArtifact(fixture(), { ...policy, requirements: [] }).valid).toBe(false);
    expect(
      validatePackageArtifact(fixture(), {
        ...policy,
        budgets: { ...policy.budgets, packedBytes: -1 },
      }).valid,
    ).toBe(false);
    expect(
      validatePackageArtifact(fixture(), {
        ...policy,
        requirements: [{ id: 'invalid', path: '../escape', match: 'exact' }],
      }).valid,
    ).toBe(false);
    expect(validatePackageArtifact(fixture(), { ...policy, filesEntries: ['!'] }).valid).toBe(
      false,
    );
  });

  it('retains each upper budget independently', () => {
    const packed = validatePackageArtifact(
      { ...fixture(), packedBytes: 20 * 1024 * 1024 + 1 },
      policy,
    );
    expect(packed.issues).toContainEqual(
      expect.objectContaining({ code: 'budget', subject: 'packedBytes' }),
    );
    const unpacked = validatePackageArtifact(
      fixture([...fixture().files, { path: 'large', size: 36 * 1024 * 1024 }]),
      policy,
    );
    expect(unpacked.issues).toContainEqual(
      expect.objectContaining({ code: 'budget', subject: 'unpackedBytes' }),
    );
    const count = validatePackageArtifact(
      fixture([
        ...fixture().files,
        ...Array.from({ length: 800 }, (_, index) => ({ path: `extra/${index}`, size: 1 })),
      ]),
      policy,
    );
    expect(count.issues).toContainEqual(
      expect.objectContaining({ code: 'budget', subject: 'fileCount' }),
    );
  });
});

describe('independent real npm-packed fixtures', () => {
  it('accepts a tiny complete tarball with extracted-file and archive hashes', () => {
    const inventory = packFixture(['dist', 'studio-dist']);
    expect(inventory.packedBytes).toBeLessThan(10_000);
    expect(inventory.tarballSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256 ?? ''))).toBe(true);
    const result = validatePackageArtifact(inventory, policy);
    expect(result.valid).toBe(true);
    expect(result.inventory.source).toBe('npm-pack');
    expect(result.runtime).toBe('not-assessed');
  });

  it('rejects a required file actually excluded by npm despite its presence in staging', () => {
    const inventory = packFixture(['dist', 'studio-dist', '!studio-dist/server/manifest.js']);
    expect(inventory.files.some((file) => file.path === 'studio-dist/server/manifest.js')).toBe(
      false,
    );
    const result = validatePackageArtifact(inventory, policy);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'missing', subject: 'studio-manifest' }),
    );
  });
});

describe('published CLI build shape', () => {
  it('accepts the declared CLI bundle and Studio resources', () => {
    expect(assertCleoShippedBuildShape(fixture().files)).toEqual([]);
  });
  it.each([
    'dist/cli/index.d.ts',
    'dist/cli/index.d.ts.map',
    'dist/extra.js',
    'dist/nested/index.js',
  ])('rejects development output %s', (path) => {
    expect(assertCleoShippedBuildShape([...fixture().files, { path, size: 1 }])).not.toEqual([]);
  });
});
