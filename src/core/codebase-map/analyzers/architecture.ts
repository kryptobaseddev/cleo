/**
 * Architecture analyzer — detects layers, entry points, and architectural patterns.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../../../store/project-detect.js';
import type { ArchAnalysis } from '../index.js';

const LAYER_PURPOSE: Record<string, string> = {
  core: 'Core business logic',
  domain: 'Domain models and logic',
  api: 'API layer',
  routes: 'HTTP route handlers',
  controllers: 'Request controllers',
  services: 'Service layer',
  repositories: 'Data access layer',
  models: 'Data models',
  store: 'State management / data store',
  middleware: 'Middleware layer',
  utils: 'Utility functions',
  helpers: 'Helper functions',
  lib: 'Library code',
  shared: 'Shared modules',
  common: 'Common utilities',
  components: 'UI components',
  pages: 'Page components',
  views: 'View layer',
  hooks: 'React hooks',
  composables: 'Vue composables',
  cli: 'CLI interface',
  mcp: 'MCP server layer',
  dispatch: 'Dispatch / routing layer',
  types: 'Type definitions',
  schemas: 'Schema definitions',
  validation: 'Validation logic',
  config: 'Configuration',
  adapters: 'External adapters',
  providers: 'Service providers',
  plugins: 'Plugin system',
  migrations: 'Database migrations',
  fixtures: 'Test fixtures',
};

const ENTRY_POINT_NAMES = new Set([
  'index.ts', 'index.js', 'index.mts', 'index.mjs',
  'main.ts', 'main.js',
  'app.ts', 'app.js',
  'server.ts', 'server.js',
  'cli.ts', 'cli.js',
  'worker.ts', 'worker.js',
]);

const ARCH_PATTERNS: Record<string, string[]> = {
  layered: ['core', 'services', 'repositories', 'controllers'],
  mvc: ['models', 'views', 'controllers'],
  modular: ['modules'],
  'clean-architecture': ['domain', 'application', 'infrastructure'],
  'dispatch-first': ['dispatch', 'core', 'mcp', 'cli'],
  'component-based': ['components', 'pages'],
};

export function analyzeArchitecture(projectRoot: string, _projectContext: ProjectContext): ArchAnalysis {
  const layers: ArchAnalysis['layers'] = [];
  const entryPoints: ArchAnalysis['entryPoints'] = [];
  const patterns: string[] = [];

  // Scan src/ directory for layers
  const srcPath = join(projectRoot, 'src');
  if (existsSync(srcPath)) {
    try {
      const entries = readdirSync(srcPath);
      for (const entry of entries) {
        const entryPath = join(srcPath, entry);
        try {
          const stat = statSync(entryPath);
          if (stat.isDirectory()) {
            const purpose = LAYER_PURPOSE[entry.toLowerCase()] ?? `${entry} layer`;
            layers.push({ name: entry, path: `src/${entry}`, purpose });
          } else if (ENTRY_POINT_NAMES.has(entry)) {
            entryPoints.push({ path: `src/${entry}`, type: inferEntryType(entry) });
          }
        } catch {
          // ignore stat errors
        }
      }
    } catch {
      // ignore readdir errors
    }
  }

  // Also scan root for entry points
  const rootEntries = safeReaddir(projectRoot);
  for (const entry of rootEntries) {
    if (ENTRY_POINT_NAMES.has(entry) && !entryPoints.some((ep) => ep.path === entry)) {
      entryPoints.push({ path: entry, type: inferEntryType(entry) });
    }
  }

  // Detect architectural patterns from layer names
  const layerNames = new Set(layers.map((l) => l.name.toLowerCase()));
  for (const [pattern, requiredDirs] of Object.entries(ARCH_PATTERNS)) {
    const matchCount = requiredDirs.filter((d) => layerNames.has(d)).length;
    if (matchCount >= 2) {
      patterns.push(pattern);
    }
  }

  return { layers, entryPoints, patterns };
}

function inferEntryType(filename: string): string {
  if (filename.startsWith('cli')) return 'cli';
  if (filename.startsWith('server')) return 'server';
  if (filename.startsWith('worker')) return 'worker';
  if (filename.startsWith('app')) return 'application';
  return 'module';
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
