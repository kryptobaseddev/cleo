/**
 * Grammar outcomes and the toolchain-free container wrapper of the packed-install
 * smoke (T14665), kept free of build outputs so they test without a build.
 */

/**
 * One sample per supported grammar: language, file name, grammar package,
 * source and the symbol `cleo code outline` must report (T14637, T14665).
 */
export const GRAMMAR_SAMPLES = Object.freeze([
  [
    'typescript',
    'sample.ts',
    'tree-sitter-typescript',
    'export function packedSmokeGreet(name: string): string {\n  return name;\n}\n',
    'packedSmokeGreet',
  ],
  [
    'tsx',
    'sample.tsx',
    'tree-sitter-typescript',
    'export function packedSmokeView(): number {\n  return 1;\n}\n',
    'packedSmokeView',
  ],
  [
    'javascript',
    'sample.js',
    'tree-sitter-javascript',
    'function packedSmokeGreet(name) {\n  return name;\n}\n',
    'packedSmokeGreet',
  ],
  [
    'python',
    'sample.py',
    'tree-sitter-python',
    'def packed_smoke_greet(name):\n    return name\n',
    'packed_smoke_greet',
  ],
  [
    'go',
    'sample.go',
    'tree-sitter-go',
    'package main\n\nfunc packedSmokeGreet(name string) string {\n\treturn name\n}\n',
    'packedSmokeGreet',
  ],
  [
    'rust',
    'sample.rs',
    'tree-sitter-rust',
    'fn packed_smoke_greet(name: &str) -> &str {\n    name\n}\n',
    'packed_smoke_greet',
  ],
  [
    'java',
    'Sample.java',
    'tree-sitter-java',
    'class PackedSmoke {\n  String packedSmokeGreet(String name) {\n    return name;\n  }\n}\n',
    'packedSmokeGreet',
  ],
  [
    'c',
    'sample.c',
    'tree-sitter-c',
    'int packed_smoke_greet(int name) {\n  return name;\n}\n',
    'packed_smoke_greet',
  ],
  [
    'cpp',
    'sample.cpp',
    'tree-sitter-cpp',
    'int packed_smoke_greet(int name) {\n  return name;\n}\n',
    'packed_smoke_greet',
  ],
  [
    'ruby',
    'sample.rb',
    'tree-sitter-ruby',
    'def packed_smoke_greet(name)\n  name\nend\n',
    'packed_smoke_greet',
  ],
]);

/** Executables whose presence means a native addon could build from source (T14665). */
export const TOOLCHAIN_EXECUTABLES = Object.freeze([
  'cc',
  'gcc',
  'g++',
  'c++',
  'clang',
  'make',
  'python3',
  'python',
]);

/**
 * Judge one grammar's `cleo code outline` (T14665).
 * @param {readonly string[]} sample - A {@link GRAMMAR_SAMPLES} row.
 * @param {{ok: boolean, output: string}} run - Whether the command succeeded, and its stdout and stderr.
 * @param {{installed: boolean, toolchainFree: boolean}} context - Whether the install kept the grammar package, and whether this is the toolchain-free run.
 * @returns {'parsed' | 'reported-missing'} The outcome; anything else throws.
 */
export function judgeGrammarOutline(sample, run, { installed, toolchainFree }) {
  const [language, , pkg, , symbol] = sample;
  if (run.ok) {
    if (!run.output.includes(symbol))
      throw new Error(`cleo code outline (${language}) did not report ${symbol}: ${run.output}`);
    return 'parsed';
  }
  if (!toolchainFree || installed)
    throw new Error(
      `cleo code outline (${language}) failed although ${pkg} is installed: ${run.output}`,
    );
  if (
    !run.output.includes(`Grammar ${pkg} (${language}) did not load`) ||
    !run.output.includes('npm install -g @cleocode/cleo')
  )
    throw new Error(
      `cleo code outline (${language}) failed without naming ${pkg} and its fix: ${run.output}`,
    );
  return 'reported-missing';
}

/**
 * Wrap a command so it runs inside a container image, with `mount` bind-mounted
 * at the same path and every variable but PATH passed through (T14665).
 * @param {string} image - Container image.
 * @param {string} command - Executable inside the image; the host Node binary maps to `node`.
 * @param {string[]} args - Literal argument vector.
 * @param {{cwd: string, env: NodeJS.ProcessEnv, mount: string}} options - Working directory and environment inside the container, and the host directory it may see.
 * @returns {string[]} `docker` argument vector.
 */
export function containerCommand(image, command, args, { cwd, env, mount }) {
  const user =
    typeof process.getuid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];
  const variables = Object.entries(env)
    .filter(([key, value]) => key !== 'PATH' && value !== undefined)
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return [
    'run',
    '--rm',
    ...user,
    '-v',
    `${mount}:${mount}`,
    '-w',
    cwd,
    ...variables,
    image,
    command === process.execPath ? 'node' : command,
    ...args,
  ];
}

/**
 * Grammar packages with no linux-arm64 prebuild, so a toolchain-free arm64
 * install must drop at least one of them (T14637, T14665).
 */
export const SOURCE_BUILT_GRAMMARS = Object.freeze([
  'tree-sitter-cpp',
  'tree-sitter-java',
  'tree-sitter-ruby',
  'tree-sitter-typescript',
]);

/**
 * Prove the toolchain-free run tested something: at least one source-built
 * grammar was dropped, and every dropped grammar was reported missing (T14665).
 * @param {Record<string, boolean>} optionalNative - Whether the install kept each optional native package.
 * @param {Record<string, string>} grammars - {@link judgeGrammarOutline} outcome per language.
 * @returns {string[]} The dropped grammar packages.
 */
export function assertDroppedGrammarsReported(optionalNative, grammars) {
  const dropped = [...new Set(GRAMMAR_SAMPLES.map(([, , pkg]) => pkg))].filter(
    (pkg) => optionalNative[pkg] === false,
  );
  if (!dropped.some((pkg) => SOURCE_BUILT_GRAMMARS.includes(pkg)))
    throw new Error(
      `The toolchain-free install kept every source-built grammar (${SOURCE_BUILT_GRAMMARS.join(', ')}), ` +
        'so it could not show a missing grammar being reported',
    );
  for (const [language, , pkg] of GRAMMAR_SAMPLES) {
    if (dropped.includes(pkg) && grammars[language] !== 'reported-missing')
      throw new Error(`${pkg} was dropped but cleo code outline (${language}) did not report it`);
  }
  return dropped;
}
