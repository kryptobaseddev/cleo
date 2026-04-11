/**
 * CLI commands for Smart Explore code analysis.
 *
 * cleo code outline <file>
 * cleo code search <query> [--lang] [--max] [--path]
 * cleo code unfold <file> <symbol>
 *
 * @task T154
 */

import { defineCommand } from 'citty';

/** Check tree-sitter availability before running code analysis. Exits with clear message if missing. */
async function requireTreeSitter(): Promise<void> {
  const { isTreeSitterAvailable } = await import('@cleocode/core/internal');
  if (!isTreeSitterAvailable()) {
    console.error(
      'Error: tree-sitter native module not available.\n\n' +
        'This usually means the native addon failed to build during install.\n' +
        'Fix: pnpm install (or npm install -g @cleocode/cleo)\n\n' +
        'tree-sitter and grammar packages are bundled dependencies that should\n' +
        'install automatically. If this persists, run: cleo doctor',
    );
    process.exit(7); // exit code 7 = service unavailable
  }
}

export const codeCommand = defineCommand({
  meta: { name: 'code', description: 'Code analysis via tree-sitter AST' },
  subCommands: {
    outline: defineCommand({
      meta: { name: 'outline', description: 'Show file structural skeleton (signatures only)' },
      args: {
        file: { type: 'positional', description: 'Source file path', required: true },
      },
      async run({ args }) {
        await requireTreeSitter();
        const { smartOutline } = await import('@cleocode/core/internal');
        const { join } = await import('node:path');
        const root = process.cwd();
        const absPath = args.file.startsWith('/') ? args.file : join(root, args.file);
        const result = smartOutline(absPath, root);

        if (result.errors.length > 0 && result.symbols.length === 0) {
          console.error(`Error: ${result.errors.join(', ')}`);
          process.exit(1);
        }

        console.log(`${result.filePath} (${result.language}, ~${result.estimatedTokens} tokens)\n`);
        for (const sym of result.symbols) {
          const prefix = sym.exported ? 'export ' : '';
          console.log(`${prefix}${sym.kind} ${sym.name} [${sym.startLine}-${sym.endLine}]`);
          if (sym.children.length > 0) {
            for (const child of sym.children) {
              console.log(`  ${child.kind} ${child.name} [${child.startLine}-${child.endLine}]`);
            }
          }
        }
      },
    }),

    search: defineCommand({
      meta: { name: 'search', description: 'Search for symbols across codebase' },
      args: {
        query: { type: 'positional', description: 'Search query', required: true },
        lang: { type: 'string', description: 'Filter by language (e.g. typescript, python)' },
        max: { type: 'string', description: 'Max results (default: 20)' },
        path: { type: 'string', description: 'File pattern filter (e.g. src/**)' },
      },
      async run({ args }) {
        await requireTreeSitter();
        type SmartSearchOptions = import('@cleocode/core/internal').SmartSearchOptions;
        const { smartSearch } = await import('@cleocode/core/internal');
        const root = process.cwd();
        const opts: SmartSearchOptions = {
          rootDir: root,
          maxResults: args.max ? Number.parseInt(args.max, 10) : 20,
          filePattern: args.path,
        };
        if (args.lang) {
          opts.language = args.lang as SmartSearchOptions['language'];
        }
        const results = smartSearch(args.query, opts);

        if (results.length === 0) {
          console.log(`No symbols found matching "${args.query}"`);
          return;
        }

        console.log(`Found ${results.length} symbols:\n`);
        for (const r of results) {
          console.log(
            `  ${r.symbol.kind.padEnd(12)} ${r.symbol.name.padEnd(30)} ${r.symbol.filePath}:${r.symbol.startLine} (${r.matchType}, score: ${r.score})`,
          );
        }
      },
    }),

    unfold: defineCommand({
      meta: { name: 'unfold', description: 'Extract complete symbol source' },
      args: {
        file: { type: 'positional', description: 'Source file path', required: true },
        symbol: {
          type: 'positional',
          description: 'Symbol name (e.g. parseFile or Class.method)',
          required: true,
        },
      },
      async run({ args }) {
        await requireTreeSitter();
        const { smartUnfold } = await import('@cleocode/core/internal');
        const { join } = await import('node:path');
        const root = process.cwd();
        const absPath = args.file.startsWith('/') ? args.file : join(root, args.file);
        const result = smartUnfold(absPath, args.symbol, root);

        if (!result.found) {
          console.error(`Symbol "${args.symbol}" not found in ${args.file}`);
          if (result.errors.length > 0) console.error(result.errors.join(', '));
          process.exit(1);
        }

        console.log(
          `// ${result.filePath}:${result.startLine}-${result.endLine} (~${result.estimatedTokens} tokens)\n`,
        );
        console.log(result.source);
      },
    }),
  },
});
